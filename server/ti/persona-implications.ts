import { randomUUID } from 'node:crypto';
import {
  validateCanonicalPostInput,
  validatePreferenceInput,
  type CanonicalPostInputV1,
  type ContractLimits,
  type PersonaId,
  type PreferenceInputV2,
  type StableId,
} from './contracts';
import { createProsConsArtifactKey, type ArtifactKeyPolicy } from './artifact-key';
import {
  prepareGenerationEvidence,
  validateGroundedClaims,
  type EvidenceBundleV1,
  type EvidenceSufficiencyPolicy,
  type GroundedClaimV1,
} from './evidence';
import type { ArtifactInput, PersistedArtifact, TiPersistence } from './persistence';
import type { StructuredGenerationRequest } from './provider';

export interface ProsConsCandidateV1 {
  readonly schemaVersion: 1;
  readonly outputLanguage: string;
  readonly personaId: PersonaId;
  readonly executiveDigest: GroundedClaimV1;
  readonly personaRelevance: GroundedClaimV1;
  readonly pros: readonly GroundedClaimV1[];
  readonly cons: readonly GroundedClaimV1[];
  readonly actions: readonly GroundedClaimV1[];
  readonly mitigations: readonly GroundedClaimV1[];
  readonly uncertainties: readonly GroundedClaimV1[];
}

export interface ProsConsPayloadV1 extends ProsConsCandidateV1 {
  readonly groundingDisclosure: EvidenceBundleV1['groundingDisclosure'];
  readonly limitations: readonly string[];
}

export interface ProsConsValidationPolicy {
  readonly contractLimits: ContractLimits;
  readonly supportedLanguages: readonly string[];
  readonly eligibleModerationStates: readonly string[];
  readonly eligiblePublicationStates: readonly string[];
  /** Exact allowlist is the unverified catalogue/rollout boundary; no category defaults are supplied. */
  readonly eligibleCategoryIds: readonly StableId[];
  readonly evidencePolicy: EvidenceSufficiencyPolicy;
  readonly artifactKeyPolicy: ArtifactKeyPolicy;
  readonly generationDefinitionVersion: string;
  readonly promptVersion: string;
  readonly outputSchemaVersion: number;
  readonly maxClaims: number;
  readonly maxCitationQuoteCodePoints: number;
  readonly maxClaimCodePoints: number;
  readonly minimumPros: number;
  readonly maximumPros: number;
  readonly minimumCons: number;
  readonly maximumCons: number;
  readonly minimumActions: number;
  readonly maximumActions: number;
  readonly minimumMitigations: number;
  readonly maximumMitigations: number;
  readonly minimumUncertainties: number;
  readonly maximumUncertainties: number;
}

export interface ProsConsGenerationPolicy extends ProsConsValidationPolicy {
  readonly retentionClass: string;
}

export interface ValidatedProsConsResult {
  readonly artifactKey: string;
  readonly payload: ProsConsPayloadV1;
  readonly citations: readonly Readonly<Record<string, unknown>>[];
  readonly groundingMode: EvidenceBundleV1['groundingMode'];
}

export interface ProsConsGenerationResult extends ValidatedProsConsResult {
  readonly version: number;
  readonly cacheHit: boolean;
}

export interface ProsConsGenerationDependencies {
  readonly authorizeCgService: () => Promise<boolean>;
  readonly loadEvidenceBundle: (post: CanonicalPostInputV1) => Promise<EvidenceBundleV1>;
  /** Resolves only owner-approved static guidance for this canonical persona ID/version. */
  readonly resolvePersonaInstruction: (preference: PreferenceInputV2) => string | null;
  readonly verifyCanonicalPreference: (preference: PreferenceInputV2) => boolean | Promise<boolean>;
  readonly validateLanguage: (text: string, language: string) => boolean | Promise<boolean>;
  /** Mandatory materiality, risk/counterpoint, nonpartisan and no-false-equivalence review gate. */
  readonly semanticReview: (candidate: ProsConsCandidateV1, post: CanonicalPostInputV1, preference: PreferenceInputV2) => boolean | Promise<boolean>;
  readonly generate: (request: StructuredGenerationRequest) => Promise<unknown>;
  /** Must be backed by distributed per-key coordination in production. */
  readonly runArtifactSingleFlight: <T>(artifactKey: string, work: () => Promise<T>) => Promise<T>;
  readonly now?: () => Date;
}

export type ProsConsFailureCode = 'unauthorized' | 'invalid_input' | 'ineligible' | 'invalid_evidence' | 'insufficient_evidence' | 'invalid_output' | 'unavailable';

/** Safe contract failure; never carries source, persona guidance or candidate text. */
export class ProsConsValidationError extends Error {
  readonly code: ProsConsFailureCode;
  constructor(code: ProsConsFailureCode) {
    super(`Pros/Cons generation failed (${code})`);
    this.name = 'ProsConsValidationError';
    this.code = code;
  }
}

const POLICY_FIELDS = [
  'contractLimits', 'supportedLanguages', 'eligibleModerationStates', 'eligiblePublicationStates', 'eligibleCategoryIds',
  'evidencePolicy', 'artifactKeyPolicy', 'generationDefinitionVersion', 'promptVersion', 'outputSchemaVersion',
  'maxClaims', 'maxCitationQuoteCodePoints', 'maxClaimCodePoints', 'minimumPros', 'maximumPros', 'minimumCons',
  'maximumCons', 'minimumActions', 'maximumActions', 'minimumMitigations', 'maximumMitigations',
  'minimumUncertainties', 'maximumUncertainties',
] as const;

function plainRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} must be a plain data record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !keys.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new Error(`${label} contains unsupported/accessor properties`);
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length > 0
      || Object.getOwnPropertyNames(value).length !== value.length + 1 || value.length > maxItems) {
    throw new Error(`${label} must be a bounded dense array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    if (!descriptors[String(index)]?.enumerable || !Object.hasOwn(descriptors[String(index)], 'value')) {
      throw new Error(`${label} contains a sparse or accessor element`);
    }
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Array.from(value).length > maximum) {
    throw new Error(`${label} is empty or exceeds its configured bound`);
  }
  return value;
}

function validatePolicy(policy: ProsConsValidationPolicy): ProsConsValidationPolicy {
  const record = plainRecord(policy, POLICY_FIELDS, 'Pros/Cons policy');
  if (Object.keys(record).length !== POLICY_FIELDS.length) throw new Error('Pros/Cons policy must be explicit and complete');
  const limits = plainRecord(record.contractLimits, [
    'maxStringCodePoints', 'maxArrayItems', 'maxPayloadBytes', 'maxContextItems', 'maxContextBytes',
  ], 'Pros/Cons contract limits');
  if (Object.keys(limits).length !== 5 || Object.values(limits).some((value) => !Number.isSafeInteger(value) || (value as number) <= 0)) {
    throw new Error('Pros/Cons contract limits must all be positive');
  }
  const maxArrayItems = limits.maxArrayItems as number;
  const stringArray = (value: unknown, label: string): readonly string[] => {
    const items = denseArray(value, label, maxArrayItems);
    if (items.length === 0 || items.some((item) => typeof item !== 'string' || item.trim().length === 0)
        || new Set(items).size !== items.length) throw new Error(`${label} must contain unique non-empty strings`);
    return Object.freeze([...items] as string[]);
  };
  const categories = denseArray(record.eligibleCategoryIds, 'eligibleCategoryIds', maxArrayItems);
  if (categories.length === 0 || new Set(categories.map((id) => `${typeof id}:${id}`)).size !== categories.length
      || categories.some((id) => !((typeof id === 'string' && id.trim().length > 0) || (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)))) {
    throw new Error('eligibleCategoryIds must be an explicit unique stable-ID allowlist');
  }
  const evidencePolicy = plainRecord(record.evidencePolicy, [
    'minimumEvidenceCodePoints', 'insufficientEvidenceAction', 'maxEvidenceItems', 'maxEvidenceTextCodePoints',
  ], 'Pros/Cons evidence policy');
  if (Object.keys(evidencePolicy).length !== 4 || !['partial', 'fail'].includes(String(evidencePolicy.insufficientEvidenceAction))) {
    throw new Error('Pros/Cons evidence sufficiency policy is incomplete');
  }
  for (const [key, value] of Object.entries(evidencePolicy)) {
    if (key !== 'insufficientEvidenceAction') positive(value, `evidencePolicy.${key}`);
  }
  if ((evidencePolicy.maxEvidenceItems as number) > maxArrayItems) throw new Error('evidence item bound exceeds contract array bound');
  const artifactKeyPolicy = plainRecord(record.artifactKeyPolicy, ['maxIdentifierCodePoints'], 'artifact key policy');
  if (Object.keys(artifactKeyPolicy).length !== 1) throw new Error('artifact key policy is incomplete');
  positive(artifactKeyPolicy.maxIdentifierCodePoints, 'artifactKeyPolicy.maxIdentifierCodePoints');
  const countFields = [
    'maxClaims', 'maxCitationQuoteCodePoints', 'maxClaimCodePoints', 'minimumPros', 'maximumPros', 'minimumCons',
    'maximumCons', 'minimumActions', 'maximumActions', 'minimumMitigations', 'maximumMitigations',
    'minimumUncertainties', 'maximumUncertainties',
  ] as const;
  const counts = Object.fromEntries(countFields.map((key) => [key, positive(record[key], key)])) as Record<typeof countFields[number], number>;
  if (counts.maxClaims > maxArrayItems || counts.maxCitationQuoteCodePoints > (limits.maxStringCodePoints as number)
      || counts.maxClaimCodePoints > (limits.maxStringCodePoints as number)
      || counts.maximumPros > maxArrayItems || counts.maximumCons > maxArrayItems
      || counts.maximumActions > maxArrayItems || counts.maximumMitigations > maxArrayItems
      || counts.maximumUncertainties > maxArrayItems
      || counts.minimumPros > counts.maximumPros || counts.minimumCons > counts.maximumCons
      || counts.minimumActions > counts.maximumActions || counts.minimumMitigations > counts.maximumMitigations
      || counts.minimumUncertainties > counts.maximumUncertainties
      || counts.maxClaims < 2 + counts.maximumPros + counts.maximumCons + counts.maximumActions
        + counts.maximumMitigations + counts.maximumUncertainties) {
    throw new Error('Pros/Cons count and text bounds are inconsistent');
  }
  const outputSchemaVersion = positive(record.outputSchemaVersion, 'outputSchemaVersion');
  if (outputSchemaVersion !== 1) throw new Error('only the explicitly implemented Pros/Cons output schema is supported');
  const generationDefinitionVersion = boundedText(record.generationDefinitionVersion, 'generationDefinitionVersion', limits.maxStringCodePoints as number);
  const promptVersion = boundedText(record.promptVersion, 'promptVersion', limits.maxStringCodePoints as number);
  return Object.freeze({
    contractLimits: Object.freeze({
      maxStringCodePoints: limits.maxStringCodePoints as number,
      maxArrayItems,
      maxPayloadBytes: limits.maxPayloadBytes as number,
      maxContextItems: limits.maxContextItems as number,
      maxContextBytes: limits.maxContextBytes as number,
    }),
    supportedLanguages: stringArray(record.supportedLanguages, 'supportedLanguages'),
    eligibleModerationStates: stringArray(record.eligibleModerationStates, 'eligibleModerationStates'),
    eligiblePublicationStates: stringArray(record.eligiblePublicationStates, 'eligiblePublicationStates'),
    eligibleCategoryIds: Object.freeze([...categories] as StableId[]),
    evidencePolicy: Object.freeze({
      minimumEvidenceCodePoints: evidencePolicy.minimumEvidenceCodePoints as number,
      insufficientEvidenceAction: evidencePolicy.insufficientEvidenceAction as 'partial' | 'fail',
      maxEvidenceItems: evidencePolicy.maxEvidenceItems as number,
      maxEvidenceTextCodePoints: evidencePolicy.maxEvidenceTextCodePoints as number,
    }),
    artifactKeyPolicy: Object.freeze({ maxIdentifierCodePoints: artifactKeyPolicy.maxIdentifierCodePoints as number }),
    generationDefinitionVersion,
    promptVersion,
    outputSchemaVersion,
    ...counts,
  });
}

function samePost(bundle: EvidenceBundleV1, post: CanonicalPostInputV1): boolean {
  const version = post.postContentVersion !== undefined
    ? { kind: 'postContentVersion', value: post.postContentVersion }
    : post.contentHash !== undefined ? { kind: 'contentHash', value: post.contentHash } : null;
  return version !== null && bundle.post.postId === post.postId && bundle.post.version.kind === version.kind
    && bundle.post.version.value === version.value && bundle.post.language === post.language
    && (bundle.post.contentHash === undefined || bundle.post.contentHash === post.contentHash);
}

function duplicateSignature(text: string, language: string): string {
  return [...new Set(text.normalize('NFKC').toLocaleLowerCase(language).match(/[\p{L}\p{N}]+/gu) ?? [])]
    .sort().join('\u0000');
}

function readClaim(value: unknown, label: string, policy: ProsConsValidationPolicy): GroundedClaimV1 {
  const claim = plainRecord(value, ['text', 'citations'], label);
  if (Object.keys(claim).length !== 2) throw new ProsConsValidationError('invalid_output');
  const text = boundedText(claim.text, `${label}.text`, policy.maxClaimCodePoints);
  const rawCitations = denseArray(claim.citations, `${label}.citations`, policy.contractLimits.maxArrayItems);
  const citations = rawCitations.map((citationValue, index) => {
    const citation = plainRecord(citationValue, ['evidenceId', 'quote'], `${label}.citations[${index}]`);
    if (Object.keys(citation).length !== 2) throw new ProsConsValidationError('invalid_output');
    return Object.freeze({
      evidenceId: boundedText(citation.evidenceId, 'citation evidence ID', policy.contractLimits.maxStringCodePoints),
      quote: boundedText(citation.quote, 'citation quote', policy.maxCitationQuoteCodePoints),
    });
  });
  return Object.freeze({ text, citations: Object.freeze(citations) });
}

function readClaimList(
  value: unknown,
  label: string,
  minItems: number,
  maxItems: number,
  language: string,
  policy: ProsConsValidationPolicy,
): readonly GroundedClaimV1[] {
  const rawItems = denseArray(value, label, maxItems);
  if (rawItems.length < minItems || rawItems.length > maxItems) throw new ProsConsValidationError('invalid_output');
  const items = rawItems.map((item, index) => readClaim(item, `${label}[${index}]`, policy));
  const signatures = items.map(({ text }) => duplicateSignature(text, language));
  if (signatures.some((signature) => !signature) || new Set(signatures).size !== signatures.length) {
    throw new ProsConsValidationError('invalid_output');
  }
  return Object.freeze(items);
}

function flattenClaims(candidate: ProsConsCandidateV1): GroundedClaimV1[] {
  return [candidate.executiveDigest, candidate.personaRelevance, ...candidate.pros, ...candidate.cons,
    ...candidate.actions, ...candidate.mitigations, ...candidate.uncertainties];
}

function flattenCitations(candidate: ProsConsCandidateV1): readonly Readonly<Record<string, unknown>>[] {
  const citations: Readonly<Record<string, unknown>>[] = [];
  const groups: readonly [string, readonly GroundedClaimV1[]][] = [
    ['executive_digest', [candidate.executiveDigest]], ['persona_relevance', [candidate.personaRelevance]],
    ['pro', candidate.pros], ['con', candidate.cons], ['action', candidate.actions],
    ['mitigation', candidate.mitigations], ['uncertainty', candidate.uncertainties],
  ];
  for (const [kind, claims] of groups) {
    for (const [claimIndex, claim] of claims.entries()) {
      for (const citation of claim.citations) citations.push(Object.freeze({ kind, claimIndex, ...citation }));
    }
  }
  return Object.freeze(citations);
}

/** Strict pre-publication contract for schema, exact quotations and numbers; semantics remain separately reviewed. */
export async function validateProsConsCandidate(
  rawPost: unknown,
  rawPreference: unknown,
  rawBundle: EvidenceBundleV1,
  rawCandidate: unknown,
  rawPolicy: ProsConsValidationPolicy,
  dependencies: {
    readonly verifyCanonicalPreference: (preference: PreferenceInputV2) => boolean | Promise<boolean>;
    readonly validateLanguage: (text: string, language: string) => boolean | Promise<boolean>;
    /** Must review materiality, counterpoints, nonpartisan posture and false-equivalence risks. */
    readonly semanticReview: (candidate: ProsConsCandidateV1, post: CanonicalPostInputV1, preference: PreferenceInputV2) => boolean | Promise<boolean>;
  },
): Promise<ValidatedProsConsResult> {
  let policy: ProsConsValidationPolicy;
  let post: CanonicalPostInputV1;
  let preference: PreferenceInputV2;
  try {
    policy = validatePolicy(rawPolicy);
    post = validateCanonicalPostInput(rawPost, policy.contractLimits, policy.supportedLanguages);
    preference = validatePreferenceInput(rawPreference, policy.contractLimits);
  } catch {
    throw new ProsConsValidationError('invalid_input');
  }
  try {
    if (typeof dependencies?.verifyCanonicalPreference !== 'function'
        || typeof dependencies.validateLanguage !== 'function' || typeof dependencies.semanticReview !== 'function'
        || await dependencies.verifyCanonicalPreference(preference) !== true) {
      throw new ProsConsValidationError('invalid_input');
    }
  } catch (error) {
    if (error instanceof ProsConsValidationError) throw error;
    throw new ProsConsValidationError('invalid_input');
  }
  if (!policy.eligibleModerationStates.includes(post.moderationState)
      || !policy.eligiblePublicationStates.includes(post.publicationState)
      || !policy.eligibleCategoryIds.some((id) => id === post.categoryId)) {
    throw new ProsConsValidationError('ineligible');
  }

  let preparation: ReturnType<typeof prepareGenerationEvidence>;
  try {
    if (!samePost(rawBundle, post)) throw new Error('evidence version mismatch');
    preparation = prepareGenerationEvidence('pros_cons', rawBundle, [], policy.contractLimits, policy.evidencePolicy);
  } catch {
    throw new ProsConsValidationError('invalid_evidence');
  }
  if (preparation.outcome === 'failed' || preparation.prompt === null) {
    throw new ProsConsValidationError('insufficient_evidence');
  }

  let candidate: ProsConsCandidateV1;
  try {
    const root = plainRecord(rawCandidate, [
      'schemaVersion', 'outputLanguage', 'personaId', 'executiveDigest', 'personaRelevance', 'pros', 'cons',
      'actions', 'mitigations', 'uncertainties',
    ], 'Pros/Cons output');
    if (Object.keys(root).length !== 10 || root.schemaVersion !== policy.outputSchemaVersion
        || root.outputLanguage !== post.language || root.personaId !== preference.personaId) {
      throw new ProsConsValidationError('invalid_output');
    }
    const language = post.language;
    candidate = Object.freeze({
      schemaVersion: 1,
      outputLanguage: language,
      personaId: preference.personaId,
      executiveDigest: readClaim(root.executiveDigest, 'executiveDigest', policy),
      personaRelevance: readClaim(root.personaRelevance, 'personaRelevance', policy),
      pros: readClaimList(root.pros, 'pros', policy.minimumPros, policy.maximumPros, language, policy),
      cons: readClaimList(root.cons, 'cons', policy.minimumCons, policy.maximumCons, language, policy),
      actions: readClaimList(root.actions, 'actions', policy.minimumActions, policy.maximumActions, language, policy),
      mitigations: readClaimList(root.mitigations, 'mitigations', policy.minimumMitigations, policy.maximumMitigations, language, policy),
      uncertainties: readClaimList(root.uncertainties, 'uncertainties', policy.minimumUncertainties, policy.maximumUncertainties, language, policy),
    });
    const sideKeys = [
      ...candidate.pros.map(({ text }) => duplicateSignature(text, language)),
      ...candidate.cons.map(({ text }) => duplicateSignature(text, language)),
    ];
    if (new Set(sideKeys).size !== sideKeys.length) throw new ProsConsValidationError('invalid_output');
    const claims = flattenClaims(candidate);
    if (claims.length > policy.maxClaims) throw new ProsConsValidationError('invalid_output');
    const citationValidation = validateGroundedClaims(claims, rawBundle, {
      maxCitationClaims: policy.maxClaims,
      maxCitationQuoteCodePoints: policy.maxCitationQuoteCodePoints,
      contractLimits: policy.contractLimits,
    });
    const languageValid = await Promise.all(claims.map(({ text }) => dependencies.validateLanguage(text, post.language)))
      .then((results) => results.every((result) => result === true));
    if (!citationValidation.valid || !languageValid
        || await dependencies.semanticReview(candidate, post, preference) !== true) {
      throw new ProsConsValidationError('invalid_output');
    }
  } catch (error) {
    if (error instanceof ProsConsValidationError) throw error;
    throw new ProsConsValidationError('invalid_output');
  }

  const key = createProsConsArtifactKey({
    postId: post.postId,
    ...(post.postContentVersion === undefined ? {} : { postContentVersion: post.postContentVersion }),
    ...(post.contentHash === undefined ? {} : { contentHash: post.contentHash }),
    evidence: rawBundle.groundingMode === 'cg_plus_source'
      ? { availability: 'available', evidenceVersion: rawBundle.bundleHash }
      : { availability: 'unavailable' },
    outputLanguage: post.language,
    generationDefinitionVersion: policy.generationDefinitionVersion,
    promptVersion: policy.promptVersion,
    schemaVersion: policy.outputSchemaVersion,
    personaId: preference.personaId,
    personaDefinitionVersion: preference.personaDefinitionVersion,
    interestTaxonomyVersion: preference.interestTaxonomyVersion,
    interestIds: preference.selectedInterests.map(({ id }) => id),
  }, policy.artifactKeyPolicy);
  const payload: ProsConsPayloadV1 = Object.freeze({
    ...candidate,
    groundingDisclosure: preparation.disclosure,
    limitations: Object.freeze([...rawBundle.limitations]),
  });
  return Object.freeze({ artifactKey: key, payload, citations: flattenCitations(candidate), groundingMode: preparation.groundingMode });
}

const PROS_CONS_CANDIDATE_FIELDS = [
  'schemaVersion', 'outputLanguage', 'personaId', 'executiveDigest', 'personaRelevance', 'pros', 'cons',
  'actions', 'mitigations', 'uncertainties',
] as const;

function candidateFromStoredPayload(value: unknown): unknown {
  const allowed = [...PROS_CONS_CANDIDATE_FIELDS, 'groundingDisclosure', 'limitations'];
  const payload = plainRecord(value, allowed, 'stored Pros/Cons payload');
  if (Object.keys(payload).length !== allowed.length) throw new ProsConsValidationError('invalid_output');
  const candidate: Record<string, unknown> = {};
  for (const key of PROS_CONS_CANDIDATE_FIELDS) candidate[key] = payload[key];
  return candidate;
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
  }
  return value;
}

function buildProsConsOutputSchema(policy: ProsConsValidationPolicy): Readonly<Record<string, unknown>> {
  const claim = {
    type: 'object', additionalProperties: false, required: ['text', 'citations'],
    properties: {
      text: { type: 'string', minLength: 1, maxLength: policy.maxClaimCodePoints },
      citations: {
        type: 'array', minItems: 1, maxItems: policy.contractLimits.maxArrayItems,
        items: {
          type: 'object', additionalProperties: false, required: ['evidenceId', 'quote'],
          properties: {
            evidenceId: { type: 'string', minLength: 1 },
            quote: { type: 'string', minLength: 1, maxLength: policy.maxCitationQuoteCodePoints },
          },
        },
      },
    },
  };
  const list = (minItems: number, maxItems: number) => ({ type: 'array', minItems, maxItems, items: claim });
  return freezeTree({
    type: 'object', additionalProperties: false,
    required: [...PROS_CONS_CANDIDATE_FIELDS],
    properties: {
      schemaVersion: { const: 1 },
      outputLanguage: { type: 'string' },
      personaId: { type: 'string' },
      executiveDigest: claim,
      personaRelevance: claim,
      pros: list(policy.minimumPros, policy.maximumPros),
      cons: list(policy.minimumCons, policy.maximumCons),
      actions: list(policy.minimumActions, policy.maximumActions),
      mitigations: list(policy.minimumMitigations, policy.maximumMitigations),
      uncertainties: list(policy.minimumUncertainties, policy.maximumUncertainties),
    },
  });
}

export class ProsConsGenerationService {
  private readonly persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>;
  private readonly policy: ProsConsValidationPolicy;
  private readonly retentionClass: string;
  private readonly dependencies: ProsConsGenerationDependencies;

  constructor(
    persistence: Pick<TiPersistence, 'getArtifact' | 'publishArtifact'>,
    policy: ProsConsGenerationPolicy,
    dependencies: ProsConsGenerationDependencies,
  ) {
    const record = plainRecord(policy, [...POLICY_FIELDS, 'retentionClass'], 'Pros/Cons generation policy');
    if (Object.keys(record).length !== POLICY_FIELDS.length + 1) throw new Error('Pros/Cons generation policy must include retentionClass');
    const { retentionClass: rawRetentionClass, ...validationPolicy } = record;
    this.policy = validatePolicy(validationPolicy as unknown as ProsConsValidationPolicy);
    const retentionClass = boundedText(rawRetentionClass, 'retentionClass', this.policy.contractLimits.maxStringCodePoints);
    if (!dependencies || typeof dependencies.authorizeCgService !== 'function'
        || typeof dependencies.loadEvidenceBundle !== 'function' || typeof dependencies.resolvePersonaInstruction !== 'function'
        || typeof dependencies.verifyCanonicalPreference !== 'function' || typeof dependencies.validateLanguage !== 'function'
        || typeof dependencies.semanticReview !== 'function' || typeof dependencies.generate !== 'function'
        || typeof dependencies.runArtifactSingleFlight !== 'function') {
      throw new Error('Pros/Cons service requires explicit authorization, canonical preference, evidence, safety, generation and lease dependencies');
    }
    this.persistence = persistence;
    this.retentionClass = retentionClass;
    this.dependencies = dependencies;
  }

  async generate(rawInput: unknown): Promise<ProsConsGenerationResult> {
    let authorized = false;
    try { authorized = await this.dependencies.authorizeCgService(); } catch { /* fail closed */ }
    if (authorized !== true) throw new ProsConsValidationError('unauthorized');

    let post: CanonicalPostInputV1;
    let preference: PreferenceInputV2;
    try {
      const envelope = plainRecord(rawInput, ['canonicalPost', 'preferences'], 'Pros/Cons request');
      if (Object.keys(envelope).length !== 2) throw new Error('request envelope is incomplete');
      post = validateCanonicalPostInput(envelope.canonicalPost, this.policy.contractLimits, this.policy.supportedLanguages);
      preference = validatePreferenceInput(envelope.preferences, this.policy.contractLimits);
    } catch {
      throw new ProsConsValidationError('invalid_input');
    }
    if (!this.policy.eligibleModerationStates.includes(post.moderationState)
        || !this.policy.eligiblePublicationStates.includes(post.publicationState)
        || !this.policy.eligibleCategoryIds.some((id) => id === post.categoryId)) {
      throw new ProsConsValidationError('ineligible');
    }

    let preferenceVerified: boolean;
    let personaInstruction: string | null;
    try {
      preferenceVerified = await this.dependencies.verifyCanonicalPreference(preference);
      personaInstruction = this.dependencies.resolvePersonaInstruction(preference);
    } catch {
      throw new ProsConsValidationError('invalid_input');
    }
    if (preferenceVerified !== true || typeof personaInstruction !== 'string' || personaInstruction.trim().length === 0
        || Array.from(personaInstruction).length > this.policy.contractLimits.maxStringCodePoints) {
      throw new ProsConsValidationError('invalid_input');
    }

    let bundle: EvidenceBundleV1;
    let preparation: ReturnType<typeof prepareGenerationEvidence>;
    try {
      bundle = await this.dependencies.loadEvidenceBundle(post);
      if (!samePost(bundle, post)) throw new Error('evidence is not bound to the requested post version');
      preparation = prepareGenerationEvidence('pros_cons', bundle, [], this.policy.contractLimits, this.policy.evidencePolicy);
    } catch {
      throw new ProsConsValidationError('invalid_evidence');
    }

    let artifactKey: string;
    try {
      artifactKey = createProsConsArtifactKey({
        postId: post.postId,
        ...(post.postContentVersion === undefined ? {} : { postContentVersion: post.postContentVersion }),
        ...(post.contentHash === undefined ? {} : { contentHash: post.contentHash }),
        evidence: bundle.groundingMode === 'cg_plus_source'
          ? { availability: 'available', evidenceVersion: bundle.bundleHash }
          : { availability: 'unavailable' },
        outputLanguage: post.language,
        generationDefinitionVersion: this.policy.generationDefinitionVersion,
        promptVersion: this.policy.promptVersion,
        schemaVersion: this.policy.outputSchemaVersion,
        personaId: preference.personaId,
        personaDefinitionVersion: preference.personaDefinitionVersion,
        interestTaxonomyVersion: preference.interestTaxonomyVersion,
        interestIds: preference.selectedInterests.map(({ id }) => id),
      }, this.policy.artifactKeyPolicy);
      return await this.dependencies.runArtifactSingleFlight(artifactKey, () =>
        this.generateAndPublish(artifactKey, post, preference, personaInstruction!, bundle, preparation));
    } catch (error) {
      if (error instanceof ProsConsValidationError) throw error;
      throw new ProsConsValidationError('unavailable');
    }
  }

  private async generateAndPublish(
    artifactKey: string,
    post: CanonicalPostInputV1,
    preference: PreferenceInputV2,
    personaInstruction: string,
    bundle: EvidenceBundleV1,
    preparation: ReturnType<typeof prepareGenerationEvidence>,
  ): Promise<ProsConsGenerationResult> {
    try {
      const cached = await this.persistence.getArtifact(artifactKey);
      const hit = await this.readReadyCache(cached, artifactKey, post, preference, bundle);
      if (hit && cached) return Object.freeze({ ...hit, version: cached.version, cacheHit: true });
      if (preparation.outcome === 'failed' || preparation.prompt === null) {
        throw new ProsConsValidationError('insufficient_evidence');
      }
      const request: StructuredGenerationRequest = Object.freeze({
        operationKind: 'pros_cons',
        correlationId: randomUUID(),
        outputLanguage: post.language,
        schemaVersion: this.policy.outputSchemaVersion,
        trustedInstruction: `${preparation.prompt.trustedInstruction}\n${personaInstruction}`,
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
          canonicalPreference: Object.freeze({
            personaId: preference.personaId,
            personaDefinitionVersion: preference.personaDefinitionVersion,
            interestTaxonomyVersion: preference.interestTaxonomyVersion,
            interestIds: Object.freeze(preference.selectedInterests.map(({ id }) => id)),
          }),
          evidenceJson: preparation.prompt.evidenceJson,
        }),
        outputSchema: buildProsConsOutputSchema(this.policy),
      });
      if (Buffer.byteLength(JSON.stringify(request), 'utf8') > this.policy.contractLimits.maxPayloadBytes) {
        throw new ProsConsValidationError('invalid_input');
      }
      const rawCandidate = await this.dependencies.generate(request);
      const validated = await validateProsConsCandidate(post, preference, bundle, rawCandidate, this.policy, {
        verifyCanonicalPreference: this.dependencies.verifyCanonicalPreference,
        validateLanguage: this.dependencies.validateLanguage,
        semanticReview: this.dependencies.semanticReview,
      });
      const payload = Object.freeze({ ...validated.payload });
      const artifact: ArtifactInput = {
        artifactKey,
        artifactType: 'persona_implications',
        postId: post.postId,
        ...(post.postContentVersion === undefined ? {} : { postContentVersion: post.postContentVersion }),
        ...(post.contentHash === undefined ? {} : { contentHash: post.contentHash }),
        outputLanguage: post.language,
        payload,
        groundingMode: validated.groundingMode,
        citations: [...validated.citations],
        limitations: [...validated.payload.limitations],
        schemaVersion: this.policy.outputSchemaVersion,
        promptVersion: this.policy.promptVersion,
        moderationState: post.moderationState,
        status: 'ready',
        retentionClass: this.retentionClass,
        ...(this.dependencies.now ? { createdAt: this.dependencies.now() } : {}),
      };
      const version = await this.persistence.publishArtifact(artifact);
      return Object.freeze({ ...validated, version, cacheHit: false });
    } catch (error) {
      if (error instanceof ProsConsValidationError) throw error;
      throw new ProsConsValidationError('unavailable');
    }
  }

  private async readReadyCache(
    cached: PersistedArtifact | null,
    artifactKey: string,
    post: CanonicalPostInputV1,
    preference: PreferenceInputV2,
    bundle: EvidenceBundleV1,
  ): Promise<ValidatedProsConsResult | null> {
    if (!cached || cached.artifactKey !== artifactKey || cached.artifactType !== 'persona_implications'
        || cached.status !== 'ready' || cached.moderationState !== post.moderationState || cached.postId !== post.postId
        || cached.postContentVersion !== post.postContentVersion || cached.contentHash !== post.contentHash
        || cached.outputLanguage !== post.language || cached.schemaVersion !== this.policy.outputSchemaVersion
        || cached.promptVersion !== this.policy.promptVersion || cached.groundingMode !== bundle.groundingMode) return null;
    try {
      const payload = plainRecord(cached.payload,
        [...PROS_CONS_CANDIDATE_FIELDS, 'groundingDisclosure', 'limitations'], 'cached Pros/Cons payload');
      if (payload.groundingDisclosure !== bundle.groundingDisclosure || !Array.isArray(payload.limitations)
          || JSON.stringify(payload.limitations) !== JSON.stringify(bundle.limitations)) return null;
      const validated = await validateProsConsCandidate(post, preference, bundle, candidateFromStoredPayload(cached.payload), this.policy, {
        verifyCanonicalPreference: this.dependencies.verifyCanonicalPreference,
        validateLanguage: this.dependencies.validateLanguage,
        semanticReview: this.dependencies.semanticReview,
      });
      return Object.freeze({ ...validated, artifactKey });
    } catch {
      return null;
    }
  }
}
