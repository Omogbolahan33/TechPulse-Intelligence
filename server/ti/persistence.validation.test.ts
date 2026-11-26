import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  TiPersistence,
  type ArtifactInput,
  type EvidenceInput,
  type PersistencePolicy,
} from './persistence';

const baseTime = new Date('2026-01-01T00:00:00.000Z');
const policy = (overrides: Partial<PersistencePolicy> = {}): PersistencePolicy => ({
  runtimeMode: 'test',
  maxWaitHorizonMs: 10_000,
  maxRetentionAgeMsByClass: { short: 1_000, indefinite: null },
  ...overrides,
});

function fakePool(options: {
  query?: (sql: string, parameters?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  clientQuery?: (sql: string, parameters?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
} = {}): { pool: Pool; calls: string[]; releases: number } {
  const calls: string[] = [];
  let releases = 0;
  const query = async (sql: string, parameters?: unknown[]) => {
    calls.push(sql);
    return options.query?.(sql, parameters) ?? { rows: [], rowCount: 0 };
  };
  const client = {
    query: async (sql: string, parameters?: unknown[]) => {
      calls.push(sql);
      return options.clientQuery?.(sql, parameters) ?? { rows: [], rowCount: 0 };
    },
    release: () => { releases += 1; },
  };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    calls,
    get releases() { return releases; },
  };
}

const artifact = (overrides: Partial<ArtifactInput> = {}): ArtifactInput => ({
  artifactKey: 'synthetic-validation-artifact',
  artifactType: 'summary',
  postId: 'synthetic-validation-post',
  postContentVersion: 'synthetic-version-01',
  outputLanguage: 'en',
  payload: { summary: 'Synthetic content only.' },
  groundingMode: 'cg_only',
  citations: [],
  limitations: [],
  schemaVersion: 1,
  promptVersion: 'synthetic-prompt-v1',
  moderationState: 'approved',
  status: 'ready',
  retentionClass: 'short',
  ...overrides,
});

const evidence = (overrides: Partial<EvidenceInput> = {}): EvidenceInput => ({
  artifactKey: 'synthetic-validation-artifact',
  artifactVersion: 1,
  postId: 'synthetic-validation-post',
  postContentVersion: 'synthetic-version-01',
  groundingMode: 'cg_only',
  sourceSnapshots: [],
  evidencePayload: { rationale: 'Synthetic evidence.' },
  schemaVersion: 1,
  retentionClass: 'short',
  ...overrides,
});

function row(createdAt: Date) {
  return {
    artifact_key: 'synthetic-validation-artifact',
    version: 1,
    artifact_type: 'summary',
    post_id: 'synthetic-validation-post',
    post_content_version: 'synthetic-version-01',
    content_hash: null,
    output_language: 'en',
    payload: { summary: 'Synthetic content only.' },
    grounding_mode: 'cg_only',
    citations: [],
    limitations: [],
    schema_version: 1,
    prompt_version: 'synthetic-prompt-v1',
    moderation_state: 'approved',
    status: 'ready',
    retention_class: 'short',
    is_current: true,
    created_at: createdAt,
  };
}

test('persistence rejects malformed values before acquiring a database connection', async () => {
  const fake = fakePool();
  const persistence = new TiPersistence(fake.pool, policy(), { now: () => new Date(baseTime) });

  await assert.rejects(persistence.publishArtifact(artifact({ artifactKey: '  ' })), /artifactKey must be a non-empty string/);
  await assert.rejects(persistence.publishArtifact(artifact({ artifactType: 'other' as never })), /artifactType is unsupported/);
  await assert.rejects(persistence.publishArtifact(artifact({ status: 'failed' as never })), /artifact status is unsupported/);
  await assert.rejects(persistence.publishArtifact(artifact({ moderationState: 'hidden' })), /hidden moderation state cannot be published as a ready artifact/);
  await assert.rejects(persistence.publishArtifact(artifact({ schemaVersion: 2_147_483_648 })), /positive PostgreSQL INTEGER/);
  await assert.rejects(persistence.publishArtifact(artifact({ createdAt: new Date(Number.NaN) })), /createdAt must be a valid Date/);
  await assert.rejects(persistence.publishArtifact(artifact({ retentionClass: 'unconfigured' })), /not present in the configured retention policy/);
  await assert.rejects(persistence.storeEvidence(evidence({ artifactVersion: 0 })), /artifactVersion must be a positive PostgreSQL INTEGER/);
  await assert.rejects(persistence.storeEvidence(evidence({ groundingMode: 'inferred' as never })), /groundingMode is unsupported/);
  await assert.rejects(persistence.storeEvidence(evidence({ sourceSnapshots: [{
    sourceId: 42,
    sourceType: 'publisher',
    sourceVersion: 'v1',
  } as never] })), /sourceSnapshots\[0\]\.sourceId must be a non-empty string/);
  await assert.rejects(persistence.storeEvidence(evidence({ sourceSnapshots: [{
    sourceId: 'synthetic-source',
    sourceType: 'publisher',
    sourceVersion: '',
    contentHash: '',
  }] })), /sourceVersion must be omitted or a non-empty string/);

  assert.deepEqual(fake.calls, [], 'input validation does not start a transaction or query PostgreSQL');
  assert.equal(fake.releases, 0);
});

test('evidence cannot be persisted unless an exact artifact-version snapshot matches', async () => {
  const fake = fakePool({ query: async () => ({ rows: [], rowCount: 0 }) });
  const persistence = new TiPersistence(fake.pool, policy(), { now: () => new Date(baseTime) });
  await assert.rejects(
    persistence.storeEvidence(evidence()),
    /does not match the exact persisted artifact version, post snapshot, and grounding mode/,
  );
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0], /FROM ti_artifacts AS artifact/);
  assert.match(fake.calls[0], /post_content_version IS NOT DISTINCT FROM/);
  assert.match(fake.calls[0], /grounding_mode = \$7/);
});

test('generation request wait bounds are checked before idempotency lookup or database access', async () => {
  const fake = fakePool();
  const persistence = new TiPersistence(fake.pool, policy({ maxWaitHorizonMs: 2_000 }), {
    now: () => new Date(baseTime),
  });
  const base = {
    idempotencyKey: 'synthetic-idempotency-key',
    operationKind: 'summary' as const,
    inputHash: 'synthetic-input-hash',
    state: 'accepted' as const,
    correlationId: 'synthetic-correlation',
    waitExpiresAt: new Date(baseTime.getTime() + 1_000),
    retentionClass: 'short',
    quotaSubject: 'synthetic-restricted-subject',
  };

  await assert.rejects(
    persistence.createOrGetGenerationRequest({ ...base, waitExpiresAt: new Date(Number.NaN) }),
    /waitExpiresAt must be a valid Date/,
  );
  await assert.rejects(
    persistence.createOrGetGenerationRequest({ ...base, waitExpiresAt: new Date(baseTime.getTime() + 2_001) }),
    /exceeds the configured 2000ms wait horizon/,
  );
  await assert.rejects(
    persistence.createOrGetGenerationRequest({ ...base, waitExpiresAt: new Date(baseTime.getTime()) }),
    /waitExpiresAt must be in the future/,
  );
  await assert.rejects(
    persistence.createOrGetGenerationRequest({ ...base, state: 'processing' }),
    /new generation requests must enter the accepted state/,
  );
  await assert.rejects(persistence.completeGenerationRequest({
    requestId: 'request', correlationId: 'correlation', inputHash: 'hash', callbackRef: 'ref', callbackId: 'event',
    claimToken: 'token', outcome: 'ready', resultHash: 'not-a-sha256',
  }), /resultHash must be a lowercase SHA-256 digest/);
  assert.deepEqual(fake.calls, [], 'invalid wait policy cannot bypass validation via an existing idempotency key');
});

test('current artifact reads include a hidden-moderation guard even for legacy or out-of-band rows', async () => {
  const fake = fakePool({ query: async () => ({ rows: [], rowCount: 0 }) });
  const persistence = new TiPersistence(fake.pool, policy(), { now: () => new Date(baseTime) });
  assert.equal(await persistence.getArtifact('synthetic-validation-artifact'), null);
  assert.match(fake.calls[0], /moderation_state <> 'hidden'/);
});

test('retention reads use the injected clock with an exclusive expiry boundary and an immutable policy snapshot', async () => {
  let clock = new Date(baseTime);
  const retentionAges: Record<string, number | null> = { short: 1_000, indefinite: null };
  const fake = fakePool({
    query: async () => ({ rows: [row(baseTime)], rowCount: 1 }),
  });
  const persistence = new TiPersistence(fake.pool, policy({ maxRetentionAgeMsByClass: retentionAges }), { now: () => new Date(clock) });
  retentionAges.short = 100;

  clock = new Date(baseTime.getTime() + 999);
  assert.equal((await persistence.getArtifact('synthetic-validation-artifact'))?.version, 1);
  clock = new Date(baseTime.getTime() + 1_000);
  assert.equal(await persistence.getArtifact('synthetic-validation-artifact'), null);
  assert.equal(fake.calls.length, 2);
});

test('persistence clock and worker state transitions fail closed', async () => {
  const invalidClock = new TiPersistence(fakePool().pool, policy(), { now: () => new Date(Number.NaN) });
  await assert.rejects(invalidClock.publishArtifact(artifact()), /persistence clock must return a valid Date/);

  const fake = fakePool();
  const persistence = new TiPersistence(fake.pool, policy(), { now: () => new Date(baseTime) });
  await assert.rejects(persistence.updateRequestState('synthetic-request', 'processing', 1), /processing and terminal states require atomic claim or completion operations/);
  await assert.rejects(persistence.claimNextGenerationRequest({ leaseDurationMs: 0, maxAttempts: 2 }), /leaseDurationMs must be an explicit positive safe integer/);
  await assert.rejects(persistence.claimNextGenerationRequest({ leaseDurationMs: 10_000, maxAttempts: 0 }), /maxAttempts must be a positive PostgreSQL INTEGER/);
  assert.equal(fake.calls.length, 0, 'invalid worker policies are rejected before database access');
  assert.equal(fake.releases, 0);
});
