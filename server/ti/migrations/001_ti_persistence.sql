CREATE TABLE IF NOT EXISTS ti_artifact_keys (
  artifact_key TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS ti_artifacts (
  artifact_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('summary', 'persona_implications')),
  post_id TEXT NOT NULL,
  post_content_version TEXT,
  content_hash TEXT,
  output_language TEXT NOT NULL,
  payload JSONB NOT NULL,
  grounding_mode TEXT NOT NULL CHECK (grounding_mode IN ('cg_plus_source', 'cg_only')),
  citations JSONB NOT NULL,
  limitations JSONB NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  prompt_version TEXT NOT NULL,
  moderation_state TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'stale', 'hidden')),
  retention_class TEXT NOT NULL,
  is_current BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (artifact_key, version),
  CHECK (post_content_version IS NOT NULL OR content_hash IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ti_artifacts_one_current_per_key
  ON ti_artifacts (artifact_key) WHERE is_current = TRUE;

CREATE TABLE IF NOT EXISTS ti_evidence_bundles (
  evidence_id TEXT PRIMARY KEY,
  artifact_key TEXT NOT NULL,
  artifact_version INTEGER NOT NULL,
  post_id TEXT NOT NULL,
  post_content_version TEXT,
  content_hash TEXT,
  grounding_mode TEXT NOT NULL CHECK (grounding_mode IN ('cg_plus_source', 'cg_only')),
  source_snapshot_refs JSONB NOT NULL,
  evidence_payload JSONB NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (artifact_key, artifact_version)
    REFERENCES ti_artifacts (artifact_key, version),
  CHECK (post_content_version IS NOT NULL OR content_hash IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ti_generation_requests (
  request_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('summary', 'pros_cons', 'deep_dive')),
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'processing', 'ready', 'failed')),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  correlation_id TEXT NOT NULL,
  wait_expires_at TIMESTAMPTZ NOT NULL,
  callback_ref TEXT,
  reconciliation_ref TEXT,
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (operation_kind, idempotency_key)
);

-- Restricted quota subject is stored separately from shared artifact/request records.
CREATE TABLE IF NOT EXISTS ti_request_restricted_metadata (
  request_id TEXT PRIMARY KEY REFERENCES ti_generation_requests (request_id),
  quota_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
REVOKE ALL ON ti_request_restricted_metadata FROM PUBLIC;
