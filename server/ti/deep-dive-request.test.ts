import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapCanonicalCgDeepDiveDispatchToTi,
  type ContractLimits,
} from './contracts';
import { DeepDiveRequestError, DeepDiveRequestService } from './deep-dive-request';
import { PersistenceIdempotencyConflictError, type GenerationRequestInput, type GenerationRequestResult, type TiPersistence } from './persistence';
import { canonicalPost, cgDeepDiveDispatch, deepDiveRequest } from './fixtures/canonical-cg';

const limits: ContractLimits = {
  maxStringCodePoints: 8_192,
  maxArrayItems: 64,
  maxPayloadBytes: 65_536,
  maxContextItems: 8,
  maxContextBytes: 16_384,
};
const fixedNow = new Date('2026-11-26T11:00:00.000Z');

function memoryPersistence(): {
  persistence: TiPersistence;
  records: GenerationRequestInput[];
  calls: number;
} {
  const records: GenerationRequestInput[] = [];
  const byKey = new Map<string, GenerationRequestInput & { requestId: string }>();
  let calls = 0;
  const persistence = {
    async createOrGetGenerationRequest(input: GenerationRequestInput): Promise<GenerationRequestResult> {
      calls += 1;
      records.push(input);
      const key = `${input.operationKind}\u0000${input.idempotencyKey}`;
      const prior = byKey.get(key);
      if (prior) {
        if (prior.inputHash !== input.inputHash) throw new PersistenceIdempotencyConflictError();
        return { requestId: prior.requestId, created: false };
      }
      const requestId = `synthetic-request-${byKey.size + 1}`;
      byKey.set(key, { ...input, requestId });
      return { requestId, created: true };
    },
  } as unknown as TiPersistence;
  return { persistence, records, get calls() { return calls; } };
}

function service(
  persistence: TiPersistence,
  authenticate: (credential: unknown) => Promise<{ quotaSubject: string; scopes: readonly string[] } | null> = async () => ({
    quotaSubject: 'synthetic-restricted-quota-subject',
    scopes: ['deep_dive:create'],
  }),
  contractLimits: ContractLimits = limits,
) {
  return new DeepDiveRequestService(persistence, {
    contractLimits,
    supportedLanguages: ['en', 'fr'],
    waitHorizonMs: 30_000,
    retentionClass: 'synthetic-test-retention',
  }, { authenticate, now: () => new Date(fixedNow) });
}

test('Deep Dive accepts only authenticated, strictly validated, bounded requests and persists metadata only', async () => {
  const memory = memoryPersistence();
  let authCalls = 0;
  const requests = service(memory.persistence, async (credential) => {
    authCalls += 1;
    assert.equal(credential, 'synthetic-service-credential');
    return { quotaSubject: 'synthetic-restricted-quota-subject', scopes: ['deep_dive:create'] };
  });
  const accepted = await requests.accept('synthetic-service-credential', deepDiveRequest);
  assert.deepEqual(accepted, {
    requestId: 'synthetic-request-1',
    created: true,
    state: 'accepted',
    inputSchemaVersion: 1,
  });
  assert.equal(authCalls, 1);
  assert.equal(memory.calls, 1);
  const persisted = memory.records[0];
  assert.equal(persisted.operationKind, 'deep_dive');
  assert.equal(persisted.idempotencyKey, deepDiveRequest.userMessageId);
  assert.match(persisted.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(persisted.state, 'accepted');
  assert.equal(persisted.attemptCount, 0);
  assert.equal(persisted.correlationId, deepDiveRequest.requestRef);
  assert.equal(persisted.waitExpiresAt.getTime(), fixedNow.getTime() + 30_000);
  assert.equal(persisted.quotaSubject, 'synthetic-restricted-quota-subject');
  const persistedJson = JSON.stringify(persisted);
  assert.equal(persistedJson.includes(deepDiveRequest.currentMessage), false, 'raw message text is not persisted in request metadata');
  assert.equal(persistedJson.includes(JSON.stringify(deepDiveRequest.quoteSnapshot)), false, 'quote content is not persisted in request metadata');
  assert.equal(persistedJson.includes('fullThread'), false);

  const denied = service(memory.persistence, async () => null);
  await assert.rejects(denied.accept('invalid-credential', deepDiveRequest), (error: unknown) =>
    error instanceof DeepDiveRequestError && error.code === 'unauthorized' && error.message === 'Deep Dive request failed (unauthorized)',
  );
  const wrongScope = service(memory.persistence, async () => ({
    quotaSubject: 'synthetic-restricted-quota-subject', scopes: ['deep_dive:read'],
  }));
  await assert.rejects(wrongScope.accept('wrong-scope', deepDiveRequest), (error: unknown) =>
    error instanceof DeepDiveRequestError && error.code === 'unauthorized',
  );
  assert.equal(memory.calls, 1, 'unauthorized calls do not create or inspect durable operations');
});

test('equivalent retries join one operation and conflicting userMessageId reuse fails without leaking content', async () => {
  const memory = memoryPersistence();
  const requests = service(memory.persistence);
  const [first, second] = await Promise.all([
    requests.accept('synthetic-credential', deepDiveRequest),
    requests.accept('synthetic-credential', deepDiveRequest),
  ]);
  assert.equal(first.requestId, second.requestId);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  assert.equal(memory.calls, 2);
  assert.equal(memory.records[0].inputHash, memory.records[1].inputHash);

  const conflicting = {
    ...deepDiveRequest,
    currentMessage: 'A different synthetic message using the same message ID.',
  };
  await assert.rejects(requests.accept('synthetic-credential', conflicting), (error: unknown) =>
    error instanceof DeepDiveRequestError
      && error.code === 'idempotency_conflict'
      && error.message === 'Deep Dive request failed (idempotency_conflict)'
      && !error.message.includes(conflicting.currentMessage),
  );
});

test('unknown fields, full-thread payloads, oversized contexts, malformed snapshots and unsupported versions fail before persistence', async () => {
  const memory = memoryPersistence();
  const requests = service(memory.persistence);
  const failures: Array<[unknown, string]> = [
    [{ ...deepDiveRequest, fullThread: ['synthetic forbidden thread'] }, 'unknown fields'],
    [{ ...deepDiveRequest, schemaVersion: 99 }, 'unsupported versions'],
    [{ ...deepDiveRequest, quoteSnapshots: [{}, {}] }, 'quote list expansion'],
    [{ ...deepDiveRequest, currentMessage: 'x'.repeat(8_193) }, 'message code-point overflow'],
    [{ ...deepDiveRequest, recentContext: Array(9).fill(deepDiveRequest.recentContext[0]) }, 'context count overflow'],
    [{ ...deepDiveRequest, recentContext: Array(2).fill({ messageId: 'synthetic', role: 'system', content: 'forbidden role' }) }, 'unsupported context role'],
    [{ ...deepDiveRequest, quoteSnapshot: { ...deepDiveRequest.quoteSnapshot, type: 'external_article' } }, 'unsupported quote type'],
  ];
  for (const [candidate, label] of failures) {
    await assert.rejects(requests.accept('synthetic-credential', candidate), (error: unknown) =>
      error instanceof DeepDiveRequestError && error.code === 'invalid_request', label,
    );
  }
  const sparse = { ...deepDiveRequest, recentContext: new Array(2) };
  await assert.rejects(requests.accept('synthetic-credential', sparse), (error: unknown) =>
    error instanceof DeepDiveRequestError && error.code === 'invalid_request',
  );
  const contextByteLimited = service(memory.persistence, undefined, { ...limits, maxContextBytes: 8 });
  await assert.rejects(contextByteLimited.accept('synthetic-credential', deepDiveRequest), (error: unknown) =>
    error instanceof DeepDiveRequestError && error.code === 'invalid_request',
  );
  const getter = Object.defineProperty({ ...deepDiveRequest }, 'currentMessage', {
    enumerable: true,
    get() { throw new Error('raw getter secret'); },
  });
  await assert.rejects(requests.accept('synthetic-credential', getter), (error: unknown) =>
    error instanceof DeepDiveRequestError && error.code === 'invalid_request' && !error.message.includes('raw getter secret'),
  );
  assert.equal(memory.calls, 0, 'invalid requests never create a generation request');
});

test('normalized CG v2 dispatch is revalidated and hashed as v2 without storing quote or message content', async () => {
  const memory = memoryPersistence();
  const requests = service(memory.persistence);
  const mapped = mapCanonicalCgDeepDiveDispatchToTi(cgDeepDiveDispatch, canonicalPost, limits, ['en', 'fr']);
  const accepted = await requests.accept('synthetic-credential', mapped);
  assert.equal(accepted.inputSchemaVersion, 2);
  assert.equal(accepted.created, true);
  const reorderedSafetyFields = {
    ...mapped,
    responseConstraints: {
      ...mapped.responseConstraints,
      safetyRequirements: Object.fromEntries(Object.entries(mapped.responseConstraints.safetyRequirements).reverse()),
    },
  };
  const equivalent = await requests.accept('synthetic-credential', reorderedSafetyFields);
  assert.equal(equivalent.requestId, accepted.requestId);
  assert.equal(equivalent.created, false, 'nested JSON property order does not split an equivalent retry');
  assert.equal(memory.records[0].inputHash, memory.records[1].inputHash);
  assert.equal(memory.records[0].idempotencyKey, cgDeepDiveDispatch.userMessageId);
  assert.equal(memory.records[0].correlationId, mapped.requestRef);
  const persistedJson = JSON.stringify(memory.records[0]);
  assert.equal(persistedJson.includes(mapped.currentMessage), false);
  assert.equal(persistedJson.includes('Synthetic quoted post'), false);
  assert.equal(persistedJson.includes('Synthetic intelligence insight.'), false);
});

test('service policy is explicit, immutable, and persistence failures are normalized', async () => {
  const memory = memoryPersistence();
  let clockCalls = 0;
  const invalidClockService = new DeepDiveRequestService(memory.persistence, {
    contractLimits: limits,
    supportedLanguages: ['en', 'fr'],
    waitHorizonMs: 30_000,
    retentionClass: 'synthetic-test-retention',
  }, { authenticate: async () => ({ quotaSubject: 'synthetic-subject', scopes: ['deep_dive:create'] }), now: () => {
    clockCalls += 1;
    return new Date(Number.NaN);
  } });
  await assert.rejects(invalidClockService.accept('synthetic-credential', deepDiveRequest), (error: unknown) =>
    error instanceof DeepDiveRequestError && error.code === 'unavailable',
  );
  assert.equal(clockCalls, 1);
  assert.equal(memory.calls, 0);

  const brokenPersistence = {
    async createOrGetGenerationRequest() { throw new Error('postgres secret details'); },
  } as unknown as TiPersistence;
  await assert.rejects(service(brokenPersistence).accept('synthetic-credential', deepDiveRequest), (error: unknown) =>
    error instanceof DeepDiveRequestError && error.code === 'unavailable'
      && !error.message.includes('postgres secret details'),
  );
});
