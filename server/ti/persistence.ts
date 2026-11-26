import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type ArtifactStatus = 'ready' | 'stale' | 'hidden';
export type GroundingMode = 'cg_plus_source' | 'cg_only';

export interface ArtifactInput {
  artifactKey: string;
  artifactType: 'summary' | 'persona_implications';
  postId: string;
  postContentVersion?: string;
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
  postContentVersion?: string;
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
  createdAt?: Date;
}

export interface GenerationRequestResult {
  requestId: string;
  created: boolean;
}

export interface PersistedArtifact extends ArtifactInput {
  version: number;
  isCurrent: boolean;
}

export interface PersistedEvidence extends EvidenceInput {
  evidenceId: string;
  sourceSnapshotRefs: Array<Pick<SourceSnapshotInput, 'sourceId' | 'sourceType' | 'sourceVersion' | 'contentHash'>>;
}

export interface PersistedGenerationRequest extends Omit<GenerationRequestInput, 'quotaSubject'> {
  requestId: string;
  updatedAt: Date;
}

const immutableJson = (value: unknown): string => JSON.stringify(value);
const assertJsonBudget = (value: unknown, maxBytes: number, label: string): void => {
  if (Buffer.byteLength(immutableJson(value), 'utf8') > maxBytes) throw new Error(`${label} exceeds the persistence payload limit`);
};

/** Versioned, bounded persistence for TI-owned artifacts and request metadata. */
export class TiPersistence {
  constructor(private readonly pool: Pool) {}

  async publishArtifact(input: ArtifactInput): Promise<number> {
    if (!input.postContentVersion && !input.contentHash) {
      throw new Error('postContentVersion or contentHash is required');
    }
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
          input.moderationState, input.status, input.retentionClass, input.createdAt ?? new Date()],
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

  async getArtifact(artifactKey: string, version?: number): Promise<PersistedArtifact | null> {
    const result = version === undefined
      ? await this.pool.query('SELECT * FROM ti_artifacts WHERE artifact_key = $1 AND is_current = TRUE', [artifactKey])
      : await this.pool.query('SELECT * FROM ti_artifacts WHERE artifact_key = $1 AND version = $2', [artifactKey, version]);
    const row = result.rows[0];
    if (!row) return null;
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
    if (input.sourceSnapshots.length > 20) throw new Error('sourceSnapshots exceeds the per-evidence limit of 20');
    if (input.sourceSnapshots.some((source) => !source.sourceId || !source.sourceType || (!source.sourceVersion && !source.contentHash))) {
      throw new Error('each source snapshot requires an id, type, and sourceVersion or contentHash');
    }
    if (!input.postContentVersion && !input.contentHash) throw new Error('postContentVersion or contentHash is required');
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
    await this.pool.query(
      `INSERT INTO ti_evidence_bundles (
        evidence_id, artifact_key, artifact_version, post_id, post_content_version, content_hash, grounding_mode,
        source_snapshot_refs, evidence_payload, schema_version, retention_class, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)`,
      [evidenceId, input.artifactKey, input.artifactVersion, input.postId, input.postContentVersion ?? null,
        input.contentHash ?? null, input.groundingMode, immutableJson(sourceSnapshotRefs), immutableJson(evidencePayload),
        input.schemaVersion, input.retentionClass, input.createdAt ?? new Date()],
    );
    return evidenceId;
  }

  async getEvidence(evidenceId: string): Promise<PersistedEvidence | null> {
    const result = await this.pool.query('SELECT * FROM ti_evidence_bundles WHERE evidence_id = $1', [evidenceId]);
    const row = result.rows[0];
    if (!row) return null;
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
        if (prior.rows[0].input_hash !== input.inputHash) throw new Error('idempotency key was already used with different input');
        await client.query('COMMIT');
        return { requestId: prior.rows[0].request_id, created: false };
      }
      const inserted = await client.query<{ request_id: string }>(
        `INSERT INTO ti_generation_requests (
          request_id, idempotency_key, operation_kind, input_hash, state, attempt_count, correlation_id,
          wait_expires_at, callback_ref, reconciliation_ref, retention_class, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        ON CONFLICT (operation_kind, idempotency_key) DO NOTHING RETURNING request_id`,
        [requestId, input.idempotencyKey, input.operationKind, input.inputHash, input.state, input.attemptCount ?? 0,
          input.correlationId, input.waitExpiresAt, input.callbackRef ?? null, input.reconciliationRef ?? null,
          input.retentionClass, input.createdAt ?? new Date()],
      );
      if (inserted.rowCount === 1) {
        await client.query(
          'INSERT INTO ti_request_restricted_metadata (request_id, quota_subject, created_at) VALUES ($1,$2,$3)',
          [requestId, input.quotaSubject, input.createdAt ?? new Date()],
        );
        await client.query('COMMIT');
        return { requestId, created: true };
      }
      const existing = await client.query<{ request_id: string; input_hash: string }>(
        'SELECT request_id, input_hash FROM ti_generation_requests WHERE operation_kind = $1 AND idempotency_key = $2',
        [input.operationKind, input.idempotencyKey],
      );
      if (!existing.rows[0] || existing.rows[0].input_hash !== input.inputHash) {
        throw new Error('idempotency key was already used with different input');
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
    const result = await this.pool.query('SELECT * FROM ti_generation_requests WHERE request_id = $1', [requestId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      requestId: row.request_id, idempotencyKey: row.idempotency_key, operationKind: row.operation_kind,
      inputHash: row.input_hash, state: row.state, attemptCount: row.attempt_count,
      correlationId: row.correlation_id, waitExpiresAt: row.wait_expires_at,
      callbackRef: row.callback_ref ?? undefined, reconciliationRef: row.reconciliation_ref ?? undefined,
      retentionClass: row.retention_class, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async updateRequestState(requestId: string, state: GenerationRequestInput['state'], attemptCount: number): Promise<void> {
    if (!Number.isInteger(attemptCount) || attemptCount < 0) throw new Error('attemptCount must be a non-negative integer');
    const result = await this.pool.query(
      'UPDATE ti_generation_requests SET state = $2, attempt_count = $3, updated_at = NOW() WHERE request_id = $1',
      [requestId, state, attemptCount],
    );
    if (result.rowCount !== 1) throw new Error('generation request not found');
  }

  private async rollback(client: PoolClient): Promise<void> {
    try { await client.query('ROLLBACK'); } catch { /* preserve original transaction error */ }
  }
}
