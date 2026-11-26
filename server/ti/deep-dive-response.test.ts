import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceBundle, type EvidenceBundlePolicy, type EvidenceBundleV1 } from './evidence';
import {
  DeepDiveResponseError,
  DeepDiveResponseService,
  type DeepDiveCgHandoffV1,
  type DeepDiveResponsePolicy,
  type StoredDeepDiveHandoffV1,
} from './deep-dive-response';
import type { DeepDiveRequestInputV2, TiMappedCgQuoteV2 } from './contracts';
import type { QuoteResolutionResult } from './quote-resolver';

const limits = {
  maxStringCodePoints: 4_096,
  maxArrayItems: 32,
  maxPayloadBytes: 32_768,
  maxContextItems: 8,
  maxContextBytes: 8_192,
};
const evidenceBuilderPolicy: EvidenceBundlePolicy = {
  contractLimits: limits,
  supportedLanguages: ['en', 'fr'],
  eligibleModerationStates: ['visible'],
  eligiblePublicationStates: ['published'],
  maxSourceUrlBytes: 2_048,
  maxEvidenceItems: 12,
  maxTotalTextCodePoints: 8_192,
  maxSourceTextCodePoints: 8_192,
  maxCitationClaims: 16,
  maxCitationQuoteCodePoints: 2_048,
};
const basePolicy: DeepDiveResponsePolicy = {
  contractLimits: limits,
  supportedLanguages: ['en', 'fr'],
  eligibleModerationStates: ['visible'],
  eligiblePublicationStates: ['published'],
  evidencePolicy: {
    minimumEvidenceCodePoints: 10,
    insufficientEvidenceAction: 'partial',
    maxEvidenceItems: 12,
    maxEvidenceTextCodePoints: 8_192,
  },
  responseSchemaVersion: 'cg-deep-dive-v1',
  promptVersion: 'deep-dive-prompt-v1',
  maxClaims: 12,
  maxCitationQuoteCodePoints: 1_024,
  maxLimitations: 8,
  maxLimitationCodePoints: 512,
  quoteUnavailableByLanguage: { en: 'The exact quoted snapshot or its evidence is unavailable; no facts about it were generated.', fr: 'L’instantané cité exact ou ses preuves sont indisponibles ; aucun fait à son sujet n’a été généré.' },
  insufficientEvidenceByLanguage: { en: 'There is not enough verified evidence to answer this question.', fr: 'Les preuves vérifiées sont insuffisantes pour répondre à cette question.' },
  partialGroundingByLanguage: { en: 'This answer has limited grounding and may omit relevant details.', fr: 'Cette réponse repose sur des éléments limités et peut omettre des détails pertinents.' },
};
const canonicalPost = {
  schemaVersion: 1,
  postId: 'deep-dive-post-17',
  postContentVersion: 'post-v8',
  contentHash: 'post-hash-v8',
  title: 'Synthetic research title',
  content: 'The synthetic report states that the pilot began in 2025 and included 42 participants.',
  language: 'en',
  contentFormat: 'plain_text',
  categoryId: 2,
  subcategoryId: 'technology',
  topicIds: ['synthetic-topic'],
  moderationState: 'visible',
  publicationState: 'published',
};

function evidence(post = canonicalPost): EvidenceBundleV1 {
  return buildEvidenceBundle(post, {
    postStatus: 'eligible',
    canonicalPost: { postId: post.postId, version: { kind: 'postContentVersion', value: post.postContentVersion } },
    result: {
      retrievalStatus: 'failed', extractionStatus: 'not_attempted', groundingStatus: 'not_assessed',
      failureCode: 'source_not_linked', retrievedAt: '2026-11-26T10:00:00.000Z',
    },
  }, evidenceBuilderPolicy);
}

function request(overrides: Partial<DeepDiveRequestInputV2> = {}): DeepDiveRequestInputV2 {
  return {
    schemaVersion: 2,
    userMessageId: 'cg-message-88',
    requestRef: 'cg-request-ref-88',
    conversationRef: 'cg-conversation-ref-12',
    currentMessage: 'What did the pilot report say?',
    recentContext: [],
    responseConstraints: {
      schemaVersion: 2,
      responseSchemaVersion: 'cg-deep-dive-v1',
      postLanguage: 'en',
      safetyRequirements: { version: 'safe-v2' },
    },
    ...overrides,
  };
}

const claimText = 'The pilot began in 2025.';
const evidenceQuote = 'The synthetic report states that the pilot began in 2025';
function goodCandidate() {
  return {
    schemaVersion: 1,
    outputLanguage: 'en',
    claims: [{ text: claimText, citations: [{ evidenceId: evidence().evidence[0]!.evidenceId, quote: evidenceQuote }] }],
    limitations: [basePolicy.partialGroundingByLanguage.en],
  };
}

function createStore() {
  const records = new Map<string, StoredDeepDiveHandoffV1>();
  return {
    records,
    findByUserMessageId: async (userMessageId: string) => records.get(userMessageId) ?? null,
    createOrGet: async (inputHash: string, handoff: DeepDiveCgHandoffV1) => {
      const prior = records.get(handoff.userMessageId);
      if (prior) return { ...prior, created: false };
      const stored = { inputHash, handoff };
      records.set(handoff.userMessageId, stored);
      return { ...stored, created: true };
    },
  };
}

function createLease() {
  const tails = new Map<string, Promise<void>>();
  return async function run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    tails.set(key, tail);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

function service(options: {
  candidate?: unknown;
  policy?: DeepDiveResponsePolicy;
  safety?: boolean;
  language?: boolean;
} = {}) {
  const store = createStore();
  let generateCalls = 0;
  let lastProviderRequest: unknown;
  const responseService = new DeepDiveResponseService(options.policy ?? basePolicy, {
    generate: async (providerRequest) => {
      generateCalls += 1;
      lastProviderRequest = providerRequest;
      return options.candidate ?? goodCandidate();
    },
    validateLanguage: async () => options.language ?? true,
    validateSafety: async () => options.safety ?? true,
    runHandoffSingleFlight: createLease(),
    handoffStore: store,
  });
  return { responseService, store, get generateCalls() { return generateCalls; }, get lastProviderRequest() { return lastProviderRequest; } };
}

const noQuote: QuoteResolutionResult = { status: 'none' };

test('valid grounded output becomes a structured CG handoff without TI Message persistence', async () => {
  const harness = service();
  const result = await harness.responseService.createHandoff({ requestId: 'ti-request-101', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote });
  assert.equal(result.created, true);
  assert.equal(result.handoff.response.claims[0]?.text, claimText);
  assert.deepEqual(result.handoff.response.claims[0]?.citations, [{ evidenceId: evidence().evidence[0]!.evidenceId, quote: evidenceQuote }]);
  assert.equal(result.handoff.response.evidenceReferences[0]?.origin, 'cg_post');
  assert.equal(result.handoff.userMessageId, 'cg-message-88');
  assert.equal(harness.generateCalls, 1);
  const providerRequest = harness.lastProviderRequest as { trustedInstruction: string; input: Record<string, unknown> };
  assert.equal(typeof providerRequest.trustedInstruction, 'string');
  assert.match(String(providerRequest.input.contextJson), /What did the pilot report say/);
  assert.equal(harness.store.records.size, 1);
});

test('citation mutations, malformed schemas, unsupported language, and safety failures never hand off', async () => {
  const altered = service({ candidate: {
    ...goodCandidate(), claims: [{ text: claimText, citations: [{ evidenceId: evidence().evidence[0]!.evidenceId, quote: 'The pilot ended in 2027' }] }],
  } });
  await assert.rejects(() => altered.responseService.createHandoff({ requestId: 'r1', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote }),
    (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_output');
  const malformed = service({ candidate: { ...goodCandidate(), extra: 'not allowed' } });
  await assert.rejects(() => malformed.responseService.createHandoff({ requestId: 'r2', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote }),
    (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_output');
  const wrongLanguage = service();
  await assert.rejects(() => wrongLanguage.responseService.createHandoff({
    requestId: 'r3', request: request({ responseConstraints: { ...request().responseConstraints, postLanguage: 'unknown' } }), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote,
  }), (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_request');
  const unsafe = service({ safety: false });
  await assert.rejects(() => unsafe.responseService.createHandoff({ requestId: 'r4', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote }),
    (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'unsafe_output');
  assert.equal(unsafe.store.records.size, 0);
});

test('evidence must match the eligible canonical post identity/version/language before any generation', async () => {
  const wrongVersion = service();
  await assert.rejects(() => wrongVersion.responseService.createHandoff({
    requestId: 'r-post-version', request: request(), canonicalPost,
    evidenceBundle: evidence({ ...canonicalPost, postContentVersion: 'post-v9' }), quoteResolution: noQuote,
  }), (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_evidence');
  assert.equal(wrongVersion.generateCalls, 0);
  const hiddenPost = service();
  await assert.rejects(() => hiddenPost.responseService.createHandoff({
    requestId: 'r-hidden-post', request: request(), canonicalPost: { ...canonicalPost, moderationState: 'hidden' },
    evidenceBundle: evidence(), quoteResolution: noQuote,
  }), (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_request');
  assert.equal(hiddenPost.generateCalls, 0);
});

test('language validation is mandatory for every claim and limitation before the handoff', async () => {
  const harness = service({ language: false });
  await assert.rejects(() => harness.responseService.createHandoff({ requestId: 'r5', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote }),
    (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_output');
  assert.equal(harness.store.records.size, 0);
});

test('partial grounding requires its configured localized limitation; insufficient evidence skips generation', async () => {
  const partialRequired = basePolicy.partialGroundingByLanguage.en;
  const partialPolicy = { ...basePolicy, evidencePolicy: { ...basePolicy.evidencePolicy, minimumEvidenceCodePoints: 1_000 } };
  const invalidPartial = service({ policy: partialPolicy, candidate: { ...goodCandidate(), limitations: [] } });
  await assert.rejects(() => invalidPartial.responseService.createHandoff({
    requestId: 'r6', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote,
  }), (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_output');
  const candidateWithLimitation = { ...goodCandidate(), limitations: [partialRequired] };
  const goodPartial = service({ policy: partialPolicy, candidate: candidateWithLimitation });
  const accepted = await goodPartial.responseService.createHandoff({ requestId: 'r7', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote });
  assert.equal(accepted.handoff.response.limitations[0], partialRequired);

  const strictPolicy = { ...basePolicy, evidencePolicy: { ...basePolicy.evidencePolicy, insufficientEvidenceAction: 'fail' as const, minimumEvidenceCodePoints: 4_000 } };
  const insufficient = service({ policy: strictPolicy });
  const result = await insufficient.responseService.createHandoff({ requestId: 'r8', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote });
  assert.deepEqual(result.handoff.response.claims, []);
  assert.equal(result.handoff.response.limitations[0], basePolicy.insufficientEvidenceByLanguage.en);
  assert.equal(insufficient.generateCalls, 0);
});

function postQuote(): TiMappedCgQuoteV2 {
  return {
    quoteId: 'quoted-message-11',
    parentPostId: 'deep-dive-post-17',
    parentPostContentVersion: 'post-v8',
    snapshot: {
      type: 'cg_post', postId: 'deep-dive-post-17', postContentVersion: 'post-v8', contentHash: 'post-hash-v8',
      title: 'Synthetic research title', content: canonicalPost.content, language: 'en', contentFormat: 'plain_text',
      capturedAt: '2026-11-26T10:00:00.000Z', knownCurrentPostContentVersion: 'post-v9',
    },
  };
}

function resolvedPostQuote(quote: TiMappedCgQuoteV2, bundle: EvidenceBundleV1) {
  return {
    status: 'resolved' as const,
    quote: {
      type: 'cg_post' as const,
      quoteId: quote.quoteId,
      postId: 'deep-dive-post-17',
      quotedVersion: { kind: 'postContentVersion' as const, value: 'post-v8' },
      language: 'en',
      title: 'Synthetic research title',
      content: canonicalPost.content,
      evidence: bundle,
      currentVersion: 'post-v9',
      currentVersionDiffers: true,
    },
  };
}

test('old quote version evidence and difference metadata are preserved; unavailable quote never falls back to current evidence', async () => {
  const quote = postQuote();
  const quotedRequest = request({ quote });
  const quotedBundle = evidence();
  const harness = service({ candidate: {
    ...goodCandidate(),
    claims: [{ text: 'The pilot began in 2025.', citations: [{ evidenceId: quotedBundle.evidence[0]!.evidenceId, quote: evidenceQuote }] }],
  } });
  const result = await harness.responseService.createHandoff({ requestId: 'r9', request: quotedRequest, canonicalPost, evidenceBundle: evidence(), quoteResolution: resolvedPostQuote(quote, quotedBundle) });
  assert.equal(result.handoff.response.quoteVersion?.type, 'cg_post');
  if (result.handoff.response.quoteVersion?.type === 'cg_post') assert.equal(result.handoff.response.quoteVersion.currentVersionDiffers, true);
  const unavailable = service();
  const fallback = await unavailable.responseService.createHandoff({
    requestId: 'r10', request: quotedRequest, canonicalPost, evidenceBundle: evidence(),
    quoteResolution: { status: 'unavailable', limitation: 'quote_snapshot_unavailable' },
  });
  assert.deepEqual(fallback.handoff.response.claims, []);
  assert.equal(fallback.handoff.response.grounding.mode, 'unavailable');
  assert.deepEqual(fallback.handoff.response.quoteVersion, {
    type: 'cg_post',
    quoteId: 'quoted-message-11',
    postId: 'deep-dive-post-17',
    version: { kind: 'postContentVersion', value: 'post-v8' },
    currentVersionDiffers: true,
  }, 'unavailable resolution retains the exact snapshot version without substituting current content');
  assert.equal(unavailable.generateCalls, 0);
});

test('equivalent retries reuse one durable handoff; conflicting userMessageId reuse is rejected', async () => {
  const harness = service();
  const input = { requestId: 'r11', request: request(), canonicalPost, evidenceBundle: evidence(), quoteResolution: noQuote };
  const [first, second] = await Promise.all([
    harness.responseService.createHandoff(input),
    harness.responseService.createHandoff(input),
  ]);
  assert.equal(harness.generateCalls, 1);
  assert.equal(first.handoff, second.handoff);
  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  const retriedWithNewTiRequestId = await harness.responseService.createHandoff({ ...input, requestId: 'new-ti-attempt-id' });
  assert.equal(retriedWithNewTiRequestId.handoff, first.handoff,
    'TI request/attempt IDs do not change equivalent userMessageId idempotency');
  assert.equal(retriedWithNewTiRequestId.created, false);
  await assert.rejects(() => harness.responseService.createHandoff({
    ...input, request: request({ currentMessage: 'Changed request on same CG message ID.' }),
  }), (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'idempotency_conflict');
  await assert.rejects(() => harness.responseService.createHandoff({
    ...input, request: request({ requestRef: 'different-cg-request-reference' }),
  }), (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'idempotency_conflict');
  assert.equal(harness.generateCalls, 1);
});

test('multiple quote snapshots and mismatched quote-resolution identities fail closed', async () => {
  const quote = postQuote();
  const multiple = request({ quote, recentContext: [{ messageId: 'ctx-1', role: 'user', content: 'another', quote }] });
  const harness = service();
  await assert.rejects(() => harness.responseService.createHandoff({ requestId: 'r12', request: multiple, canonicalPost, evidenceBundle: evidence(), quoteResolution: resolvedPostQuote(quote, evidence()) }),
    (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_request');
  const mismatched = { ...resolvedPostQuote(quote, evidence()), quote: { ...resolvedPostQuote(quote, evidence()).quote, quoteId: 'other' } };
  await assert.rejects(() => harness.responseService.createHandoff({ requestId: 'r13', request: request({ quote }), canonicalPost, evidenceBundle: evidence(), quoteResolution: mismatched }),
    (error: unknown) => error instanceof DeepDiveResponseError && error.code === 'invalid_request');
});
