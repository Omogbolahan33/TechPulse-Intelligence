import { randomUUID } from 'node:crypto';
import {
  validateCanonicalPostInput,
  type CanonicalPostInputV1,
  type ContractLimits,
  type StableId,
} from './contracts';
import {
  prepareGenerationEvidence,
  validateGroundedClaims,
  type EvidenceBundleV1,
  type EvidenceSufficiencyPolicy,
} from './evidence';
import { createSummaryArtifactKey, type ArtifactKeyPolicy } from './artifact-key';
import type { ArtifactInput, PersistedArtifact, TiPersistence } from './persistence';
import type { StructuredGenerationRequest } from './provider';

export interface SummaryClaimV1 {
  readonly text: string;
  readonly citations: readonly { readonly evidenceId: string; readonly quote: string }[];
}

export interface SummaryCandidateV1 {
  readonly schemaVersion: 1;
  readonly outputLanguage: string;
  readonly summary: SummaryClaimV1;
  readonly takeaways: readonly SummaryClaimV1[];
}

export interface SummaryPayloadV1 {
  readonly schemaVersion: 1;
  readonly outputLanguage: string;
  readonly summary: SummaryClaimV1;
  readonly takeaways: readonly SummaryClaimV1[];
  readonly groundingDisclosure: EvidenceBundleV1['groundingDisclosure'];
}

export interface SummaryGenerationPolicy {
  readonly contractLimits: ContractLimits;
  readonly supportedLanguages: readonly string[];
  readonly eligibleModerationStates: readonly string[];
  readonly eligiblePublicationStates: readonly string[];
  readonly evidencePolicy: EvidenceSufficiencyPolicy;
  readonly artifactKeyPolicy: ArtifactKeyPolicy;
  readonly generationDefinitionVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: number;
  readonly retentionClass: string;
  readonly maxCitationClaims: number;
  readonly maxCitationQuoteCodePoints: number;
  readonly maxSummarySentenceCodePoints: number;
  readonly maxTakeawayCodePoints: number;
}

export interface SummaryGenerationDependencies {
  /** Must verify the caller is the authenticated CG service; no user identifier is accepted here. */
  readonly authorizeCgService: () => Promise<boolean>;
  /** Must return the evidence bundle prepared for this exact canonical input. */
  readonly loadEvidenceBundle: (post: CanonicalPostInputV1) => Promise<EvidenceBundleV1>;
  /** Provider-neutral callback; provider choice, route, budgets and activation remain deployment-owned. */
  readonly generate: (request: StructuredGenerationRequest) => Promise<unknown>;
  /** Required language/safety checks are explicit and fail closed. */
  readonly validateLanguage: (text: string, language: string) => boolean | Promise<boolean>;
  readonly validateSafety: (candidate: SummaryCandidateV1, post: CanonicalPostInputV1) => boolean | Promise<boolean>;
  /** Must provide a distributed per-key lease/single-flight boundary in production. */
  readonly runArtifactSingleFlight: <T>(artifactKey: string, work: () => Promise<T>) => Promise<T>;
  readonly now?: () => Date;
}

export interface SummaryGenerationResult {
  readonly artifactKey: string;
  readonly version: number;
  readonly cacheHit: boolean;
  readonly payload: SummaryPayloadV1;
}

export type SummaryGenerationFailureCode = 'unauthorized' | 'invalid_post' | 'ineligible_post' | 'invalid_evidence' | 'insufficient_evidence' | 'invalid_output' | 'unavailable';

/** Safe public failure. It intentionally excludes raw CG content, provider details, SQL and credentials. */
export class SummaryGenerationError extends Error {
  readonly code: SummaryGenerationFailureCode;
  constructor(code: SummaryGenerationFailureCode) {
    super(`Summary generation failed (${code})`);
    this.name = 'SummaryGenerationError';
    this.code = code;
  }
}

const REQUIRED_POLICY_KEYS = [
  'contractLimits', 'supportedLanguages', 'eligibleModerationStates', 'eligiblePublicationStates',
  'evidencePolicy', 'artifactKeyPolicy', 'generationDefinitionVersion', 'promptVersion', 'schemaVersion',
  'retentionClass', 'maxCitationClaims', 'maxCitationQuoteCodePoints', 'maxSummarySentenceCodePoints', 'maxTakeawayCodePoints',
] as const;

function exactPlainRecord(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} is not a plain data record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !allowed.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new Error(`${label} contains unsupported or accessor fields`);
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length > 0
      || Object.getOwnPropertyNames(value).length !== value.length + 1 || value.length > maxItems) {
    throw new Error(`${label} is not a bounded dense array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!descriptors[String(index)]?.enumerable || !Object.hasOwn(descriptors[String(index)], 'value')) {
      throw new Error(`${label} contains an accessor or sparse element`);
    }
  }
  return value;
}

function requiredString(value: unknown, label: string, maxCodePoints: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Array.from(value).length > maxCodePoints) {
    throw new Error(`${label} is empty or exceeds its configured bound`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function snapshotPolicy(input: SummaryGenerationPolicy): SummaryGenerationPolicy {
  const value = exactPlainRecord(input, REQUIRED_POLICY_KEYS, 'Summary policy');
  if (Object.keys(value).length !== REQUIRED_POLICY_KEYS.length) throw new Error('Summary policy must be explicit and complete');
  const limits = exactPlainRecord(value.contractLimits, [
    'maxStringCodePoints', 'maxArrayItems', 'maxPayloadBytes', 'maxContextItems', 'maxContextBytes',
  ], 'Summary contract limits');
  if (Object.keys(limits).length !== 5 || Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || (limit as number) <= 0)) {
    throw new Error('Summary contract limits must all be positive safe integers');
  }
  const copyStringArray = (candidate: unknown, label: string): readonly string[] => {
    const items = denseArray(candidate, label, limits.maxArrayItems as number);
    if (items.length === 0 || items.some((item) => typeof item !== 'string' || item.trim().length === 0)
        || new Set(items).size !== items.length) throw new Error(`${label} must contain unique non-empty strings`);
    return Object.freeze([...items] as string[]);
  };
  const supportedLanguages = copyStringArray(value.supportedLanguages, 'supportedLanguages');
  const eligibleModerationStates = copyStringArray(value.eligibleModerationStates, 'eligibleModerationStates');
  const eligiblePublicationStates = copyStringArray(value.eligiblePublicationStates, 'eligiblePublicationStates');
  const evidencePolicy = exactPlainRecord(value.evidencePolicy, [
    'minimumEvidenceCodePoints', 'insufficientEvidenceAction', 'maxEvidenceItems', 'maxEvidenceTextCodePoints',
  ], 'Summary evidence policy');
  if (Object.keys(evidencePolicy).length !== 4 || !['partial', 'fail'].includes(String(evidencePolicy.insufficientEvidenceAction))) {
    throw new Error('Summary evidence policy must be explicit');
  }
  for (const [key, limit] of Object.entries(evidencePolicy)) {
    if (key !== 'insufficientEvidenceAction') positiveInteger(limit, `evidencePolicy.${key}`);
  }
  if ((evidencePolicy.maxEvidenceItems as number) > (limits.maxArrayItems as number)
      || (evidencePolicy.maxEvidenceTextCodePoints as number) > (limits.maxPayloadBytes as number)) {
    throw new Error('Summary evidence limits exceed the explicit contract limits');
  }
  const artifactKeyPolicy = exactPlainRecord(value.artifactKeyPolicy, ['maxIdentifierCodePoints'], 'Summary artifact key policy');
  if (Object.keys(artifactKeyPolicy).length !== 1) throw new Error('Summary artifact key policy must be explicit');
  positiveInteger(artifactKeyPolicy.maxIdentifierCodePoints, 'artifactKeyPolicy.maxIdentifierCodePoints');
  const maxCitationClaims = positiveInteger(value.maxCitationClaims, 'maxCitationClaims');
  if (maxCitationClaims > (limits.maxArrayItems as number)) throw new Error('maxCitationClaims cannot exceed the configured array limit');
  const schemaVersion = positiveInteger(value.schemaVersion, 'schemaVersion');
  if (schemaVersion !== 1) throw new Error('only the explicitly implemented Summary output schema is supported');
  const generationDefinitionVersion = requiredString(value.generationDefinitionVersion, 'generationDefinitionVersion', limits.maxStringCodePoints as number);
  const promptVersion = requiredString(value.promptVersion, 'promptVersion', limits.maxStringCodePoints as number);
  const retentionClass = requiredString(value.retentionClass, 'retentionClass', limits.maxStringCodePoints as number);
  const maxCitationQuoteCodePoints = positiveInteger(value.maxCitationQuoteCodePoints, 'maxCitationQuoteCodePoints');
  const maxSummarySentenceCodePoints = positiveInteger(value.maxSummarySentenceCodePoints, 'maxSummarySentenceCodePoints');
  const maxTakeawayCodePoints = positiveInteger(value.maxTakeawayCodePoints, 'maxTakeawayCodePoints');
  if (maxCitationQuoteCodePoints > (limits.maxStringCodePoints as number)
      || maxSummarySentenceCodePoints * 4 > (limits.maxStringCodePoints as number)
      || maxTakeawayCodePoints > (limits.maxStringCodePoints as number)) {
    throw new Error('Summary output limits exceed the explicit string bound');
  }
  const contractLimits = Object.freeze({
    maxStringCodePoints: limits.maxStringCodePoints as number,
    maxArrayItems: limits.maxArrayItems as number,
    maxPayloadBytes: limits.maxPayloadBytes as number,
    maxContextItems: limits.maxContextItems as number,
    maxContextBytes: limits.maxContextBytes as number,
  });
  return Object.freeze({
    contractLimits,
    supportedLanguages,
    eligibleModerationStates,
    eligiblePublicationStates,
    evidencePolicy: Object.freeze({
      minimumEvidenceCodePoints: evidencePolicy.minimumEvidenceCodePoints as number,
      insufficientEvidenceAction: evidencePolicy.insufficientEvidenceAction as 'partial' | 'fail',
      maxEvidenceItems: evidencePolicy.maxEvidenceItems as number,
      maxEvidenceTextCodePoints: evidencePolicy.maxEvidenceTextCodePoints as number,
    }),
    artifactKeyPolicy: Object.freeze({ maxIdentifierCodePoints: artifactKeyPolicy.maxIdentifierCodePoints as number }),
    generationDefinitionVersion,
    promptVersion,
    schemaVersion,
    retentionClass,
    maxCitationClaims,
    maxCitationQuoteCodePoints,
    maxSummarySentenceCodePoints,
    maxTakeawayCodePoints,
  });
}

function splitSentences(text: string, language: string): string[] {
  type SegmenterCtor = new (locale: string, options: { granularity: 'sentence' }) => { segment(input: string): Iterable<{ segment: string }> };
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (typeof Segmenter !== 'function') throw new SummaryGenerationError('unavailable');
  return [...new Segmenter(language, { granularity: 'sentence' }).segment(text)]
    .map(({ segment }) => segment.trim()).filter(Boolean);
}

function duplicateKey(text: string, language: string): string {
  return [...new Set(text.normalize('NFKC').toLocaleLowerCase(language).match(/[\p{L}\p{N}]+/gu) ?? [])]
    .sort().join('\u0000');
}

function parseCandidate(
  raw: unknown,
  post: CanonicalPostInputV1,
  bundle: EvidenceBundleV1,
  policy: SummaryGenerationPolicy,
): SummaryCandidateV1 {
  const allowed = ['schemaVersion', 'outputLanguage', 'summary', 'takeaways'];
  const candidate = exactPlainRecord(raw, allowed, 'Summary output');
  if (Object.keys(candidate).length !== allowed.length || candidate.schemaVersion !== 1 || candidate.outputLanguage !== post.language) {
    throw new SummaryGenerationError('invalid_output');
  }
  const readClaim = (input: unknown, label: string, maxText: number): SummaryClaimV1 => {
    const claim = exactPlainRecord(input, ['text', 'citations'], label);
    if (Object.keys(claim).length !== 2) throw new SummaryGenerationError('invalid_output');
    const text = requiredString(claim.text, `${label}.text`, maxText);
    const rawCitations = denseArray(claim.citations, `${label}.citations`, policy.contractLimits.maxArrayItems);
    const citations = rawCitations.map((citationInput, index) => {
      const citation = exactPlainRecord(citationInput, ['evidenceId', 'quote'], `${label}.citations[${index}]`);
      if (Object.keys(citation).length !== 2) throw new SummaryGenerationError('invalid_output');
      return Object.freeze({
        evidenceId: requiredString(citation.evidenceId, `${label}.citations[${index}].evidenceId`, policy.contractLimits.maxStringCodePoints),
        quote: requiredString(citation.quote, `${label}.citations[${index}].quote`, policy.maxCitationQuoteCodePoints),
      });
    });
    return Object.freeze({ text, citations: Object.freeze(citations) });
  };
  const summary = readClaim(candidate.summary, 'summary', policy.maxSummarySentenceCodePoints * 4);
  const summarySentences = splitSentences(summary.text, post.language);
  if (summarySentences.length < 2 || summarySentences.length > 4
      || summarySentences.some((sentence) => Array.from(sentence).length > policy.maxSummarySentenceCodePoints)) {
    throw new SummaryGenerationError('invalid_output');
  }
  const takeaways = denseArray(candidate.takeaways, 'takeaways', policy.contractLimits.maxArrayItems)
    .map((item, index) => readClaim(item, `takeaways[${index}]`, policy.maxTakeawayCodePoints));
  if (takeaways.length < 3 || takeaways.length > 5) throw new SummaryGenerationError('invalid_output');
  const seen = new Set<string>();
  for (const takeaway of takeaways) {
    const key = duplicateKey(takeaway.text, post.language);
    if (!key || seen.has(key)) throw new SummaryGenerationError('invalid_output');
    seen.add(key);
  }
  const claims = [summary, ...takeaways].map(({ text, citations }) => ({ text, citations }));
  const citationResult = validateGroundedClaims(claims, bundle, {
    contractLimits: policy.contractLimits,
    maxCitationClaims: policy.maxCitationClaims,
    maxCitationQuoteCodePoints: policy.maxCitationQuoteCodePoints,
  });
  if (!citationResult.valid) throw new SummaryGenerationError('invalid_output');
  return Object.freeze({
    schemaVersion: 1,
    outputLanguage: post.language,
    summary,
    takeaways: Object.freeze(takeaways),
  });
}

function isSamePost(bundle: EvidenceBundleV1, post: CanonicalPostInputV1): boolean {
  const expectedVersion: { readonly kind: 'postContentVersion' | 'contentHash'; readonly value: StableId } | null = post.postContentVersion !== undefined
    ? { kind: 'postContentVersion', value: post.postContentVersion }
    : post.contentHash !== undefined ? { kind: 'contentHash', value: post.contentHash } : null;
  return expectedVersion !== null
    && bundle.post.postId === post.postId
    && bundle.post.version.kind === expectedVersion.kind
    && bundle.post.version.value === expectedVersion.value
    && bundle.post.language === post.language
    && (bundle.post.contentHash === undefined || post.contentHash === bundle.post.contentHash);
}

function buildArtifactCitations(candidate: SummaryCandidateV1): readonly Record<string, unknown>[] {
  const refs: Record<string, unknown>[] = [];
  for (const [claimType, claims] of [['summary', [candidate.summary]], ['takeaway', candidate.takeaways]] as const) {
    for (const [claimIndex, claim] of claims.entries()) {
      for (const citation of claim.citations) refs.push({ claimType, claimIndex, ...citation });
    }
  }
  return Object.freeze(refs.map((citation) => Object.freeze(citation)));
}

function cachePayload(
  cached: PersistedArtifact | null,
  artifactKey: string,
  post: CanonicalPostInputV1,
  bundle: EvidenceBundleV1,
  policy: SummaryGenerationPolicy,
): SummaryPayloadV1 | null {
  if (!cached || cached.artifactKey !== artifactKey || cached.artifactType !== 'summary' || cached.status !== 'ready'
      || cached.moderationState !== post.moderationState || cached.postId !== post.postId
      || cached.postContentVersion !== post.postContentVersion || cached.contentHash !== post.contentHash
      || cached.outputLanguage !== post.language || cached.schemaVersion !== policy.schemaVersion || cached.promptVersion !== policy.promptVersion
      || !isSamePost(bundle, post) || cached.groundingMode !== bundle.groundingMode) return null;
  try {
    const stored = exactPlainRecord(cached.payload, ['schemaVersion', 'outputLanguage', 'summary', 'takeaways', 'groundingDisclosure'], 'cached Summary');
    if (stored.groundingDisclosure !== bundle.groundingDisclosure) return null;
    const candidate = parseCandidate({
      schemaVersion: stored.schemaVersion,
      outputLanguage: stored.outputLanguage,
      summary: stored.summary,
      takeaways: stored.takeaways,
    }, post, bundle, policy);
    return Object.freeze({ ...candidate, groundingDisclosure: bundle.groundingDisclosure });
  } catch {
    return null;
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

const outputSchema = freezeDeep({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'outputLanguage', 'summary', 'takeaways'],
  properties: {
    schemaVersion: { const: 1 },
    outputLanguage: { type: 'string' },
    summary: { $ref: '#/$defs/claim' },
    takeaways: { type: 'array', minItems: 3, maxItems: 5, items: { $ref: '#/$defs/claim' } },
  },
  $defs: {
    claim: {
      type: 'object', additionalProperties: false, required: ['text', 'citations'],
      properties: {
        text: { type: 'string', minLength: 1 },
        citations: {
          type: 'array', minItems: 1,
          items: {
            type: 'object', additionalProperties: false, required: ['evidenceId', 'quote'],
            properties: { evidenceId: { type: 'string', minLength: 1 }, quote: { type: 'string', minLength: 1 } },
          },
        },
      },
    },
  },
});

export class SummaryGenerationService {
  private readonly persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>;
  private readonly policy: SummaryGenerationPolicy;
  private readonly dependencies: SummaryGenerationDependencies;

  constructor(
    persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>,
    policy: SummaryGenerationPolicy,
    dependencies: SummaryGenerationDependencies,
  ) {
    if (!dependencies || typeof dependencies.authorizeCgService !== 'function'
        || typeof dependencies.loadEvidenceBundle !== 'function' || typeof dependencies.generate !== 'function'
        || typeof dependencies.validateLanguage !== 'function' || typeof dependencies.validateSafety !== 'function'
        || typeof dependencies.runArtifactSingleFlight !== 'function') {
      throw new Error('Summary service requires explicit CG authorization, evidence, generation, language, safety and single-flight dependencies');
    }
    this.persistence = persistence;
    this.policy = snapshotPolicy(policy);
    this.dependencies = dependencies;
  }

  async generate(rawPost: unknown): Promise<SummaryGenerationResult> {
    let authorized = false;
    try { authorized = await this.dependencies.authorizeCgService(); } catch { /* fail closed */ }
    if (authorized !== true) throw new SummaryGenerationError('unauthorized');

    let post: CanonicalPostInputV1;
    try {
      post = validateCanonicalPostInput(rawPost, this.policy.contractLimits, this.policy.supportedLanguages);
    } catch {
      throw new SummaryGenerationError('invalid_post');
    }
    if (!this.policy.eligibleModerationStates.includes(post.moderationState)
        || !this.policy.eligiblePublicationStates.includes(post.publicationState)) {
      throw new SummaryGenerationError('ineligible_post');
    }

    let bundle: EvidenceBundleV1;
    let preparation: ReturnType<typeof prepareGenerationEvidence>;
    try {
      bundle = await this.dependencies.loadEvidenceBundle(post);
      if (!isSamePost(bundle, post)) throw new Error('evidence is not bound to the requested canonical version');
      preparation = prepareGenerationEvidence('summary', bundle, [], this.policy.contractLimits, this.policy.evidencePolicy);
    } catch {
      throw new SummaryGenerationError('invalid_evidence');
    }
    let key: string;
    try {
      key = createSummaryArtifactKey({
        postId: post.postId,
        ...(post.postContentVersion === undefined ? {} : { postContentVersion: post.postContentVersion }),
        ...(post.contentHash === undefined ? {} : { contentHash: post.contentHash }),
        evidence: bundle.groundingMode === 'cg_plus_source'
          ? { availability: 'available', evidenceVersion: bundle.bundleHash }
          : { availability: 'unavailable' },
        outputLanguage: post.language,
        generationDefinitionVersion: this.policy.generationDefinitionVersion,
        promptVersion: this.policy.promptVersion,
        schemaVersion: this.policy.schemaVersion,
      }, this.policy.artifactKeyPolicy);
      return await this.dependencies.runArtifactSingleFlight(key, () => this.generateAndPublish(key, post, bundle, preparation));
    } catch (error) {
      if (error instanceof SummaryGenerationError) throw error;
      throw new SummaryGenerationError('unavailable');
    }
  }

  private async generateAndPublish(
    artifactKey: string,
    post: CanonicalPostInputV1,
    bundle: EvidenceBundleV1,
    preparation: ReturnType<typeof prepareGenerationEvidence>,
  ): Promise<SummaryGenerationResult> {
    try {
      const cached = await this.persistence.getArtifact(artifactKey);
      const validCachedPayload = cachePayload(cached, artifactKey, post, bundle, this.policy);
      if (validCachedPayload && cached) return Object.freeze({ artifactKey, version: cached.version, cacheHit: true, payload: validCachedPayload });

      if (preparation.outcome === 'failed' || preparation.prompt === null) {
        throw new SummaryGenerationError('insufficient_evidence');
      }
      const request: StructuredGenerationRequest = Object.freeze({
        operationKind: 'summary',
        correlationId: randomUUID(),
        outputLanguage: post.language,
        schemaVersion: this.policy.schemaVersion,
        trustedInstruction: preparation.prompt.trustedInstruction,
        input: Object.freeze({
          canonicalPost: Object.freeze({
            postId: post.postId,
            ...(post.postContentVersion === undefined ? {} : { postContentVersion: post.postContentVersion }),
            ...(post.contentHash === undefined ? {} : { contentHash: post.contentHash }),
            title: post.title,
            content: post.content,
            language: post.language,
            categoryId: post.categoryId,
            subcategoryId: post.subcategoryId,
            topicIds: Object.freeze([...post.topicIds]),
          }),
          evidenceJson: preparation.prompt.evidenceJson,
        }),
        outputSchema,
      });
      const rawOutput = await this.dependencies.generate(request);
      const candidate = parseCandidate(rawOutput, post, bundle, this.policy);
      const allClaimsLanguageValid = await Promise.all([
        this.dependencies.validateLanguage(candidate.summary.text, post.language),
        ...candidate.takeaways.map(({ text }) => this.dependencies.validateLanguage(text, post.language)),
      ]).then((checks) => checks.every(Boolean));
      if (!allClaimsLanguageValid || !await this.dependencies.validateSafety(candidate, post)) {
        throw new SummaryGenerationError('invalid_output');
      }
      const payload: SummaryPayloadV1 = Object.freeze({
        ...candidate,
        groundingDisclosure: preparation.disclosure,
      });
      const artifactInput: ArtifactInput = {
        artifactKey,
        artifactType: 'summary',
        postId: post.postId,
        ...(post.postContentVersion === undefined ? {} : { postContentVersion: post.postContentVersion }),
        ...(post.contentHash === undefined ? {} : { contentHash: post.contentHash }),
        outputLanguage: post.language,
        payload: { ...payload },
        groundingMode: preparation.groundingMode,
        citations: buildArtifactCitations(candidate) as unknown[],
        limitations: [...bundle.limitations],
        schemaVersion: this.policy.schemaVersion,
        promptVersion: this.policy.promptVersion,
        moderationState: post.moderationState,
        status: 'ready',
        retentionClass: this.policy.retentionClass,
        ...(this.dependencies.now ? { createdAt: this.dependencies.now() } : {}),
      };
      const version = await this.persistence.publishArtifact(artifactInput);
      return Object.freeze({ artifactKey, version, cacheHit: false, payload });
    } catch (error) {
      if (error instanceof SummaryGenerationError) throw error;
      throw new SummaryGenerationError('unavailable');
    }
  }
}
