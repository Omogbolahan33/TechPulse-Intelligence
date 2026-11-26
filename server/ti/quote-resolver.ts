import {
  mapCanonicalCgQuoteSnapshotToTi,
  validateCanonicalPostInput,
  type CanonicalPostInputV1,
  type ContractLimits,
  type StableId,
  type TiMappedCgQuoteV2,
} from './contracts';
import {
  assessEvidenceSufficiency,
  prepareGenerationEvidence,
  type EvidenceBundleV1,
  type EvidenceSufficiencyPolicy,
} from './evidence';

export type ExactSnapshotUnavailableReason = 'missing' | 'hidden' | 'deleted' | 'tombstoned' | 'not_retained';

export type ExactPostSnapshotLookup =
  | { readonly status: 'unavailable'; readonly reason: ExactSnapshotUnavailableReason }
  | {
      readonly status: 'available';
      readonly canonicalPost: unknown;
      readonly evidenceBundle: EvidenceBundleV1 | null;
      /** Current version reference only. Current content is never substituted into quoted facts. */
      readonly currentPostContentVersion: StableId | null;
    };

export type ExactInsightSnapshotLookup =
  | { readonly status: 'unavailable'; readonly reason: ExactSnapshotUnavailableReason }
  | {
      readonly status: 'available';
      readonly artifactId: string;
      readonly artifactVersion: string;
      readonly itemId: string;
      readonly content: string;
      readonly language: string;
      readonly parentPostId: string;
      readonly parentPostContentVersion: StableId | null;
      readonly evidenceBundle: EvidenceBundleV1 | null;
      readonly currentArtifactVersion: string | null;
    };

export interface QuoteResolutionPolicy {
  readonly contractLimits: ContractLimits;
  readonly supportedLanguages: readonly string[];
  readonly evidencePolicy: EvidenceSufficiencyPolicy;
}

export interface QuoteResolutionDependencies {
  /** Must authenticate the caller as the CG service before any quote lookup. */
  readonly authorizeCgService: () => Promise<boolean>;
  /** Must resolve exactly the requested historical version and its evidence, not the current post. */
  readonly loadExactPostSnapshot: (postId: string, version: StableId | null, contentHash?: string) => Promise<ExactPostSnapshotLookup>;
  /** Must resolve the exact immutable artifact version and item, including its linked evidence. */
  readonly loadExactInsightSnapshot: (artifactId: string, artifactVersion: string, itemId: string) => Promise<ExactInsightSnapshotLookup>;
}

export interface ResolvedPostQuoteV1 {
  readonly type: 'cg_post';
  readonly quoteId: string;
  readonly postId: string;
  readonly quotedVersion: { readonly kind: 'postContentVersion' | 'contentHash'; readonly value: StableId };
  readonly language: string;
  readonly title: string;
  readonly content: string;
  readonly evidence: EvidenceBundleV1;
  readonly currentVersion: StableId | null;
  readonly currentVersionDiffers: boolean | null;
}

export interface ResolvedInsightQuoteV1 {
  readonly type: 'intelligence_insight';
  readonly quoteId: string;
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly itemId: string;
  readonly language: string;
  readonly content: string;
  readonly parentPostId: string;
  readonly parentPostContentVersion: StableId | null;
  readonly evidence: EvidenceBundleV1;
  readonly currentArtifactVersion: string | null;
  readonly currentVersionDiffers: boolean | null;
}

export type ResolvedQuoteV1 = ResolvedPostQuoteV1 | ResolvedInsightQuoteV1;
export type QuoteResolutionResult =
  | { readonly status: 'none' }
  | { readonly status: 'unavailable'; readonly limitation: 'quote_snapshot_unavailable' | 'quote_evidence_unavailable' }
  | { readonly status: 'resolved'; readonly quote: ResolvedQuoteV1 };

export type QuoteResolutionFailureCode = 'unauthorized' | 'invalid_request';

/** Publicly safe failure: details about other snapshots are never enumerated. */
export class QuoteResolutionError extends Error {
  readonly code: QuoteResolutionFailureCode;
  constructor(code: QuoteResolutionFailureCode) {
    super(`Quote resolution failed (${code})`);
    this.name = 'QuoteResolutionError';
    this.code = code;
  }
}

const LIMIT_KEYS = ['maxStringCodePoints', 'maxArrayItems', 'maxPayloadBytes', 'maxContextItems', 'maxContextBytes'] as const;

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} must be a plain data record`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !keys.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new Error(`${label} contains unsupported or accessor fields`);
  }
  return value as Record<string, unknown>;
}

function boundedPolicy(input: QuoteResolutionPolicy): QuoteResolutionPolicy {
  const policy = strictRecord(input, ['contractLimits', 'supportedLanguages', 'evidencePolicy'], 'quote policy');
  if (Object.keys(policy).length !== 3) throw new Error('quote policy is incomplete');
  const limits = strictRecord(policy.contractLimits, LIMIT_KEYS, 'contract limits');
  if (Object.keys(limits).length !== LIMIT_KEYS.length
      || Object.values(limits).some((value) => !Number.isSafeInteger(value) || (value as number) <= 0)) {
    throw new Error('quote contract limits must be explicit positive safe integers');
  }
  const languages = policy.supportedLanguages;
  if (!Array.isArray(languages) || languages.length === 0
      || Object.getOwnPropertyNames(languages).length !== languages.length + 1
      || Object.getOwnPropertySymbols(languages).length > 0
      || Object.keys(languages).length !== languages.length
      || languages.some((value) => typeof value !== 'string' || value.trim().length === 0)
      || new Set(languages).size !== languages.length) throw new Error('quote supportedLanguages must be a dense unique allowlist');
  const evidence = strictRecord(policy.evidencePolicy, [
    'minimumEvidenceCodePoints', 'insufficientEvidenceAction', 'maxEvidenceItems', 'maxEvidenceTextCodePoints',
  ], 'evidence policy');
  if (Object.keys(evidence).length !== 4 || !['partial', 'fail'].includes(String(evidence.insufficientEvidenceAction))
      || ['minimumEvidenceCodePoints', 'maxEvidenceItems', 'maxEvidenceTextCodePoints'].some((key) =>
        !Number.isSafeInteger(evidence[key]) || (evidence[key] as number) <= 0)) {
    throw new Error('quote evidence policy is incomplete');
  }
  return Object.freeze({
    contractLimits: Object.freeze({
      maxStringCodePoints: limits.maxStringCodePoints as number,
      maxArrayItems: limits.maxArrayItems as number,
      maxPayloadBytes: limits.maxPayloadBytes as number,
      maxContextItems: limits.maxContextItems as number,
      maxContextBytes: limits.maxContextBytes as number,
    }),
    supportedLanguages: Object.freeze([...languages] as string[]),
    evidencePolicy: Object.freeze({
      minimumEvidenceCodePoints: evidence.minimumEvidenceCodePoints as number,
      insufficientEvidenceAction: evidence.insufficientEvidenceAction as 'partial' | 'fail',
      maxEvidenceItems: evidence.maxEvidenceItems as number,
      maxEvidenceTextCodePoints: evidence.maxEvidenceTextCodePoints as number,
    }),
  });
}

function normalizeQuote(raw: unknown, policy: QuoteResolutionPolicy): TiMappedCgQuoteV2 {
  const quote = strictRecord(raw, ['quoteId', 'parentPostId', 'parentPostContentVersion', 'snapshot'], 'TI quote');
  if (Object.keys(quote).length !== 4) throw new Error('quote envelope is incomplete');
  const snapshot = strictRecord(quote.snapshot, [
    'type', 'postId', 'postContentVersion', 'contentHash', 'title', 'content', 'language', 'contentFormat',
    'source', 'sourceVersion', 'sourceSnapshotReference', 'sourceSnapshotRef', 'capturedAt', 'knownCurrentPostContentVersion',
    'artifactId', 'artifactVersion', 'itemId', 'knownCurrentArtifactVersion',
  ], 'quote snapshot');
  const isPost = snapshot.type === 'cg_post';
  const isInsight = snapshot.type === 'intelligence_insight';
  if (!isPost && !isInsight) throw new Error('quote type is unsupported');
  const nested: Record<string, unknown> = { ...snapshot };
  delete nested.type;
  const cgEnvelope = {
    quoteId: quote.quoteId,
    parentPostId: quote.parentPostId,
    parentPostContentVersion: quote.parentPostContentVersion,
    ...(isPost ? { post: nested } : { insight: nested }),
  };
  return mapCanonicalCgQuoteSnapshotToTi(cgEnvelope, policy.contractLimits, policy.supportedLanguages);
}

function exactVersion(post: CanonicalPostInputV1): { readonly kind: 'postContentVersion' | 'contentHash'; readonly value: StableId } {
  if (post.postContentVersion !== undefined) return { kind: 'postContentVersion', value: post.postContentVersion };
  if (post.contentHash !== undefined) return { kind: 'contentHash', value: post.contentHash };
  throw new Error('canonical post requires an exact version');
}

function validateBundleForPost(bundle: EvidenceBundleV1, post: CanonicalPostInputV1, policy: QuoteResolutionPolicy): boolean {
  const version = exactVersion(post);
  const evidence = prepareGenerationEvidence('deep_dive', bundle, [], policy.contractLimits, policy.evidencePolicy);
  return evidence.outcome !== 'failed'
    && bundle.post.postId === post.postId
    && bundle.post.version.kind === version.kind
    && bundle.post.version.value === version.value
    && bundle.post.language === post.language
    && (bundle.post.contentHash === undefined || bundle.post.contentHash === post.contentHash);
}

function sameOptionalSourceVersion(expected: StableId | undefined, actual: StableId | undefined): boolean {
  return expected === undefined || actual === expected;
}

function sameOptionalString(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || actual === expected;
}

/**
 * Exact immutable quote resolver for the single selected CG quote. This boundary never queries a
 * "latest" value to construct quoted content; current versions are returned as metadata only.
 */
export class QuoteSnapshotResolver {
  private readonly policy: QuoteResolutionPolicy;
  private readonly dependencies: QuoteResolutionDependencies;

  constructor(policy: QuoteResolutionPolicy, dependencies: QuoteResolutionDependencies) {
    this.policy = boundedPolicy(policy);
    if (!dependencies || typeof dependencies.authorizeCgService !== 'function'
        || typeof dependencies.loadExactPostSnapshot !== 'function'
        || typeof dependencies.loadExactInsightSnapshot !== 'function') {
      throw new Error('quote resolver requires CG authorization and exact-version loaders');
    }
    this.dependencies = dependencies;
  }

  async resolve(rawQuotes: readonly unknown[]): Promise<QuoteResolutionResult> {
    let authorized = false;
    try { authorized = await this.dependencies.authorizeCgService(); } catch { /* fail closed */ }
    if (authorized !== true) throw new QuoteResolutionError('unauthorized');
    if (!Array.isArray(rawQuotes) || rawQuotes.length > 1
        || Object.getOwnPropertyNames(rawQuotes).length !== rawQuotes.length + 1
        || Object.getOwnPropertySymbols(rawQuotes).length > 0 || Object.keys(rawQuotes).length !== rawQuotes.length) {
      throw new QuoteResolutionError('invalid_request');
    }
    if (rawQuotes.length === 0) return Object.freeze({ status: 'none' });

    let quote: TiMappedCgQuoteV2;
    try { quote = normalizeQuote(rawQuotes[0], this.policy); }
    catch { throw new QuoteResolutionError('invalid_request'); }
    if (quote.snapshot.type === 'cg_post') return this.resolvePost(quote);
    return this.resolveInsight(quote);
  }

  private async resolvePost(quote: TiMappedCgQuoteV2): Promise<QuoteResolutionResult> {
    const snapshot = quote.snapshot;
    if (snapshot.type !== 'cg_post') return { status: 'unavailable', limitation: 'quote_snapshot_unavailable' };
    const requestedVersion = snapshot.postContentVersion ?? null;
    const snapshotVersion = requestedVersion ?? snapshot.contentHash;
    if (quote.parentPostId !== snapshot.postId
        || (quote.parentPostContentVersion !== null && quote.parentPostContentVersion !== snapshotVersion)) {
      return Object.freeze({ status: 'unavailable', limitation: 'quote_snapshot_unavailable' });
    }
    let lookup: ExactPostSnapshotLookup;
    try {
      lookup = await this.dependencies.loadExactPostSnapshot(snapshot.postId, requestedVersion, snapshot.contentHash);
    } catch {
      return Object.freeze({ status: 'unavailable', limitation: 'quote_snapshot_unavailable' });
    }
    if (lookup.status !== 'available') return Object.freeze({ status: 'unavailable', limitation: 'quote_snapshot_unavailable' });

    let post: CanonicalPostInputV1;
    try {
      post = validateCanonicalPostInput(lookup.canonicalPost, this.policy.contractLimits, this.policy.supportedLanguages);
      const version = exactVersion(post);
      if (post.postId !== snapshot.postId || version.value !== (requestedVersion ?? snapshot.contentHash)
          || (requestedVersion !== null && version.kind !== 'postContentVersion')
          || (requestedVersion === null && version.kind !== 'contentHash')
          || post.title !== snapshot.title || post.content !== snapshot.content || post.language !== snapshot.language
          || !sameOptionalSourceVersion(snapshot.sourceVersion, post.sourceVersion)
          || !sameOptionalString(snapshot.sourceSnapshotReference, post.sourceSnapshotReference)
          || (snapshot.contentHash !== undefined && post.contentHash !== snapshot.contentHash)
          || (snapshot.contentFormat !== undefined && post.contentFormat !== snapshot.contentFormat)
          || (snapshot.source !== undefined && JSON.stringify(snapshot.source) !== JSON.stringify(post.source))) {
        throw new Error('exact quote snapshot mismatch');
      }
    } catch {
      return Object.freeze({ status: 'unavailable', limitation: 'quote_snapshot_unavailable' });
    }

    if (!lookup.evidenceBundle) return Object.freeze({ status: 'unavailable', limitation: 'quote_evidence_unavailable' });
    try {
      if (!validateBundleForPost(lookup.evidenceBundle, post, this.policy)) {
        return Object.freeze({ status: 'unavailable', limitation: 'quote_evidence_unavailable' });
      }
    } catch {
      return Object.freeze({ status: 'unavailable', limitation: 'quote_evidence_unavailable' });
    }

    const quotedVersion = exactVersion(post);
    const currentVersion = lookup.currentPostContentVersion ?? snapshot.knownCurrentPostContentVersion;
    const differs = currentVersion === null ? null : currentVersion !== quotedVersion.value;
    return Object.freeze({
      status: 'resolved',
      quote: Object.freeze({
        type: 'cg_post',
        quoteId: quote.quoteId,
        postId: post.postId,
        quotedVersion: Object.freeze(quotedVersion),
        language: post.language,
        title: post.title,
        content: post.content,
        evidence: lookup.evidenceBundle,
        currentVersion,
        currentVersionDiffers: differs,
      }),
    });
  }

  private async resolveInsight(quote: TiMappedCgQuoteV2): Promise<QuoteResolutionResult> {
    const snapshot = quote.snapshot;
    if (snapshot.type !== 'intelligence_insight') return { status: 'unavailable', limitation: 'quote_snapshot_unavailable' };
    let lookup: ExactInsightSnapshotLookup;
    try {
      lookup = await this.dependencies.loadExactInsightSnapshot(snapshot.artifactId, snapshot.artifactVersion, snapshot.itemId);
    } catch {
      return Object.freeze({ status: 'unavailable', limitation: 'quote_snapshot_unavailable' });
    }
    if (lookup.status !== 'available' || lookup.artifactId !== snapshot.artifactId
        || lookup.artifactVersion !== snapshot.artifactVersion || lookup.itemId !== snapshot.itemId
        || lookup.parentPostId !== quote.parentPostId
        || lookup.parentPostContentVersion !== quote.parentPostContentVersion
        || lookup.content !== snapshot.content || lookup.language !== snapshot.language
        || !lookup.evidenceBundle) {
      return Object.freeze({ status: 'unavailable', limitation: lookup.status === 'available' && !lookup.evidenceBundle
        ? 'quote_evidence_unavailable' : 'quote_snapshot_unavailable' });
    }
    try {
      // An insight without a parent post content version cannot safely bind its evidence.
      // Verify evidence bundle integrity/sufficiency, then enforce the exact parent identity/version.
      if (lookup.parentPostContentVersion === null) {
        return Object.freeze({ status: 'unavailable', limitation: 'quote_evidence_unavailable' });
      }
      const assessment = assessEvidenceSufficiency(lookup.evidenceBundle, this.policy.evidencePolicy);
      if (assessment.outcome === 'failed'
          || lookup.evidenceBundle.post.postId !== quote.parentPostId
          || lookup.evidenceBundle.post.version.kind !== 'postContentVersion'
          || lookup.evidenceBundle.post.version.value !== lookup.parentPostContentVersion) {
        return Object.freeze({ status: 'unavailable', limitation: 'quote_evidence_unavailable' });
      }
    } catch {
      return Object.freeze({ status: 'unavailable', limitation: 'quote_evidence_unavailable' });
    }
    const currentVersion = lookup.currentArtifactVersion ?? snapshot.knownCurrentArtifactVersion;
    return Object.freeze({
      status: 'resolved',
      quote: Object.freeze({
        type: 'intelligence_insight',
        quoteId: quote.quoteId,
        artifactId: snapshot.artifactId,
        artifactVersion: snapshot.artifactVersion,
        itemId: snapshot.itemId,
        language: snapshot.language,
        content: snapshot.content,
        parentPostId: lookup.parentPostId,
        parentPostContentVersion: lookup.parentPostContentVersion,
        evidence: lookup.evidenceBundle,
        currentArtifactVersion: currentVersion,
        currentVersionDiffers: currentVersion === null ? null : currentVersion !== snapshot.artifactVersion,
      }),
    });
  }
}
