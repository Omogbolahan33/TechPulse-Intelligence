import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { StableId } from './contracts';

export type ArtifactStatus = 'ready' | 'stale' | 'hidden';
export type GroundingMode = 'cg_plus_source' | 'cg_only';

export interface ArtifactInput {
  artifactKey: string;
  artifactType: 'summary' | 'persona_implications';
  postId: string;
  postContentVersion?: StableId;
  contentHash?: string;
  outputLanguage: string;
  payload: Record<string, unknown>;
  groundingMode: GroundingMode;
  citations: unknown[];
  limitations: string[];
  schemaVersion: number;
  promptVersion: string;
  moderationState: string;
  status: ArtifactStatus;
  retentionClass: string;
  createdAt?: Date;
}

export interface SourceSnapshotInput {
  sourceId: string;
  sourceType: string;
  sourceVersion?: string;
  contentHash?: string;
  title?: string;
  url?: string;
  publishedAt?: string;
  retrievedAt?: string;
  excerpt?: string;
}

export interface EvidenceInput {
  artifactKey: string;
  artifactVersion: number;
  postId: string;
  postContentVersion?: StableId;
  contentHash?: string;
  groundingMode: GroundingMode;
  sourceSnapshots: SourceSnapshotInput[];
  evidencePayload: Record<string, unknown>;
  schemaVersion: number;
  retentionClass: string;
  createdAt?: Date;
}

export interface GenerationRequestInput {
  requestId?: string;
  idempotencyKey: string;
  operationKind: 'summary' | 'pros_cons' | 'deep_dive';
  inputHash: string;
  state: 'accepted' | 'queued' | 'processing' | 'ready' | 'failed';
  attemptCount?: number;
  correlationId: string;
  waitExpiresAt: Date;
  callbackRef?: string;
  reconciliationRef?: string;
  retentionClass: string;
  quotaSubject: string;
}

/** Explicit wait-horizon policy supplied by the owning service; never defaulted here. */
export interface RetentionPolicyApproval {
  readonly status: 'approved';
  readonly ownerRole: 'privacy' | 'operations';
  readonly approvalReference: string;
}

export interface PersistencePolicy {
  readonly runtimeMode: 'test' | 'development' | 'production';
  readonly maxWaitHorizonMs: number;
  /** Configured age by retention class; null explicitly means no age-based expiry. */
  readonly maxRetentionAgeMsByClass: Readonly<Record<string, number | null>>;
  /** Required when runtimeMode is production; evidence comes from trusted deployment configuration. */
  readonly retentionPolicyApproval?: RetentionPolicyApproval;
}

export class PersistenceIdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key was already used with different input');
    this.name = 'PersistenceIdempotencyConflictError';
  }
}

export interface PersistenceDependencies {
  /** Injectable wall clock for deterministic expiry tests; production defaults to the system clock. */
  readonly now?: () => Date;
}

export interface RetentionPurgeResult {
  readonly evidenceBundles: number;
  readonly generationRequests: number;
  readonly artifacts: number;
}

export interface GenerationRequestResult {
  requestId: string;
  created: boolean;
}

export interface GenerationRequestClaim {
  readonly requestId: string;
  readonly operationKind: GenerationRequestInput['operationKind'];
  readonly inputHash: string;
  readonly correlationId: string;
  readonly callbackRef?: string;
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: Date;
  readonly waitExpiresAt: Date;
}

export interface GenerationCompletionInput {
  readonly requestId: string;
  readonly correlationId: string;
  readonly inputHash: string;
  readonly callbackRef: string;
  readonly callbackId: string;
  readonly claimToken: string;
  readonly outcome: 'ready' | 'failed';
  /** Hash of the validated result/failure envelope only; raw callback content is never stored. */
  readonly resultHash: string;
  readonly failureClass?: 'generation_failed' | 'validation_failed';
}

export interface GenerationCompletionResult {
  readonly requestId: string;
  readonly state: 'ready' | 'failed';
  readonly applied: boolean;
}

export interface GenerationRequestStatus {
  readonly requestId: string;
  readonly operationKind: GenerationRequestInput['operationKind'];
  readonly state: GenerationRequestInput['state'];
  readonly attemptCount: number;
  readonly waitExpiresAt: Date;
  readonly updatedAt: Date;
  readonly lastFailureClass?: GenerationFailureClass;
}

export interface PersistedArtifact extends ArtifactInput {
  version: number;
  isCurrent: boolean;
}

export interface PersistedEvidence extends EvidenceInput {
  evidenceId: string;
  sourceSnapshotRefs: Array<Pick<SourceSnapshotInput, 'sourceId' | 'sourceType' | 'sourceVersion' | 'contentHash'>>;
}

export type GenerationFailureClass = 'worker_lease_expired' | 'generation_failed' | 'validation_failed' | 'worker_shutdown';

export interface PersistedGenerationRequest extends Omit<GenerationRequestInput, 'quotaSubject'> {
  requestId: string;
  lastFailureClass?: GenerationFailureClass;
  createdAt: Date;
  updatedAt: Date;
}

const immutableJson = (value: unknown): string => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('persistence values must be JSON-serializable');
  return serialized;
};

const assertJsonBudget = (value: unknown, maxBytes: number, label: string): void => {
  if (Buffer.byteLength(immutableJson(value), 'utf8') > maxBytes) throw new Error(`${label} exceeds the persistence payload limit`);
};

function assertStableVersion(value: StableId | undefined, contentHash: string | undefined, label: string): void {
  if (value !== undefined && !(
    (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  )) throw new Error(`${label} must be a non-empty string or non-negative safe integer`);
  if (contentHash !== undefined && (typeof contentHash !== 'string' || contentHash.trim().length === 0)) {
    throw new Error(`${label} contentHash must be a non-empty string`);
  }
  if (value === undefined && contentHash === undefined) throw new Error('postContentVersion or contentHash is required');
}

function retainedRequestPredicate(
  policy: PersistencePolicy,
  tableAlias: string,
  nowPlaceholder: string,
  firstParameterIndex: number,
): { readonly sql: string; readonly values: readonly (string | number)[] } {
  const terms: string[] = [];
  const values: (string | number)[] = [];
  let index = firstParameterIndex;
  for (const [retentionClass, maxAgeMs] of Object.entries(policy.maxRetentionAgeMsByClass)) {
    const classPlaceholder = `$${index}`;
    values.push(retentionClass);
    index += 1;
    if (maxAgeMs === null) {
      terms.push(`${tableAlias}.retention_class = ${classPlaceholder}`);
    } else {
      const agePlaceholder = `$${index}`;
      values.push(maxAgeMs);
      index += 1;
      terms.push(`(${tableAlias}.retention_class = ${classPlaceholder} AND ${tableAlias}.created_at + (${agePlaceholder} * INTERVAL '1 millisecond') > ${nowPlaceholder}::timestamptz)`);
    }
  }
  return { sql: terms.length > 0 ? `(${terms.join(' OR ')})` : 'FALSE', values: Object.freeze(values) };
}

const PRIVATE_SHARED_FIELDS = new Set([
  'userid', 'rawuserid', 'username', 'profileid', 'profilevisibility', 'profile',
  'matchingusers', 'matchinguserids', 'quotasubject', 'usermessageid', 'conversationid',
  'conversationref', 'email', 'emailaddress', 'phone', 'phonenumber', 'useridentity', 'user', 'userobject', 'identity',
  'rawchat', 'chat', 'chatmessage', 'chatmessages', 'chathistory', 'rawmessage', 'message', 'messages',
  'usermessage', 'userprompt', 'rawprompt', 'prompt', 'threadhistory', 'conversationmessages',
  'messagehistory', 'conversationhistory', 'authorid', 'accountid', 'actorid', 'memberid', 'customerid',
  'recipientid', 'subjectid', 'personid',
]);

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}

function assertPostgresPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 2_147_483_647) {
    throw new Error(`${label} must be a positive PostgreSQL INTEGER`);
  }
}

function assertGroundingMode(value: unknown, label: string): asserts value is GroundingMode {
  if (value !== 'cg_plus_source' && value !== 'cg_only') throw new Error(`${label} is unsupported`);
}

function assertOptionalText(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error(`${label} must be omitted or a non-empty string`);
  }
}

function assertAllowedKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  const allowedSet = new Set(allowed);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} must not contain symbol properties`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must contain only enumerable data properties`);
    }
  }
}

function assertNoSharedIdentityData(value: unknown, label: string): void {
  const seen = new WeakSet<object>();
  const visit = (current: unknown, path: string, depth: number): void => {
    if (depth > 32) throw new Error(`${label} exceeds the nesting bound`);
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`${label} must contain only finite JSON numbers`);
      return;
    }
    if (typeof current !== 'object') throw new Error(`${label} must contain only JSON-compatible values`);
    if (seen.has(current)) throw new Error(`${label} must not contain cycles`);
    seen.add(current);
    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length > 0 || Object.keys(current).length !== current.length) {
        throw new Error(`${label} arrays must be dense and must not contain extra or symbol properties`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new Error(`${label} arrays must contain enumerable data elements`);
        }
        visit(descriptor.value, `${path}[${index}]`, depth + 1);
      }
      seen.delete(current);
      return;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must contain only plain JSON objects`);
    if (Object.getOwnPropertySymbols(current).length > 0) throw new Error(`${label} must not contain symbol properties`);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error(`${label} must contain only enumerable data properties`);
      }
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (PRIVATE_SHARED_FIELDS.has(normalizedKey)) {
        throw new Error(`${label} contains a prohibited identity/PII field at ${path}.${key}`);
      }
      if (descriptor.value !== undefined) visit(descriptor.value, `${path}.${key}`, depth + 1);
    }
    seen.delete(current);
  };
  visit(value, label, 0);
}

/** Versioned, bounded persistence for TI-owned artifacts and request metadata. */
export class TiPersistence {
  private readonly pool: Pool;
  private readonly policy: PersistencePolicy;
  private readonly readClock: () => Date;

  constructor(pool: Pool, policy: PersistencePolicy, dependencies: PersistenceDependencies = {}) {
    assertAllowedKeys(policy, ['runtimeMode', 'maxWaitHorizonMs', 'maxRetentionAgeMsByClass', 'retentionPolicyApproval'], 'persistence policy');
    assertAllowedKeys(dependencies, ['now'], 'persistence dependencies');
    if (dependencies.now !== undefined && typeof dependencies.now !== 'function') {
      throw new Error('persistence dependencies now must be a function');
    }
    if (!['test', 'development', 'production'].includes(policy?.runtimeMode)) {
      throw new Error('runtimeMode must be explicitly configured as test, development, or production');
    }
    if (process.env.NODE_ENV === 'production' && policy.runtimeMode !== 'production') {
      throw new Error('production NODE_ENV requires runtimeMode=production');
    }
    if (!Number.isSafeInteger(policy?.maxWaitHorizonMs) || policy.maxWaitHorizonMs <= 0) {
      throw new Error('maxWaitHorizonMs must be explicitly configured as a positive safe integer');
    }
    const requiresApprovedRetentionPolicy = policy.runtimeMode === 'production' || process.env.NODE_ENV === 'production';
    let approvalSnapshot: RetentionPolicyApproval | undefined;
    if (policy.retentionPolicyApproval !== undefined) {
      assertAllowedKeys(policy.retentionPolicyApproval, ['status', 'ownerRole', 'approvalReference'], 'retention policy approval');
      const approval = policy.retentionPolicyApproval as RetentionPolicyApproval;
      if (approval.status !== 'approved' || !['privacy', 'operations'].includes(approval.ownerRole)
          || typeof approval.approvalReference !== 'string' || approval.approvalReference.trim().length === 0) {
        throw new Error('retention policy approval must contain approved status, an authorized owner role, and a non-empty approval reference');
      }
      approvalSnapshot = Object.freeze({
        status: 'approved',
        ownerRole: approval.ownerRole,
        approvalReference: approval.approvalReference,
      });
    }
    if (requiresApprovedRetentionPolicy && !approvalSnapshot) {
      throw new Error('production persistence requires owner-approved retention policy evidence');
    }
    const retentionClasses = policy?.maxRetentionAgeMsByClass;
    if (!retentionClasses || typeof retentionClasses !== 'object' || Array.isArray(retentionClasses)
        || Object.keys(retentionClasses).length === 0) {
      throw new Error('maxRetentionAgeMsByClass must explicitly configure at least one class');
    }
    const prototype = Object.getPrototypeOf(retentionClasses);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('maxRetentionAgeMsByClass must be a plain object');
    }
    if (Object.getOwnPropertySymbols(retentionClasses).length > 0) {
      throw new Error('maxRetentionAgeMsByClass must not contain symbol properties');
    }
    const retentionPolicySnapshot: Record<string, number | null> = Object.create(null) as Record<string, number | null>;
    for (const [retentionClass, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(retentionClasses))) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('retention classes must be enumerable data properties');
      }
      const maxAgeMs: unknown = descriptor.value;
      if (!retentionClass.trim() || (maxAgeMs !== null
          && (typeof maxAgeMs !== 'number' || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 8_640_000_000_000_000))) {
        throw new Error('each retention class must have a non-empty name and null or a positive safe-integer age within the Date range');
      }
      retentionPolicySnapshot[retentionClass] = maxAgeMs as number | null;
    }
    this.pool = pool;
    this.readClock = dependencies.now ?? (() => new Date());
    this.policy = Object.freeze({
      runtimeMode: policy.runtimeMode,
      maxWaitHorizonMs: policy.maxWaitHorizonMs,
      maxRetentionAgeMsByClass: Object.freeze(retentionPolicySnapshot),
      ...(approvalSnapshot === undefined ? {} : { retentionPolicyApproval: approvalSnapshot }),
    });
  }

  private now(): Date {
    const value = this.readClock();
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
      throw new Error('persistence clock must return a valid Date');
    }
    return new Date(value.getTime());
  }

  private retentionExpiryMs(retentionClass: string, createdAt: Date): number | null {
    if (!Object.hasOwn(this.policy.maxRetentionAgeMsByClass, retentionClass)) {
      throw new Error('retentionClass is not present in the configured retention policy');
    }
    if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
      throw new Error('createdAt must be a valid Date');
    }
    const maxAgeMs = this.policy.maxRetentionAgeMsByClass[retentionClass];
    if (maxAgeMs === null) return null;
    const expiryMs = createdAt.getTime() + maxAgeMs;
    if (!Number.isSafeInteger(expiryMs)) throw new Error('retention expiry is outside the safe timestamp range');
    return expiryMs;
  }

  private assertRetentionForWrite(retentionClass: string, createdAt: Date): void {
    const expiryMs = this.retentionExpiryMs(retentionClass, createdAt);
    if (expiryMs !== null && expiryMs <= this.now().getTime()) {
      throw new Error('record would already be expired under the configured retention policy');
    }
  }

  private isRetained(retentionClass: string, createdAt: Date, now?: Date): boolean {
    try {
      const expiryMs = this.retentionExpiryMs(retentionClass, createdAt);
      const currentTime = now ?? this.now();
      return expiryMs === null || expiryMs > currentTime.getTime();
    } catch {
      return false;
    }
  }

  async publishArtifact(input: ArtifactInput): Promise<number> {
    assertAllowedKeys(input, [
      'artifactKey', 'artifactType', 'postId', 'postContentVersion', 'contentHash', 'outputLanguage',
      'payload', 'groundingMode', 'citations', 'limitations', 'schemaVersion', 'promptVersion',
      'moderationState', 'status', 'retentionClass', 'createdAt',
    ], 'artifact');
    assertNonEmptyString(input.artifactKey, 'artifactKey');
    if (!['summary', 'persona_implications'].includes(input.artifactType)) throw new Error('artifactType is unsupported');
    assertNonEmptyString(input.postId, 'postId');
    assertNonEmptyString(input.outputLanguage, 'outputLanguage');
    assertNonEmptyString(input.promptVersion, 'promptVersion');
    assertNonEmptyString(input.moderationState, 'moderationState');
    assertNonEmptyString(input.retentionClass, 'retentionClass');
    assertGroundingMode(input.groundingMode, 'groundingMode');
    if (!['ready', 'stale', 'hidden'].includes(input.status)) throw new Error('artifact status is unsupported');
    if (input.status === 'ready' && input.moderationState === 'hidden') {
      throw new Error('hidden moderation state cannot be published as a ready artifact');
    }
    assertPostgresPositiveInteger(input.schemaVersion, 'schemaVersion');
    if (input.createdAt !== undefined && (!(input.createdAt instanceof Date) || !Number.isSafeInteger(input.createdAt.getTime()))) {
      throw new Error('createdAt must be a valid Date');
    }
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new Error('artifact payload must be an object');
    }
    assertAllowedKeys(input.payload, Object.keys(input.payload), 'artifact payload');
    if (!Array.isArray(input.citations) || !Array.isArray(input.limitations)) {
      throw new Error('artifact citations and limitations must be arrays');
    }
    assertNoSharedIdentityData(input.payload, 'artifact payload');
    assertNoSharedIdentityData(input.citations, 'artifact citations');
    assertNoSharedIdentityData(input.limitations, 'artifact limitations');
    const artifactCreatedAt = input.createdAt ?? this.now();
    this.assertRetentionForWrite(input.retentionClass, artifactCreatedAt);
    assertStableVersion(input.postContentVersion, input.contentHash, 'artifact version');
    assertJsonBudget(input, 65_536, 'artifact');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO ti_artifact_keys (artifact_key) VALUES ($1) ON CONFLICT DO NOTHING', [input.artifactKey]);
      await client.query('SELECT artifact_key FROM ti_artifact_keys WHERE artifact_key = $1 FOR UPDATE', [input.artifactKey]);
      const current = await client.query<{ version: number }>(
        'SELECT version FROM ti_artifacts WHERE artifact_key = $1 ORDER BY version DESC LIMIT 1',
        [input.artifactKey],
      );
      const version = Number(current.rows[0]?.version ?? 0) + 1;
      await client.query('UPDATE ti_artifacts SET is_current = FALSE WHERE artifact_key = $1 AND is_current = TRUE', [input.artifactKey]);
      await client.query(
        `INSERT INTO ti_artifacts (
          artifact_key, version, artifact_type, post_id, post_content_version, content_hash, output_language,
          payload, grounding_mode, citations, limitations, schema_version, prompt_version, moderation_state,
          status, retention_class, is_current, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,TRUE,$17)`,
        [input.artifactKey, version, input.artifactType, input.postId, input.postContentVersion ?? null,
          input.contentHash ?? null, input.outputLanguage, immutableJson(input.payload), input.groundingMode,
          immutableJson(input.citations), immutableJson(input.limitations), input.schemaVersion, input.promptVersion,
          input.moderationState, input.status, input.retentionClass, artifactCreatedAt],
      );
      await client.query('COMMIT');
      return version;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getArtifact(artifactKey: string): Promise<PersistedArtifact | null> {
    if (typeof artifactKey !== 'string' || artifactKey.trim().length === 0) throw new Error('artifactKey must be a non-empty string');
    const result = await this.pool.query(
      `SELECT * FROM ti_artifacts
       WHERE artifact_key = $1 AND is_current = TRUE AND status = 'ready'
         AND moderation_state <> 'hidden'
         AND retention_class = ANY($2::text[])
       LIMIT 1`,
      [artifactKey, Object.keys(this.policy.maxRetentionAgeMsByClass)],
    );
    const row = result.rows[0];
    if (!row || !this.isRetained(row.retention_class, row.created_at)) return null;
    return {
      artifactKey: row.artifact_key, version: Number(row.version), artifactType: row.artifact_type, postId: row.post_id,
      postContentVersion: row.post_content_version ?? undefined, contentHash: row.content_hash ?? undefined,
      outputLanguage: row.output_language, payload: row.payload, groundingMode: row.grounding_mode,
      citations: row.citations, limitations: row.limitations, schemaVersion: row.schema_version,
      promptVersion: row.prompt_version, moderationState: row.moderation_state, status: row.status,
      retentionClass: row.retention_class, isCurrent: row.is_current, createdAt: row.created_at,
    };
  }

  /** Explicit audit path for retained historical versions; never use this for a cache hit. */
  async getArtifactVersionForAudit(artifactKey: string, version: number): Promise<PersistedArtifact | null> {
    if (typeof artifactKey !== 'string' || artifactKey.trim().length === 0) throw new Error('artifactKey must be a non-empty string');
    assertPostgresPositiveInteger(version, 'version');
    const result = await this.pool.query(
      `SELECT * FROM ti_artifacts
       WHERE artifact_key = $1 AND version = $2 AND retention_class = ANY($3::text[])
       LIMIT 1`,
      [artifactKey, version, Object.keys(this.policy.maxRetentionAgeMsByClass)],
    );
    const row = result.rows[0];
    if (!row || !this.isRetained(row.retention_class, row.created_at)) return null;
    return {
      artifactKey: row.artifact_key, version: Number(row.version), artifactType: row.artifact_type, postId: row.post_id,
      postContentVersion: row.post_content_version ?? undefined, contentHash: row.content_hash ?? undefined,
      outputLanguage: row.output_language, payload: row.payload, groundingMode: row.grounding_mode,
      citations: row.citations, limitations: row.limitations, schemaVersion: row.schema_version,
      promptVersion: row.prompt_version, moderationState: row.moderation_state, status: row.status,
      retentionClass: row.retention_class, isCurrent: row.is_current, createdAt: row.created_at,
    };
  }

  async storeEvidence(input: EvidenceInput): Promise<string> {
    assertAllowedKeys(input, [
      'artifactKey', 'artifactVersion', 'postId', 'postContentVersion', 'contentHash', 'groundingMode',
      'sourceSnapshots', 'evidencePayload', 'schemaVersion', 'retentionClass', 'createdAt',
    ], 'evidence');
    assertNonEmptyString(input.artifactKey, 'artifactKey');
    assertPostgresPositiveInteger(input.artifactVersion, 'artifactVersion');
    assertNonEmptyString(input.postId, 'postId');
    assertGroundingMode(input.groundingMode, 'groundingMode');
    assertNonEmptyString(input.retentionClass, 'retentionClass');
    assertPostgresPositiveInteger(input.schemaVersion, 'schemaVersion');
    if (input.createdAt !== undefined && (!(input.createdAt instanceof Date) || !Number.isSafeInteger(input.createdAt.getTime()))) {
      throw new Error('createdAt must be a valid Date');
    }
    if (!input.evidencePayload || typeof input.evidencePayload !== 'object' || Array.isArray(input.evidencePayload)) {
      throw new Error('evidencePayload must be an object');
    }
    assertAllowedKeys(input.evidencePayload, Object.keys(input.evidencePayload), 'evidence payload');
    assertNoSharedIdentityData(input.evidencePayload, 'evidence payload');
    if (!Array.isArray(input.sourceSnapshots)) throw new Error('sourceSnapshots must be an array');
    input.sourceSnapshots.forEach((source, index) => assertAllowedKeys(source, [
      'sourceId', 'sourceType', 'sourceVersion', 'contentHash', 'title', 'url', 'publishedAt', 'retrievedAt', 'excerpt',
    ], `sourceSnapshots[${index}]`));
    assertNoSharedIdentityData(input.sourceSnapshots, 'source snapshots');
    const evidenceCreatedAt = input.createdAt ?? this.now();
    this.assertRetentionForWrite(input.retentionClass, evidenceCreatedAt);
    if (input.sourceSnapshots.length > 20) throw new Error('sourceSnapshots exceeds the per-evidence limit of 20');
    input.sourceSnapshots.forEach((source, index) => {
      assertNonEmptyString(source.sourceId, `sourceSnapshots[${index}].sourceId`);
      assertNonEmptyString(source.sourceType, `sourceSnapshots[${index}].sourceType`);
      assertOptionalText(source.sourceVersion, `sourceSnapshots[${index}].sourceVersion`);
      assertOptionalText(source.contentHash, `sourceSnapshots[${index}].contentHash`);
      assertOptionalText(source.title, `sourceSnapshots[${index}].title`);
      assertOptionalText(source.url, `sourceSnapshots[${index}].url`);
      assertOptionalText(source.publishedAt, `sourceSnapshots[${index}].publishedAt`);
      assertOptionalText(source.retrievedAt, `sourceSnapshots[${index}].retrievedAt`);
      assertOptionalText(source.excerpt, `sourceSnapshots[${index}].excerpt`);
      if (source.sourceVersion === undefined && source.contentHash === undefined) {
        throw new Error(`sourceSnapshots[${index}] requires sourceVersion or contentHash`);
      }
    });
    assertStableVersion(input.postContentVersion, input.contentHash, 'evidence version');
    const evidenceId = randomUUID();
    const sourceSnapshotRefs = input.sourceSnapshots.map(({ sourceId, sourceType, sourceVersion, contentHash }) => ({
      sourceId, sourceType, sourceVersion, contentHash,
    }));
    const evidencePayload = {
      ...input.evidencePayload,
      sourceSnapshots: input.sourceSnapshots.map((source) => ({
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        sourceVersion: source.sourceVersion,
        contentHash: source.contentHash,
        title: source.title,
        url: source.url,
        publishedAt: source.publishedAt,
        retrievedAt: source.retrievedAt,
        excerpt: source.excerpt,
      })),
    };
    assertJsonBudget({ ...input, evidencePayload }, 131_072, 'evidence');
    const inserted = await this.pool.query(
      `INSERT INTO ti_evidence_bundles (
        evidence_id, artifact_key, artifact_version, post_id, post_content_version, content_hash, grounding_mode,
        source_snapshot_refs, evidence_payload, schema_version, retention_class, created_at
      )
      SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12
      FROM ti_artifacts AS artifact
      WHERE artifact.artifact_key = $2 AND artifact.version = $3 AND artifact.post_id = $4
        AND artifact.post_content_version IS NOT DISTINCT FROM $5::text
        AND artifact.content_hash IS NOT DISTINCT FROM $6::text
        AND artifact.grounding_mode = $7`,
      [evidenceId, input.artifactKey, input.artifactVersion, input.postId, input.postContentVersion ?? null,
        input.contentHash ?? null, input.groundingMode, immutableJson(sourceSnapshotRefs), immutableJson(evidencePayload),
        input.schemaVersion, input.retentionClass, evidenceCreatedAt],
    );
    if (inserted.rowCount !== 1) throw new Error('evidence does not match the exact persisted artifact version, post snapshot, and grounding mode');
    return evidenceId;
  }

  async getEvidence(evidenceId: string): Promise<PersistedEvidence | null> {
    assertNonEmptyString(evidenceId, 'evidenceId');
    const result = await this.pool.query('SELECT * FROM ti_evidence_bundles WHERE evidence_id = $1', [evidenceId]);
    const row = result.rows[0];
    if (!row || !this.isRetained(row.retention_class, row.created_at)) return null;
    const evidencePayload = row.evidence_payload as Record<string, unknown>;
    return {
      evidenceId: row.evidence_id, artifactKey: row.artifact_key, artifactVersion: Number(row.artifact_version),
      postId: row.post_id, postContentVersion: row.post_content_version ?? undefined,
      contentHash: row.content_hash ?? undefined, groundingMode: row.grounding_mode,
      sourceSnapshotRefs: row.source_snapshot_refs,
      evidencePayload, sourceSnapshots: evidencePayload.sourceSnapshots as SourceSnapshotInput[],
      schemaVersion: row.schema_version, retentionClass: row.retention_class, createdAt: row.created_at,
    };
  }

  async createOrGetGenerationRequest(input: GenerationRequestInput): Promise<GenerationRequestResult> {
    assertAllowedKeys(input, [
      'requestId', 'idempotencyKey', 'operationKind', 'inputHash', 'state', 'attemptCount', 'correlationId',
      'waitExpiresAt', 'callbackRef', 'reconciliationRef', 'retentionClass', 'quotaSubject',
    ], 'generation request');
    assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
    assertNonEmptyString(input.inputHash, 'inputHash');
    assertNonEmptyString(input.correlationId, 'correlationId');
    assertNonEmptyString(input.retentionClass, 'retentionClass');
    assertNonEmptyString(input.quotaSubject, 'quotaSubject');
    assertOptionalText(input.requestId, 'requestId');
    assertOptionalText(input.callbackRef, 'callbackRef');
    assertOptionalText(input.reconciliationRef, 'reconciliationRef');
    if (!(input.waitExpiresAt instanceof Date) || !Number.isSafeInteger(input.waitExpiresAt.getTime())) {
      throw new Error('waitExpiresAt must be a valid Date');
    }
    if (!['summary', 'pros_cons', 'deep_dive'].includes(input.operationKind)) {
      throw new Error('operationKind is unsupported');
    }
    if (input.state !== 'accepted') {
      throw new Error('new generation requests must enter the accepted state; workers control later transitions');
    }
    if (input.attemptCount !== undefined && (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0 || input.attemptCount > 2_147_483_647)) {
      throw new Error('attemptCount must be a non-negative PostgreSQL INTEGER');
    }
    const { quotaSubject: _restrictedQuotaSubject, waitExpiresAt: _waitExpiresAt, ...sharedRequestMetadata } = input;
    assertNoSharedIdentityData(sharedRequestMetadata, 'generation request metadata');
    const requestCreatedAt = this.now();
    this.assertRetentionForWrite(input.retentionClass, requestCreatedAt);
    const waitExpiryMs = input.waitExpiresAt.getTime();
    const waitHorizonMs = waitExpiryMs - requestCreatedAt.getTime();
    if (waitHorizonMs <= 0) throw new Error('waitExpiresAt must be in the future');
    if (waitHorizonMs > this.policy.maxWaitHorizonMs) {
      throw new Error(`waitExpiresAt exceeds the configured ${this.policy.maxWaitHorizonMs}ms wait horizon`);
    }
    assertJsonBudget(input, 16_384, 'generation request metadata');
    const requestId = input.requestId ?? randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prior = await client.query<{ request_id: string; input_hash: string }>(
        'SELECT request_id, input_hash FROM ti_generation_requests WHERE operation_kind = $1 AND idempotency_key = $2',
        [input.operationKind, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].input_hash !== input.inputHash) throw new PersistenceIdempotencyConflictError();
        await client.query('COMMIT');
        return { requestId: prior.rows[0].request_id, created: false };
      }
      const createdAt = requestCreatedAt;
      const inserted = await client.query<{ request_id: string }>(
        `INSERT INTO ti_generation_requests (
          request_id, idempotency_key, operation_kind, input_hash, state, attempt_count, correlation_id,
          wait_expires_at, callback_ref, reconciliation_ref, retention_class, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        ON CONFLICT (operation_kind, idempotency_key) DO NOTHING RETURNING request_id`,
        [requestId, input.idempotencyKey, input.operationKind, input.inputHash, input.state, input.attemptCount ?? 0,
          input.correlationId, new Date(waitExpiryMs), input.callbackRef ?? null, input.reconciliationRef ?? null,
          input.retentionClass, createdAt],
      );
      if (inserted.rowCount === 1) {
        await client.query(
          'INSERT INTO ti_request_restricted_metadata (request_id, quota_subject, created_at) VALUES ($1,$2,$3)',
          [requestId, input.quotaSubject, createdAt],
        );
        await client.query('COMMIT');
        return { requestId, created: true };
      }
      const existing = await client.query<{ request_id: string; input_hash: string }>(
        'SELECT request_id, input_hash FROM ti_generation_requests WHERE operation_kind = $1 AND idempotency_key = $2',
        [input.operationKind, input.idempotencyKey],
      );
      if (!existing.rows[0] || existing.rows[0].input_hash !== input.inputHash) {
        throw new PersistenceIdempotencyConflictError();
      }
      await client.query('COMMIT');
      return { requestId: existing.rows[0].request_id, created: false };
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getGenerationRequest(requestId: string): Promise<PersistedGenerationRequest | null> {
    assertNonEmptyString(requestId, 'requestId');
    const result = await this.pool.query('SELECT * FROM ti_generation_requests WHERE request_id = $1', [requestId]);
    const row = result.rows[0];
    if (!row || !this.isRetained(row.retention_class, row.created_at)) return null;
    return {
      requestId: row.request_id, idempotencyKey: row.idempotency_key, operationKind: row.operation_kind,
      inputHash: row.input_hash, state: row.state, attemptCount: row.attempt_count,
      correlationId: row.correlation_id, waitExpiresAt: row.wait_expires_at,
      callbackRef: row.callback_ref ?? undefined, reconciliationRef: row.reconciliation_ref ?? undefined,
      retentionClass: row.retention_class, lastFailureClass: row.last_failure_class ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  /**
   * Claims one durable operation using PostgreSQL row locking. Expired leases are safely
   * reclaimed; expired caller wait horizons do not cancel accepted work. All lease/attempt
   * limits are explicit inputs, never guessed defaults.
   */
  async claimNextGenerationRequest(input: {
    readonly leaseDurationMs: number;
    readonly maxAttempts: number;
  }): Promise<GenerationRequestClaim | null> {
    assertAllowedKeys(input, ['leaseDurationMs', 'maxAttempts'], 'generation claim policy');
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0
        || input.leaseDurationMs > 8_640_000_000_000_000) throw new Error('leaseDurationMs must be an explicit positive safe integer');
    assertPostgresPositiveInteger(input.maxAttempts, 'maxAttempts');
    const now = this.now();
    const leaseExpiry = new Date(now.getTime() + input.leaseDurationMs);
    if (!Number.isSafeInteger(leaseExpiry.getTime())) throw new Error('claim lease expiry is outside the safe timestamp range');
    const retained = retainedRequestPredicate(this.policy, 'request_row', '$1', 3);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ti_generation_requests AS request_row
         SET state = 'failed', claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL,
             last_failure_class = 'worker_lease_expired', updated_at = $1
         WHERE request_row.state = 'processing' AND request_row.attempt_count >= $2
           AND request_row.claim_expires_at IS NOT NULL AND request_row.claim_expires_at <= $1
           AND ${retained.sql}`,
        [now, input.maxAttempts, ...retained.values],
      );
      const selected = await client.query<{
        request_id: string;
        operation_kind: GenerationRequestInput['operationKind'];
        input_hash: string;
        correlation_id: string;
        callback_ref: string | null;
        attempt_count: number;
        wait_expires_at: Date;
      }>(
        `SELECT request_row.request_id, request_row.operation_kind, request_row.input_hash,
                request_row.correlation_id, request_row.callback_ref, request_row.attempt_count,
                request_row.wait_expires_at
         FROM ti_generation_requests AS request_row
         WHERE ${retained.sql}
           AND request_row.attempt_count < $2
           AND (
             request_row.state IN ('accepted', 'queued')
             AND (request_row.next_attempt_at IS NULL OR request_row.next_attempt_at <= $1)
             OR request_row.state = 'processing'
             AND (request_row.claim_expires_at IS NULL OR request_row.claim_expires_at <= $1)
           )
         ORDER BY request_row.created_at, request_row.request_id
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [now, input.maxAttempts, ...retained.values],
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const claimToken = randomUUID();
      const attemptCount = row.attempt_count + 1;
      const updated = await client.query(
        `UPDATE ti_generation_requests
         SET state = 'processing', attempt_count = $2, claim_token = $3, claim_expires_at = $4,
             next_attempt_at = NULL, last_failure_class = NULL, updated_at = $5
         WHERE request_id = $1`,
        [row.request_id, attemptCount, claimToken, leaseExpiry, now],
      );
      if (updated.rowCount !== 1) throw new Error('generation claim lost its locked request row');
      await client.query('COMMIT');
      return Object.freeze({
        requestId: row.request_id,
        operationKind: row.operation_kind,
        inputHash: row.input_hash,
        correlationId: row.correlation_id,
        ...(row.callback_ref === null ? {} : { callbackRef: row.callback_ref }),
        attemptCount,
        claimToken,
        leaseExpiresAt: leaseExpiry,
        waitExpiresAt: row.wait_expires_at,
      });
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Release a live claim for an explicitly scheduled retry or terminal safe failure. */
  async releaseGenerationRequestClaim(input: {
    readonly requestId: string;
    readonly claimToken: string;
    readonly failureClass: 'generation_failed' | 'validation_failed' | 'worker_shutdown';
    readonly retryAt?: Date;
    readonly maxAttempts: number;
  }): Promise<'queued' | 'failed'> {
    assertAllowedKeys(input, ['requestId', 'claimToken', 'failureClass', 'retryAt', 'maxAttempts'], 'generation claim release');
    assertNonEmptyString(input.requestId, 'requestId');
    assertNonEmptyString(input.claimToken, 'claimToken');
    assertPostgresPositiveInteger(input.maxAttempts, 'maxAttempts');
    if (!['generation_failed', 'validation_failed', 'worker_shutdown'].includes(input.failureClass)) {
      throw new Error('generation failure class is unsupported');
    }
    if (input.retryAt !== undefined && (!(input.retryAt instanceof Date) || !Number.isSafeInteger(input.retryAt.getTime()))) {
      throw new Error('retryAt must be omitted or a valid Date');
    }
    const now = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ attempt_count: number; retention_class: string; created_at: Date; claim_expires_at: Date | null }>(
        `SELECT attempt_count, retention_class, created_at, claim_expires_at
         FROM ti_generation_requests WHERE request_id = $1 AND state = 'processing' AND claim_token = $2 FOR UPDATE`,
        [input.requestId, input.claimToken],
      );
      const row = result.rows[0];
      if (!row || !this.isRetained(row.retention_class, row.created_at, now)
          || !row.claim_expires_at || row.claim_expires_at.getTime() <= now.getTime()) {
        throw new Error('active generation claim not found');
      }
      const retry = input.retryAt !== undefined && row.attempt_count < input.maxAttempts;
      if (retry && input.retryAt!.getTime() < now.getTime()) throw new Error('retryAt must not be in the past');
      const state = retry ? 'queued' : 'failed';
      await client.query(
        `UPDATE ti_generation_requests
         SET state = $3, claim_token = NULL, claim_expires_at = NULL, next_attempt_at = $4,
             last_failure_class = $5, updated_at = $6 WHERE request_id = $1 AND claim_token = $2`,
        [input.requestId, input.claimToken, state, retry ? input.retryAt : null, input.failureClass, now],
      );
      await client.query('COMMIT');
      return state;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Applies a content-free authenticated callback receipt once. The caller must authenticate
   * and scope-check the callback before calling this method; the receipt stores hashes/status only.
   */
  async completeGenerationRequest(input: GenerationCompletionInput): Promise<GenerationCompletionResult> {
    assertAllowedKeys(input, [
      'requestId', 'correlationId', 'inputHash', 'callbackRef', 'callbackId', 'claimToken',
      'outcome', 'resultHash', 'failureClass',
    ], 'generation completion');
    for (const key of ['requestId', 'correlationId', 'inputHash', 'callbackRef', 'callbackId', 'claimToken'] as const) {
      assertNonEmptyString(input[key], key);
    }
    if (input.outcome !== 'ready' && input.outcome !== 'failed') throw new Error('completion outcome is unsupported');
    if (!/^[a-f0-9]{64}$/.test(input.resultHash)) throw new Error('resultHash must be a lowercase SHA-256 digest');
    if ((input.outcome === 'ready' && input.failureClass !== undefined)
        || (input.outcome === 'failed' && !['generation_failed', 'validation_failed'].includes(String(input.failureClass)))) {
      throw new Error('completion failure class does not match its outcome');
    }
    const now = this.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const requestResult = await client.query<{
        state: GenerationRequestInput['state']; input_hash: string; correlation_id: string; callback_ref: string | null;
        claim_token: string | null; claim_expires_at: Date | null; retention_class: string; created_at: Date;
      }>(
        `SELECT state, input_hash, correlation_id, callback_ref, claim_token, claim_expires_at, retention_class, created_at
         FROM ti_generation_requests WHERE request_id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const current = requestResult.rows[0];
      if (!current || !this.isRetained(current.retention_class, current.created_at, now)) {
        throw new Error('generation request not found');
      }
      if (current.input_hash !== input.inputHash || current.correlation_id !== input.correlationId
          || current.callback_ref !== input.callbackRef) throw new PersistenceIdempotencyConflictError();

      const prior = await client.query<{
        callback_id: string; correlation_id: string; input_hash: string; callback_ref: string; outcome: 'ready' | 'failed';
        result_hash: string; failure_class: string | null;
      }>('SELECT callback_id, correlation_id, input_hash, callback_ref, outcome, result_hash, failure_class FROM ti_generation_completions WHERE request_id = $1', [input.requestId]);
      if (prior.rows[0]) {
        const receipt = prior.rows[0];
        const identical = receipt.callback_id === input.callbackId && receipt.correlation_id === input.correlationId
          && receipt.input_hash === input.inputHash && receipt.callback_ref === input.callbackRef
          && receipt.outcome === input.outcome && receipt.result_hash === input.resultHash
          && receipt.failure_class === (input.failureClass ?? null);
        if (!identical) throw new PersistenceIdempotencyConflictError();
        await client.query('COMMIT');
        return Object.freeze({ requestId: input.requestId, state: receipt.outcome, applied: false });
      }
      if (current.state !== 'processing' || current.claim_token !== input.claimToken
          || !current.claim_expires_at || current.claim_expires_at.getTime() <= now.getTime()) {
        throw new PersistenceIdempotencyConflictError();
      }
      const inserted = await client.query(
        `INSERT INTO ti_generation_completions
          (request_id, callback_id, correlation_id, input_hash, callback_ref, outcome, result_hash, failure_class, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [input.requestId, input.callbackId, input.correlationId, input.inputHash, input.callbackRef,
          input.outcome, input.resultHash, input.failureClass ?? null, now],
      );
      if (inserted.rowCount !== 1) throw new PersistenceIdempotencyConflictError();
      await client.query(
        `UPDATE ti_generation_requests
         SET state = $2, claim_token = NULL, claim_expires_at = NULL, next_attempt_at = NULL,
             last_failure_class = $3, updated_at = $4 WHERE request_id = $1`,
        [input.requestId, input.outcome, input.failureClass ?? null, now],
      );
      await client.query('COMMIT');
      return Object.freeze({ requestId: input.requestId, state: input.outcome, applied: true });
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Identity-matched, content-free status lookup; a mismatch is intentionally indistinguishable from missing. */
  async reconcileGenerationRequest(requestId: string, correlationId: string): Promise<GenerationRequestStatus | null> {
    assertNonEmptyString(requestId, 'requestId');
    assertNonEmptyString(correlationId, 'correlationId');
    const now = this.now();
    const result = await this.pool.query(
      `SELECT request_id, operation_kind, state, attempt_count, wait_expires_at, updated_at,
              retention_class, created_at, last_failure_class
       FROM ti_generation_requests WHERE request_id = $1 AND correlation_id = $2`,
      [requestId, correlationId],
    );
    const row = result.rows[0];
    if (!row || !this.isRetained(row.retention_class, row.created_at, now)) return null;
    return Object.freeze({
      requestId: row.request_id,
      operationKind: row.operation_kind,
      state: row.state,
      attemptCount: row.attempt_count,
      waitExpiresAt: row.wait_expires_at,
      updatedAt: row.updated_at,
      ...(row.last_failure_class === null ? {} : { lastFailureClass: row.last_failure_class }),
    });
  }

  /**
   * Compatibility-safe enqueue transition. Processing and terminal states can only be changed
   * by an atomic claim/release/completion operation, never by a counter-only update.
   */
  async updateRequestState(requestId: string, state: GenerationRequestInput['state'], attemptCount: number): Promise<void> {
    assertNonEmptyString(requestId, 'requestId');
    if (state !== 'queued') throw new Error('processing and terminal states require atomic claim or completion operations');
    if (!Number.isSafeInteger(attemptCount) || attemptCount !== 0) throw new Error('enqueue cannot change attemptCount');
    const now = this.now();
    const updated = await this.pool.query(
      `UPDATE ti_generation_requests SET state = 'queued', updated_at = $2
       WHERE request_id = $1 AND state = 'accepted' AND attempt_count = 0 AND ${retainedRequestPredicate(this.policy, 'ti_generation_requests', '$2', 3).sql}`,
      [requestId, now, ...retainedRequestPredicate(this.policy, 'ti_generation_requests', '$2', 3).values],
    );
    if (updated.rowCount !== 1) throw new Error('generation request cannot be enqueued from its current state');
  }

  /** Delete at most one bounded batch per retention class; classes with null age are intentionally retained. */
  async purgeExpiredRecords(batchSize = 500): Promise<RetentionPurgeResult> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new Error('batchSize must be a safe integer between 1 and 10000');
    }
    const now = this.now();
    const totals = { evidenceBundles: 0, generationRequests: 0, artifacts: 0 };
    for (const [retentionClass, maxAgeMs] of Object.entries(this.policy.maxRetentionAgeMsByClass)) {
      if (maxAgeMs === null) continue;
      const cutoff = new Date(now.getTime() - maxAgeMs);
      const evidence = await this.pool.query(
        `WITH expired AS (
          SELECT evidence_id FROM ti_evidence_bundles
          WHERE retention_class = $1 AND created_at <= $2
          ORDER BY created_at, evidence_id LIMIT $3
        )
        DELETE FROM ti_evidence_bundles AS target USING expired
        WHERE target.evidence_id = expired.evidence_id`,
        [retentionClass, cutoff, batchSize],
      );
      const requestClient = await this.pool.connect();
      let requestDeleteCount = 0;
      try {
        await requestClient.query('BEGIN');
        const expiredRequests = await requestClient.query<{ request_id: string }>(
          `SELECT request_id FROM ti_generation_requests
           WHERE retention_class = $1 AND created_at <= $2
           ORDER BY created_at, request_id LIMIT $3 FOR UPDATE SKIP LOCKED`,
          [retentionClass, cutoff, batchSize],
        );
        const requestIds = expiredRequests.rows.map((row) => row.request_id);
        if (requestIds.length > 0) {
          await requestClient.query(
            'DELETE FROM ti_request_restricted_metadata WHERE request_id = ANY($1::text[])',
            [requestIds],
          );
          const deleted = await requestClient.query(
            'DELETE FROM ti_generation_requests WHERE request_id = ANY($1::text[])',
            [requestIds],
          );
          requestDeleteCount = deleted.rowCount ?? 0;
        }
        await requestClient.query('COMMIT');
      } catch (error) {
        await this.rollback(requestClient);
        throw error;
      } finally {
        requestClient.release();
      }
      const artifacts = await this.pool.query(
        `WITH expired AS (
          SELECT artifact_key, version FROM ti_artifacts AS candidate
          WHERE retention_class = $1 AND created_at <= $2
            AND NOT EXISTS (
              SELECT 1 FROM ti_evidence_bundles AS evidence
              WHERE evidence.artifact_key = candidate.artifact_key
                AND evidence.artifact_version = candidate.version
            )
          ORDER BY created_at, artifact_key, version LIMIT $3
        )
        DELETE FROM ti_artifacts AS target USING expired
        WHERE target.artifact_key = expired.artifact_key AND target.version = expired.version`,
        [retentionClass, cutoff, batchSize],
      );
      totals.evidenceBundles += evidence.rowCount ?? 0;
      totals.generationRequests += requestDeleteCount;
      totals.artifacts += artifacts.rowCount ?? 0;
    }
    return totals;
  }

  private async rollback(client: PoolClient): Promise<void> {
    try { await client.query('ROLLBACK'); } catch { /* preserve original transaction error */ }
  }
}
