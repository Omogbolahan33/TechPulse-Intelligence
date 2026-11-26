import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { EvidenceBundleV1 } from './evidence';
import { SummaryGenerationError, SummaryGenerationService, type SummaryCandidateV1, type SummaryGenerationDependencies, type SummaryGenerationPolicy } from './summary';
import type { ArtifactInput, PersistedArtifact, TiPersistence } from './persistence';
import type { StructuredGenerationRequest } from './provider';
import { canonicalPost } from './fixtures/canonical-cg';

const limits = {
  maxStringCodePoints: 8_192,
  maxArrayItems: 64,
  maxPayloadBytes: 65_536,
  maxContextItems: 8,
  maxContextBytes: 16_384,
} as const;
const policy: SummaryGenerationPolicy = {
  contractLimits: limits,
  supportedLanguages: ['en', 'fr'],
  eligibleModerationStates: ['visible'],
  eligiblePublicationStates: ['published'],
  evidencePolicy: {
    minimumEvidenceCodePoints: 12,
    insufficientEvidenceAction: 'fail',
    maxEvidenceItems: 12,
    maxEvidenceTextCodePoints: 8_192,
  },
  artifactKeyPolicy: { maxIdentifierCodePoints: 256 },
  generationDefinitionVersion: 'synthetic-summary-definition-v1',
  promptVersion: 'synthetic-summary-prompt-v1',
  schemaVersion: 1,
  retentionClass: 'synthetic-summary-retention',
  maxCitationClaims: 16,
  maxCitationQuoteCodePoints: 2_048,
  maxSummarySentenceCodePoints: 1_200,
  maxTakeawayCodePoints: 600,
};
const post = Object.freeze({
  ...canonicalPost,
  postId: 'synthetic-summary-post-01',
  postContentVersion: 'synthetic-summary-post-version-01',
  contentHash: 'sha256:synthetic-summary-content-01',
  title: 'Synthetic project update',
  content: 'Work began in 2025. The pilot includes 12 clinics. Reported completion is 42%.',
  language: 'en',
});
const canonicalEvidenceText = `Title: ${post.title}\n\nContent: ${post.content}`;
const evidenceId = `cg_${'a'.repeat(32)}`;

function evidenceBundle(text = canonicalEvidenceText): EvidenceBundleV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    post: {
      postId: post.postId,
      version: { kind: 'postContentVersion' as const, value: post.postContentVersion },
      contentHash: post.contentHash,
      language: post.language,
    },
    source: { status: 'failed' as const, failureCode: 'network_error' as const },
    groundingMode: 'cg_only' as const,
    groundingDisclosure: 'Limited grounding: only canonical CG post content is available.' as const,
    evidence: [{ evidenceId, origin: 'cg_post' as const, text }],
    truncated: false,
    limitations: ['linked_source_unavailable_or_unusable', 'source_failed'],
  };
  return Object.freeze({
    ...withoutHash,
    bundleHash: createHash('sha256').update(JSON.stringify(withoutHash), 'utf8').digest('hex'),
  });
}


const generatedCandidate: SummaryCandidateV1 = {
  schemaVersion: 1,
  outputLanguage: 'en',
  summary: {
    text: 'Work began in 2025 and the pilot includes 12 clinics. Reported completion is 42%.',
    citations: [{ evidenceId, quote: canonicalEvidenceText }],
  },
  takeaways: [
    { text: 'Work began in 2025.', citations: [{ evidenceId, quote: 'Work began in 2025.' }] },
    { text: 'The pilot includes 12 clinics.', citations: [{ evidenceId, quote: 'The pilot includes 12 clinics.' }] },
    { text: 'Reported completion is 42%.', citations: [{ evidenceId, quote: 'Reported completion is 42%.' }] },
  ],
};

function fakePersistence(): {
  persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>;
  published: ArtifactInput[];
  reads: number;
} {
  const published: ArtifactInput[] = [];
  let current: PersistedArtifact | null = null;
  let reads = 0;
  return {
    persistence: {
      async getArtifact(key) {
        reads += 1;
        return current?.artifactKey === key ? current : null;
      },
      async publishArtifact(input) {
        published.push(input);
        const version = (current?.version ?? 0) + 1;
        current = { ...input, version, isCurrent: true };
        return version;
      },
    },
    published,
    get reads() { return reads; },
  };
}

function singleFlight() {
  const active = new Map<string, Promise<unknown>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const existing = active.get(key);
    if (existing) return existing as Promise<T>;
    const result = Promise.resolve().then(work);
    active.set(key, result);
    try { return await result; }
    finally { if (active.get(key) === result) active.delete(key); }
  };
}

function dependencies(
  overrides: Partial<SummaryGenerationDependencies> = {},
): SummaryGenerationDependencies {
  return {
    authorizeCgService: async () => true,
    loadEvidenceBundle: async () => evidenceBundle(),
    generate: async () => generatedCandidate,
    validateLanguage: () => true,
    validateSafety: () => true,
    runArtifactSingleFlight: singleFlight(),
    ...overrides,
  };
}

function service(
  persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>,
  deps = dependencies(),
  policyOverride: SummaryGenerationPolicy = policy,
) {
  return new SummaryGenerationService(persistence, policyOverride, deps);
}

test('Summary validates and atomically publishes a grounded, language-checked, shared artifact with explicit CG-only disclosure', async () => {
  const memory = fakePersistence();
  let received: StructuredGenerationRequest | undefined;
  const result = await service(memory.persistence, dependencies({
    generate: async (request) => { received = request; return generatedCandidate; },
  })).generate(post);

  assert.equal(result.cacheHit, false);
  assert.equal(result.version, 1);
  assert.equal(result.payload.groundingDisclosure, 'Limited grounding: only canonical CG post content is available.');
  assert.equal(received?.operationKind, 'summary');
  assert.equal(received?.outputLanguage, 'en');
  const generationInput = received?.input as Readonly<Record<string, unknown>> | undefined;
  const canonicalInput = generationInput?.canonicalPost;
  assert.equal(canonicalInput !== null && typeof canonicalInput === 'object' && Object.hasOwn(canonicalInput, 'userId'), false);
  assert.equal(canonicalInput !== null && typeof canonicalInput === 'object' && Object.hasOwn(canonicalInput, 'personaId'), false);
  assert.equal(generationInput && Object.hasOwn(generationInput, 'providerId'), false);
  assert.equal(memory.published.length, 1);
  assert.equal(memory.published[0].status, 'ready');
  assert.equal(memory.published[0].artifactType, 'summary');
  assert.equal(memory.published[0].groundingMode, 'cg_only');
  assert.equal(memory.published[0].postId, post.postId);
  assert.equal(memory.published[0].citations.length, 4);
  assert.equal(JSON.stringify(memory.published[0]).includes('original CG summary'), false);
  assert.equal(Object.hasOwn(memory.published[0].payload, 'providerId'), false);
});

test('ready cache hits avoid generation; equivalent concurrent calls share the injected single-flight lease', async () => {
  const memory = fakePersistence();
  const lock = singleFlight();
  let calls = 0;
  const sharedDependencies = dependencies({
    runArtifactSingleFlight: lock,
    generate: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return generatedCandidate;
    },
  });
  const firstService = service(memory.persistence, sharedDependencies);
  const secondService = service(memory.persistence, { ...sharedDependencies });
  const [first, joined] = await Promise.all([firstService.generate(post), secondService.generate(post)]);
  assert.equal(calls, 1);
  assert.equal(first.artifactKey, joined.artifactKey);
  assert.equal(first.version, joined.version);
  assert.equal(memory.published.length, 1);
  const cached = await firstService.generate(post);
  assert.equal(cached.cacheHit, true);
  assert.equal(calls, 1);
});

test('anonymous, malformed, ineligible, and evidence-mismatched requests stop before generation or publication', async () => {
  const memory = fakePersistence();
  let evidenceLoads = 0;
  let generateCalls = 0;
  const notAuthorized = service(memory.persistence, dependencies({
    authorizeCgService: async () => false,
    loadEvidenceBundle: async () => { evidenceLoads += 1; return evidenceBundle(); },
    generate: async () => { generateCalls += 1; return generatedCandidate; },
  }));
  await assert.rejects(notAuthorized.generate(post), (error: unknown) => error instanceof SummaryGenerationError && error.code === 'unauthorized');
  await assert.rejects(service(memory.persistence, dependencies()).generate({ ...post, unexpected: true }), (error: unknown) => error instanceof SummaryGenerationError && error.code === 'invalid_post');
  await assert.rejects(service(memory.persistence, dependencies()).generate({ ...post, moderationState: 'hidden' }), (error: unknown) => error instanceof SummaryGenerationError && error.code === 'ineligible_post');
  const wrongVersion = service(memory.persistence, dependencies({ loadEvidenceBundle: async () => ({ ...evidenceBundle(), post: { ...evidenceBundle().post, postId: 'synthetic-other-post' } }) }));
  await assert.rejects(wrongVersion.generate(post), (error: unknown) => error instanceof SummaryGenerationError && error.code === 'invalid_evidence');
  assert.equal(evidenceLoads, 0);
  assert.equal(generateCalls, 0);
  assert.equal(memory.published.length, 0);
});

test('invalid schema, non-English claims, unsafe content and unsupported citations never replace a ready artifact', async () => {
  for (const [candidate, deps, expectedCode] of [
    [{ ...generatedCandidate, takeaways: [] }, dependencies(), 'invalid_output'],
    [generatedCandidate, dependencies({ validateLanguage: () => false }), 'invalid_output'],
    [generatedCandidate, dependencies({ validateSafety: () => false }), 'invalid_output'],
    [{ ...generatedCandidate, summary: { ...generatedCandidate.summary, citations: [{ evidenceId: 'cg_' + 'b'.repeat(32), quote: 'fabricated evidence' }] } }, dependencies(), 'invalid_output'],
    [{ ...generatedCandidate, summary: { ...generatedCandidate.summary, text: 'The project began in 2027. The pilot includes 12 clinics.' } }, dependencies(), 'invalid_output'],
  ] as const) {
    const memory = fakePersistence();
    await assert.rejects(service(memory.persistence, dependencies({ ...deps, generate: async () => candidate })).generate(post), (error: unknown) =>
      error instanceof SummaryGenerationError && error.code === expectedCode,
    );
    assert.equal(memory.published.length, 0);
  }
});

test('insufficient evidence fails closed before provider work and configuration snapshots are explicit', async () => {
  const memory = fakePersistence();
  let calls = 0;
  const tooLittleEvidence = service(memory.persistence, dependencies({
    loadEvidenceBundle: async () => evidenceBundle('x'),
    generate: async () => { calls += 1; return generatedCandidate; },
  }));
  await assert.rejects(tooLittleEvidence.generate(post), (error: unknown) =>
    error instanceof SummaryGenerationError && error.code === 'insufficient_evidence',
  );
  assert.equal(calls, 0);
  assert.equal(memory.published.length, 0);
});
