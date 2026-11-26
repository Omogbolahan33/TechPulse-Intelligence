import { createHash } from 'node:crypto';
import { APPROVED_PERSONA_IDS, type PersonaId, type StableId } from './contracts';

export const CANONICAL_ARTIFACT_KEY_VERSION = 1 as const;

/** Bounds are explicit caller configuration; key construction has no hidden runtime defaults. */
export interface CacheKeyLimits {
  readonly maxStringCodePoints: number;
  readonly maxInterestIds: number;
  readonly maxSerializedIdentityBytes: number;
}

export type EvidenceVersionIdentity =
  | { readonly kind: 'versioned'; readonly version: StableId }
  | { readonly kind: 'unavailable' };

interface SharedArtifactKeyInput {
  readonly postId: string;
  readonly postContentVersion?: StableId;
  readonly contentHash?: string;
  readonly evidence: EvidenceVersionIdentity;
  readonly outputLanguage: string;
  readonly generationDefinitionVersion: string;
  readonly promptVersion: string;
  readonly outputSchemaVersion: string;
}

export interface SummaryArtifactKeyInput extends SharedArtifactKeyInput {}

export interface ProsConsArtifactKeyInput extends SharedArtifactKeyInput {
  readonly personaId: PersonaId;
  readonly personaDefinitionVersion: string;
  readonly interestTaxonomyVersion: string;
  readonly interestIds: readonly string[];
}

const stableId = (value: unknown, path: string, maxCodePoints: number): StableId => {
  if (typeof value === 'string') return boundedString(value, path, maxCodePoints);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`${path} must be a non-empty string or a non-negative safe integer`);
};

const boundedString = (value: unknown, path: string, maxCodePoints: number): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
  if (Array.from(value).length > maxCodePoints) throw new Error(`${path} exceeds the configured string bound`);
  return value;
};

const validateLimits = (limits: CacheKeyLimits): void => {
  for (const name of ['maxStringCodePoints', 'maxInterestIds', 'maxSerializedIdentityBytes'] as const) {
    if (!Number.isSafeInteger(limits?.[name]) || limits[name] <= 0) {
      throw new Error(`limits.${name} must be a positive safe integer`);
    }
  }
};

const assertExactKeys = (value: unknown, required: readonly string[], optional: readonly string[], path: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  for (const key of required) if (!Object.hasOwn(record, key)) throw new Error(`${path}.${key} is required`);
  return record;
};

const canonicalEvidence = (value: unknown, maxCodePoints: number): readonly unknown[] => {
  const evidence = assertExactKeys(value, ['kind'], ['version'], 'evidence');
  if (evidence.kind === 'unavailable') {
    if (Object.hasOwn(evidence, 'version')) throw new Error('evidence.version is not allowed when kind is unavailable');
    return ['unavailable'];
  }
  if (evidence.kind === 'versioned') {
    if (!Object.hasOwn(evidence, 'version')) throw new Error('evidence.version is required when kind is versioned');
    return ['versioned', stableId(evidence.version, 'evidence.version', maxCodePoints)];
  }
  throw new Error('evidence.kind must be versioned or unavailable');
};

const canonicalSharedFields = (input: unknown, limits: CacheKeyLimits, extras: readonly string[] = []) => {
  const value = assertExactKeys(input, [
    'postId', 'evidence', 'outputLanguage', 'generationDefinitionVersion', 'promptVersion', 'outputSchemaVersion',
  ], ['postContentVersion', 'contentHash', ...extras], 'artifactKeyInput');
  const postId = boundedString(value.postId, 'postId', limits.maxStringCodePoints);
  const hasPostVersion = Object.hasOwn(value, 'postContentVersion');
  const hasContentHash = Object.hasOwn(value, 'contentHash');
  if (!hasPostVersion && !hasContentHash) throw new Error('postContentVersion or contentHash is required');
  const postVersion = hasPostVersion ? stableId(value.postContentVersion, 'postContentVersion', limits.maxStringCodePoints) : null;
  const contentHash = hasContentHash ? boundedString(value.contentHash, 'contentHash', limits.maxStringCodePoints) : null;
  const evidence = canonicalEvidence(value.evidence, limits.maxStringCodePoints);
  const outputLanguage = boundedString(value.outputLanguage, 'outputLanguage', limits.maxStringCodePoints);
  const generationDefinitionVersion = boundedString(value.generationDefinitionVersion, 'generationDefinitionVersion', limits.maxStringCodePoints);
  const promptVersion = boundedString(value.promptVersion, 'promptVersion', limits.maxStringCodePoints);
  const outputSchemaVersion = boundedString(value.outputSchemaVersion, 'outputSchemaVersion', limits.maxStringCodePoints);
  return {
    value,
    identity: [
      CANONICAL_ARTIFACT_KEY_VERSION,
      postId,
      ['post-version', postVersion],
      ['content-hash', contentHash],
      evidence,
      outputLanguage,
      generationDefinitionVersion,
      promptVersion,
      outputSchemaVersion,
    ] as const,
  };
};

const keyDigest = (kind: 'summary' | 'pros_cons', identity: readonly unknown[], limits: CacheKeyLimits): string => {
  const serialized = JSON.stringify(['ti-artifact-cache-key', kind, ...identity]);
  if (Buffer.byteLength(serialized, 'utf8') > limits.maxSerializedIdentityBytes) {
    throw new Error('serialized artifact identity exceeds the configured byte bound');
  }
  return `ti:v${CANONICAL_ARTIFACT_KEY_VERSION}:${kind}:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
};

export function buildSummaryArtifactKey(input: SummaryArtifactKeyInput, limits: CacheKeyLimits): string {
  validateLimits(limits);
  const canonical = canonicalSharedFields(input, limits);
  return keyDigest('summary', canonical.identity, limits);
}

export function buildProsConsArtifactKey(input: ProsConsArtifactKeyInput, limits: CacheKeyLimits): string {
  validateLimits(limits);
  const canonical = canonicalSharedFields(input, limits, [
    'personaId', 'personaDefinitionVersion', 'interestTaxonomyVersion', 'interestIds',
  ]);
  const { value } = canonical;
  if (!(APPROVED_PERSONA_IDS as readonly string[]).includes(value.personaId as string)) {
    throw new Error('personaId is not an approved persona');
  }
  const personaId = value.personaId as string;
  const personaDefinitionVersion = boundedString(value.personaDefinitionVersion, 'personaDefinitionVersion', limits.maxStringCodePoints);
  const interestTaxonomyVersion = boundedString(value.interestTaxonomyVersion, 'interestTaxonomyVersion', limits.maxStringCodePoints);
  if (!Array.isArray(value.interestIds)) throw new Error('interestIds must be an array');
  if (value.interestIds.length > limits.maxInterestIds) throw new Error('interestIds exceeds the configured item bound');
  const interests = value.interestIds.map((id, index) => boundedString(id, `interestIds[${index}]`, limits.maxStringCodePoints));
  if (new Set(interests).size !== interests.length) throw new Error('interestIds must contain unique stable IDs');
  const sortedInterests = [...interests].sort();
  // The unhashed interest identifiers never appear in the shared artifact key.
  const interestSetHash = createHash('sha256')
    .update(JSON.stringify(['ti-interest-set', CANONICAL_ARTIFACT_KEY_VERSION, sortedInterests]), 'utf8')
    .digest('hex');
  return keyDigest('pros_cons', [
    ...canonical.identity,
    personaId,
    personaDefinitionVersion,
    interestTaxonomyVersion,
    interestSetHash,
  ], limits);
}
