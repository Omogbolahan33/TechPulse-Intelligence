import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalPost, canonicalPreferenceV2, preferenceWithInterestsV2 } from './fixtures/canonical-cg';
import type { EvidenceBundleV1 } from './evidence';
import type { ArtifactInput, PersistedArtifact, TiPersistence } from './persistence';
import type { StructuredGenerationRequest } from './provider';
import {
  ProsConsGenerationService,
  ProsConsValidationError,
  validateProsConsCandidate,
  type ProsConsCandidateV1,
  type ProsConsGenerationDependencies,
  type ProsConsGenerationPolicy,
  type ProsConsValidationPolicy,
} from './persona-implications';

const limits = {
  maxStringCodePoints: 8_192,
  maxArrayItems: 64,
  maxPayloadBytes: 65_536,
  maxContextItems: 8,
  maxContextBytes: 16_384,
} as const;
const policy: ProsConsValidationPolicy = {
  contractLimits: limits,
  supportedLanguages: ['en', 'fr'],
  eligibleModerationStates: ['visible'],
  eligiblePublicationStates: ['published'],
  eligibleCategoryIds: ['synthetic-category-02'],
  evidencePolicy: {
    minimumEvidenceCodePoints: 10,
    insufficientEvidenceAction: 'fail',
    maxEvidenceItems: 12,
    maxEvidenceTextCodePoints: 8_192,
  },
  artifactKeyPolicy: { maxIdentifierCodePoints: 256 },
  generationDefinitionVersion: 'synthetic-pros-cons-definition-v1',
  promptVersion: 'synthetic-pros-cons-prompt-v1',
  outputSchemaVersion: 1,
  maxClaims: 32,
  maxCitationQuoteCodePoints: 2_048,
  maxClaimCodePoints: 1_200,
  minimumPros: 1,
  maximumPros: 4,
  minimumCons: 1,
  maximumCons: 4,
  minimumActions: 1,
  maximumActions: 4,
  minimumMitigations: 1,
  maximumMitigations: 4,
  minimumUncertainties: 1,
  maximumUncertainties: 4,
};
const generationPolicy: ProsConsGenerationPolicy = { ...policy, retentionClass: 'synthetic-pros-cons-retention' };
const post = Object.freeze({
  ...canonicalPost,
  postId: 'synthetic-pros-cons-post-01',
  postContentVersion: 'synthetic-pros-cons-version-01',
  contentHash: 'sha256:synthetic-pros-cons-hash-01',
  title: 'Synthetic workflow automation report',
  content: 'The software automated 40% of manual reporting. Teams reduced review time by 20%. The report does not measure error rates.',
  language: 'en',
});
const evidenceId = `cg_${'c'.repeat(32)}`;
const evidenceText = `Title: ${post.title}\n\nContent: ${post.content}`;

function bundle(text = evidenceText): EvidenceBundleV1 {
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
  return {
    ...withoutHash,
    bundleHash: createHash('sha256').update(JSON.stringify(withoutHash), 'utf8').digest('hex'),
  };
}

function claim(text: string, quote: string) {
  return { text, citations: [{ evidenceId, quote }] };
}

function candidate(personaId = 'General'): ProsConsCandidateV1 {
  return {
    schemaVersion: 1,
    outputLanguage: 'en',
    personaId: personaId as ProsConsCandidateV1['personaId'],
    executiveDigest: claim(
      'The software automated 40% of manual reporting and teams reduced review time by 20%.',
      'The software automated 40% of manual reporting. Teams reduced review time by 20%.',
    ),
    personaRelevance: claim(
      'The reported changes concern reporting and review workflows.',
      'manual reporting. Teams reduced review time',
    ),
    pros: [claim('The software automated 40% of manual reporting.', 'The software automated 40% of manual reporting.')],
    cons: [claim('The report does not measure error rates.', 'The report does not measure error rates.')],
    actions: [claim('Compare the review-time result with a documented pre-adoption baseline.', 'Teams reduced review time by 20%.')],
    mitigations: [claim('Track error rates before expanding the workflow.', 'The report does not measure error rates.')],
    uncertainties: [claim('The error-rate effect remains unmeasured.', 'The report does not measure error rates.')],
  };
}

const reviewers = {
  verifyCanonicalPreference: (): boolean | Promise<boolean> => true,
  validateLanguage: (): boolean | Promise<boolean> => true,
  semanticReview: (): boolean | Promise<boolean> => true,
};

async function validate(
  inputCandidate: unknown = candidate(),
  inputPreference: unknown = canonicalPreferenceV2,
  inputBundle: EvidenceBundleV1 = bundle(),
  policyOverride: ProsConsValidationPolicy = policy,
  reviewOverride: typeof reviewers = reviewers,
) {
  return validateProsConsCandidate(post, inputPreference, inputBundle, inputCandidate, policyOverride, reviewOverride);
}

test('General with empty interests validates into a grounded Pros/Cons artifact with explicit limitations', async () => {
  const result = await validate();
  assert.match(result.artifactKey, /^ti:pros_cons:v1:[a-f0-9]{64}$/);
  assert.equal(result.payload.personaId, 'General');
  assert.equal(result.payload.pros.length, 1);
  assert.equal(result.payload.cons.length, 1);
  assert.equal(result.payload.groundingDisclosure, 'Limited grounding: only canonical CG post content is available.');
  assert.deepEqual(result.payload.limitations, ['linked_source_unavailable_or_unusable', 'source_failed']);
  assert.equal(result.citations.length, 7);
  assert.equal(JSON.stringify(result.payload).includes('userId'), false);
  assert.equal(JSON.stringify(result.payload).includes('resolvedPersonaGuidance'), false);
  assert.equal(JSON.stringify(result.payload).includes('providerId'), false);
});

test('canonical unordered interests share an identity; persona, definition, taxonomy, post and evidence changes partition it', async () => {
  const original = await validate(candidate('Engineer'), preferenceWithInterestsV2);
  const reversed = {
    ...preferenceWithInterestsV2,
    selectedInterests: [...preferenceWithInterestsV2.selectedInterests].reverse(),
  };
  const reordered = await validate(candidate('Engineer'), reversed);
  assert.equal(original.artifactKey, reordered.artifactKey);

  const changedPersona = await validate(candidate('Founder'), { ...preferenceWithInterestsV2, personaId: 'Founder' });
  const changedDefinition = await validate(candidate('Engineer'), { ...preferenceWithInterestsV2, personaDefinitionVersion: 'synthetic-persona-definition-v99' });
  const changedTaxonomy = await validate(candidate('Engineer'), { ...preferenceWithInterestsV2, interestTaxonomyVersion: 'synthetic-interest-taxonomy-v99' });
  assert.notEqual(original.artifactKey, changedPersona.artifactKey);
  assert.notEqual(original.artifactKey, changedDefinition.artifactKey);
  assert.notEqual(original.artifactKey, changedTaxonomy.artifactKey);
});

test('unsupported category, unverified preference catalog, malformed schemas and ungrounded claims fail closed', async () => {
  await assert.rejects(validate(candidate(), canonicalPreferenceV2, bundle(), {
    ...policy, eligibleCategoryIds: ['another-category'],
  }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'ineligible');
  await assert.rejects(validate(candidate(), canonicalPreferenceV2, bundle(), policy, {
    ...reviewers, verifyCanonicalPreference: () => false,
  }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_input');
  await assert.rejects(validate({ ...candidate(), extra: 'forbidden' }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  await assert.rejects(validate({ ...candidate(), cons: [] }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  await assert.rejects(validate({ ...candidate(), pros: [candidate().cons[0]] }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  await assert.rejects(validate({ ...candidate(), executiveDigest: claim('The software saved 50% of costs.', 'The software automated 40% of manual reporting.') }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  await assert.rejects(validate(
    { ...candidate(), uncertainties: [claim('The software doubles errors.', 'The report does not measure error rates.')] },
    canonicalPreferenceV2,
    bundle(),
    policy,
    { ...reviewers, semanticReview: () => false },
  ), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
});

test('language, materiality, counterpoint, politics and nonpartisan review gates are mandatory', async () => {
  await assert.rejects(validate(candidate(), canonicalPreferenceV2, bundle(), policy, {
    ...reviewers, validateLanguage: () => false,
  }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  await assert.rejects(validate(candidate(), canonicalPreferenceV2, bundle(), policy, {
    ...reviewers, semanticReview: () => false,
  }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  await assert.rejects(validate(candidate(), canonicalPreferenceV2, bundle(), policy, {
    ...reviewers, semanticReview: async () => { throw new Error('reviewer secret'); },
  }), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output' && !error.message.includes('reviewer secret'));
});

test('insufficient evidence and configured item-count bounds cannot be padded or silently published', async () => {
  await assert.rejects(validate(candidate(), canonicalPreferenceV2, bundle('short'), policy), (error: unknown) =>
    error instanceof ProsConsValidationError && error.code === 'insufficient_evidence',
  );
  await assert.rejects(validate({ ...candidate(), pros: [candidate().pros[0], candidate().pros[0]] }), (error: unknown) =>
    error instanceof ProsConsValidationError && error.code === 'invalid_output',
  );
  await assert.rejects(validate(candidate(), canonicalPreferenceV2, bundle(), { ...policy, minimumCons: 65, maximumCons: 65 }),
    (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_input');
});

function fakePersistence(): {
  readonly persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>;
  readonly published: ArtifactInput[];
} {
  let current: PersistedArtifact | null = null;
  const published: ArtifactInput[] = [];
  return {
    persistence: {
      async getArtifact(key) { return current?.artifactKey === key ? current : null; },
      async publishArtifact(input) {
        published.push(input);
        const version = (current?.version ?? 0) + 1;
        current = { ...input, version, isCurrent: true };
        return version;
      },
    },
    published,
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

function generationDependencies(overrides: Partial<ProsConsGenerationDependencies> = {}): ProsConsGenerationDependencies {
  return {
    authorizeCgService: async () => true,
    loadEvidenceBundle: async () => bundle(),
    resolvePersonaInstruction: () => 'Synthetic approved perspective: assess operational trade-offs, not advocacy.',
    verifyCanonicalPreference: async () => true,
    validateLanguage: () => true,
    semanticReview: () => true,
    generate: async () => candidate(),
    runArtifactSingleFlight: singleFlight(),
    ...overrides,
  };
}

function generationService(
  persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>,
  dependencies: ProsConsGenerationDependencies = generationDependencies(),
) {
  return new ProsConsGenerationService(persistence, generationPolicy, dependencies);
}

test('Pros/Cons generation sends only verified canonical preference IDs, validates before ready publication, and reuses ready cache', async () => {
  const memory = fakePersistence();
  let generationCalls = 0;
  let request: StructuredGenerationRequest | undefined;
  const service = generationService(memory.persistence, generationDependencies({
    generate: async (value) => { generationCalls += 1; request = value; return candidate(); },
  }));
  const input = { canonicalPost: post, preferences: canonicalPreferenceV2 };
  const result = await service.generate(input);
  assert.equal(result.cacheHit, false);
  assert.equal(result.version, 1);
  assert.equal(memory.published.length, 1);
  assert.equal(memory.published[0].artifactType, 'persona_implications');
  assert.equal(memory.published[0].status, 'ready');
  assert.equal(result.payload.groundingDisclosure, 'Limited grounding: only canonical CG post content is available.');
  assert.equal(request?.operationKind, 'pros_cons');
  const generatedInput = request?.input as Record<string, unknown> | undefined;
  assert.equal(request?.trustedInstruction.includes('Synthetic approved perspective'), true);
  assert.equal(generatedInput && Object.hasOwn(generatedInput, 'approvedPersonaInstruction'), false);
  assert.equal(generatedInput && Object.hasOwn(generatedInput, 'trustedInstruction'), false);
  assert.equal(generatedInput && Object.hasOwn(generatedInput, 'resolvedPersonaGuidance'), false);
  assert.equal(generatedInput && Object.hasOwn(generatedInput, 'userId'), false);
  assert.equal(generatedInput && Object.hasOwn(generatedInput, 'providerId'), false);

  const cacheHit = await generationService(memory.persistence, generationDependencies({
    generate: async () => { generationCalls += 1; return candidate(); },
  })).generate(input);
  assert.equal(cacheHit.cacheHit, true);
  assert.equal(cacheHit.version, 1);
  assert.equal(generationCalls, 1);
});

test('Pros/Cons parallel calls join the injected lease; authorization, safety and generation failures never publish', async () => {
  const memory = fakePersistence();
  const sharedLease = singleFlight();
  let calls = 0;
  const sharedDeps = generationDependencies({
    runArtifactSingleFlight: sharedLease,
    generate: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return candidate('Engineer');
    },
  });
  const input = { canonicalPost: post, preferences: preferenceWithInterestsV2 };
  const left = generationService(memory.persistence, sharedDeps);
  const right = generationService(memory.persistence, { ...sharedDeps });
  const [first, joined] = await Promise.all([left.generate(input), right.generate(input)]);
  assert.equal(calls, 1);
  assert.equal(first.artifactKey, joined.artifactKey);
  assert.equal(memory.published.length, 1);

  const deniedMemory = fakePersistence();
  await assert.rejects(generationService(deniedMemory.persistence, generationDependencies({
    authorizeCgService: async () => false,
  })).generate(input), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'unauthorized');
  await assert.rejects(generationService(deniedMemory.persistence, generationDependencies({
    generate: async () => ({ ...candidate('Engineer'), extra: 'invalid' }),
  })).generate(input), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  await assert.rejects(generationService(deniedMemory.persistence, generationDependencies({
    generate: async () => candidate('Engineer'),
    semanticReview: () => false,
  })).generate(input), (error: unknown) => error instanceof ProsConsValidationError && error.code === 'invalid_output');
  assert.equal(deniedMemory.published.length, 0);
});
