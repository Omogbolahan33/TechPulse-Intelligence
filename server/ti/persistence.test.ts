import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { newDb } from 'pg-mem';
import { TiPersistence, type ArtifactInput, type EvidenceInput, type GenerationRequestInput } from './persistence';

const schema = `
CREATE TABLE ti_artifact_keys (artifact_key TEXT PRIMARY KEY);
CREATE TABLE ti_artifacts (
 artifact_key TEXT NOT NULL, version INTEGER NOT NULL, artifact_type TEXT NOT NULL, post_id TEXT NOT NULL,
 post_content_version TEXT, content_hash TEXT, output_language TEXT NOT NULL, payload JSONB NOT NULL,
 grounding_mode TEXT NOT NULL, citations JSONB NOT NULL, limitations JSONB NOT NULL, schema_version INTEGER NOT NULL,
 prompt_version TEXT NOT NULL, moderation_state TEXT NOT NULL, status TEXT NOT NULL, retention_class TEXT NOT NULL,
 is_current BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL, CHECK (schema_version > 0), PRIMARY KEY (artifact_key, version)
);
CREATE UNIQUE INDEX ti_artifacts_one_current_per_key ON ti_artifacts (artifact_key) WHERE is_current = TRUE;
CREATE TABLE ti_evidence_bundles (
 evidence_id TEXT PRIMARY KEY, artifact_key TEXT NOT NULL, artifact_version INTEGER NOT NULL, post_id TEXT NOT NULL,
 post_content_version TEXT, content_hash TEXT, grounding_mode TEXT NOT NULL, source_snapshot_refs JSONB NOT NULL,
 evidence_payload JSONB NOT NULL, schema_version INTEGER NOT NULL, retention_class TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY (artifact_key, artifact_version) REFERENCES ti_artifacts (artifact_key, version)
);
CREATE TABLE ti_generation_requests (
 request_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, operation_kind TEXT NOT NULL, input_hash TEXT NOT NULL,
 state TEXT NOT NULL, attempt_count INTEGER NOT NULL, correlation_id TEXT NOT NULL, wait_expires_at TIMESTAMPTZ NOT NULL,
 callback_ref TEXT, reconciliation_ref TEXT, retention_class TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL, UNIQUE (operation_kind, idempotency_key)
);
CREATE TABLE ti_request_restricted_metadata (
 request_id TEXT PRIMARY KEY REFERENCES ti_generation_requests (request_id), quota_subject TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);`;

async function setup() {
  const db = newDb();
  db.public.none(schema);
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  return { persistence: new TiPersistence(pool as never), pool };
}

const artifact = (overrides: Partial<ArtifactInput> = {}): ArtifactInput => ({
  artifactKey: 'ti-artifact-synthetic-1',
  artifactType: 'summary',
  postId: 'post-synthetic-1',
  postContentVersion: 'post-version-2',
  outputLanguage: 'en',
  payload: { summary: 'Synthetic summary.', personaId: 'General' },
  groundingMode: 'cg_plus_source',
  citations: [{ sourceId: 'source-synthetic-1', quote: 'Synthetic excerpt.' }],
  limitations: ['Synthetic limitation.'],
  schemaVersion: 1,
  promptVersion: 'prompt-test-v1',
  moderationState: 'approved',
  status: 'ready',
  retentionClass: 'test-unset-duration',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const request = (overrides: Partial<GenerationRequestInput> = {}): GenerationRequestInput => ({
  requestId: 'request-synthetic-1',
  idempotencyKey: 'idem-synthetic-1',
  operationKind: 'summary',
  inputHash: 'hash-synthetic-1',
  state: 'accepted',
  attemptCount: 0,
  correlationId: 'correlation-synthetic-1',
  waitExpiresAt: new Date('2026-01-01T00:01:00.000Z'),
  retentionClass: 'test-unset-duration',
  quotaSubject: 'synthetic-quota-subject-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

test('stores immutable artifact versions and switches current pointer atomically', async () => {
  const { persistence, pool } = await setup();
  try {
    assert.equal(await persistence.publishArtifact(artifact()), 1);
    assert.equal(await persistence.publishArtifact(artifact({ payload: { summary: 'Updated synthetic summary.' } })), 2);
    const { rows } = await pool.query('SELECT version, is_current, status, payload FROM ti_artifacts ORDER BY version');
    assert.deepEqual(rows.map((row: { version: number; is_current: boolean; status: string }) => [row.version, row.is_current, row.status]), [[1, false, 'ready'], [2, true, 'ready']]);
    assert.deepEqual(rows[0].payload, { summary: 'Synthetic summary.', personaId: 'General' });
    assert.equal((await persistence.getArtifact('ti-artifact-synthetic-1'))?.version, 2);
    assert.equal((await persistence.getArtifact('ti-artifact-synthetic-1'))?.isCurrent, true);
    assert.equal(await persistence.getArtifact('missing-artifact'), null);
  } finally { await pool.end(); }
});

test('artifact insert failure requests transaction rollback after demoting the old version', async () => {
  const { persistence, pool } = await setup();
  try {
    await persistence.publishArtifact(artifact());
    const client = await pool.connect();
    const originalQuery = client.query.bind(client);
    const statements: string[] = [];
    client.query = (async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (sql.startsWith('INSERT INTO ti_artifacts')) throw new Error('synthetic insert failure');
      return originalQuery(sql, values);
    }) as typeof client.query;
    const originalConnect = pool.connect.bind(pool);
    pool.connect = (async () => client) as typeof pool.connect;
    await assert.rejects(persistence.publishArtifact(artifact({ payload: { summary: 'new' } })), /synthetic insert failure/);
    assert.ok(statements.includes('ROLLBACK'));
    assert.ok(!statements.includes('COMMIT'));
    pool.connect = originalConnect;
    client.query = originalQuery;
    client.release();
  } finally { await pool.end(); }
});

test('stores bounded source evidence with provenance and a versioned artifact link', async () => {
  const { persistence, pool } = await setup();
  try {
    await persistence.publishArtifact(artifact());
    const evidence: EvidenceInput = {
      artifactKey: 'ti-artifact-synthetic-1', artifactVersion: 1, postId: 'post-synthetic-1',
      postContentVersion: 'post-version-2', groundingMode: 'cg_plus_source', schemaVersion: 1,
      retentionClass: 'test-unset-duration', sourceSnapshots: [{
        sourceId: 'source-synthetic-1', sourceType: 'publisher', sourceVersion: 'source-rev-3',
        contentHash: 'hash-synthetic-source', title: 'Synthetic source title',
        url: 'https://publisher.example/synthetic', retrievedAt: '2026-01-01T00:00:00Z',
        excerpt: 'Privacy-cleared synthetic excerpt.',
      }],
      evidencePayload: { rationale: 'Synthetic grounded rationale.' },
    };
    const evidenceId = await persistence.storeEvidence(evidence);
    const result = await pool.query('SELECT artifact_version, source_snapshot_refs, evidence_payload FROM ti_evidence_bundles WHERE evidence_id = $1', [evidenceId]);
    assert.equal(result.rows[0].artifact_version, 1);
    assert.deepEqual(result.rows[0].source_snapshot_refs, [{ sourceId: 'source-synthetic-1', sourceType: 'publisher', sourceVersion: 'source-rev-3', contentHash: 'hash-synthetic-source' }]);
    assert.equal(result.rows[0].evidence_payload.sourceSnapshots[0].excerpt, 'Privacy-cleared synthetic excerpt.');
    assert.equal((await persistence.getEvidence(evidenceId))?.sourceSnapshots[0].sourceVersion, 'source-rev-3');
    assert.equal(await persistence.getEvidence('missing-evidence'), null);
    await assert.rejects(persistence.storeEvidence({ ...evidence, artifactVersion: 99 }), /foreign key/i);
    await assert.rejects(persistence.storeEvidence({ ...evidence, sourceSnapshots: [{ sourceId: 'source-no-version', sourceType: 'test' }] }), /sourceVersion or contentHash/);
    await assert.rejects(persistence.storeEvidence({ ...evidence, sourceSnapshots: Array.from({ length: 21 }, (_, i) => ({ sourceId: `source-${i}`, sourceType: 'test', sourceVersion: 'v1' })) }), /limit of 20/);
    await assert.rejects(persistence.publishArtifact(artifact({ payload: { largeSynthetic: 'x'.repeat(65_537) } })), /payload limit/);
  } finally { await pool.end(); }
});

test('generation requests replay idempotently and restricted quota metadata stays separate', async () => {
  const { persistence, pool } = await setup();
  try {
    const input = request();
    const a = await persistence.createOrGetGenerationRequest(input);
    const b = await persistence.createOrGetGenerationRequest({ ...input, requestId: 'request-synthetic-replay-2', quotaSubject: 'must-not-replace-original' });
    assert.equal(a.requestId, b.requestId);
    assert.equal(Number(a.created) + Number(b.created), 1);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM ti_generation_requests')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT quota_subject FROM ti_request_restricted_metadata')).rows[0].quota_subject, 'synthetic-quota-subject-1');
    await assert.rejects(pool.query(
      `INSERT INTO ti_generation_requests (request_id, idempotency_key, operation_kind, input_hash, state,
       attempt_count, correlation_id, wait_expires_at, retention_class, created_at, updated_at)
       VALUES ('request-synthetic-duplicate', 'idem-synthetic-1', 'summary', 'hash-synthetic-1', 'accepted',
       0, 'correlation-synthetic-duplicate', '2026-01-01T00:01:00Z', 'test-unset-duration', NOW(), NOW())`,
    ), /unique/i);
    await assert.rejects(persistence.createOrGetGenerationRequest({ ...input, inputHash: 'different-synthetic-hash' }), /different input/);
    await persistence.updateRequestState(a.requestId, 'processing', 1);
    const state = await pool.query('SELECT state, attempt_count FROM ti_generation_requests WHERE request_id = $1', [a.requestId]);
    assert.deepEqual(state.rows[0], { state: 'processing', attempt_count: 1 });
    const persisted = await persistence.getGenerationRequest(a.requestId);
    assert.equal(persisted?.state, 'processing');
    assert.ok(persisted && !('quotaSubject' in persisted));
    assert.equal(await persistence.getGenerationRequest('missing-request'), null);
    await assert.rejects(persistence.updateRequestState(a.requestId, 'failed', -1), /non-negative/);
  } finally { await pool.end(); }
});

test('SQL migration defines TI-owned tables and does not add canonical user or chat storage', async () => {
  const migration = await readFile(new URL('./migrations/001_ti_persistence.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ti_artifacts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ti_evidence_bundles/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ti_generation_requests/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ti_request_restricted_metadata/);
  assert.match(migration, /REVOKE ALL ON ti_request_restricted_metadata FROM PUBLIC/);
  assert.doesNotMatch(migration, /CREATE TABLE[^;]*(?:canonical_user|chat_message|raw_chat_archive)/i);
});
