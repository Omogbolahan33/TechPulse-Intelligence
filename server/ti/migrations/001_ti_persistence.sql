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

CREATE INDEX IF NOT EXISTS ti_artifacts_retention_created_at_idx
  ON ti_artifacts (retention_class, created_at, artifact_key, version);

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

CREATE INDEX IF NOT EXISTS ti_evidence_retention_created_at_idx
  ON ti_evidence_bundles (retention_class, created_at, evidence_id);

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
  claim_token TEXT,
  claim_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_failure_class TEXT,
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (operation_kind, idempotency_key),
  CONSTRAINT ti_generation_requests_claim_pair_check
    CHECK ((claim_token IS NULL AND claim_expires_at IS NULL)
        OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND state = 'processing')),
  CONSTRAINT ti_generation_requests_failure_class_check
    CHECK (last_failure_class IS NULL OR last_failure_class IN ('worker_lease_expired', 'generation_failed', 'validation_failed', 'worker_shutdown'))
);

ALTER TABLE ti_generation_requests ADD COLUMN IF NOT EXISTS claim_token TEXT;
ALTER TABLE ti_generation_requests ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;
ALTER TABLE ti_generation_requests ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE ti_generation_requests ADD COLUMN IF NOT EXISTS last_failure_class TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ti_generation_requests_claim_pair_check'
      AND conrelid = 'ti_generation_requests'::regclass
  ) THEN
    ALTER TABLE ti_generation_requests
      ADD CONSTRAINT ti_generation_requests_claim_pair_check
      CHECK ((claim_token IS NULL AND claim_expires_at IS NULL)
          OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND state = 'processing'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ti_generation_requests_failure_class_check'
      AND conrelid = 'ti_generation_requests'::regclass
  ) THEN
    ALTER TABLE ti_generation_requests
      ADD CONSTRAINT ti_generation_requests_failure_class_check
      CHECK (last_failure_class IS NULL OR last_failure_class IN ('worker_lease_expired', 'generation_failed', 'validation_failed', 'worker_shutdown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ti_generation_requests_retention_created_at_idx
  ON ti_generation_requests (retention_class, created_at, request_id);

-- Queue scans remain bounded, stable and lock-safe across multiple workers.
CREATE INDEX IF NOT EXISTS ti_generation_requests_queue_idx
  ON ti_generation_requests (state, next_attempt_at, created_at, request_id)
  WHERE state IN ('accepted', 'queued');

CREATE INDEX IF NOT EXISTS ti_generation_requests_claim_expiry_idx
  ON ti_generation_requests (claim_expires_at, created_at, request_id)
  WHERE state = 'processing';

CREATE TABLE IF NOT EXISTS ti_generation_completions (
  request_id TEXT PRIMARY KEY REFERENCES ti_generation_requests (request_id) ON DELETE CASCADE,
  callback_id TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  callback_ref TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ready', 'failed')),
  result_hash TEXT NOT NULL,
  failure_class TEXT CHECK (failure_class IN ('generation_failed', 'validation_failed')),
  completed_at TIMESTAMPTZ NOT NULL,
  CHECK ((outcome = 'ready' AND failure_class IS NULL) OR (outcome = 'failed' AND failure_class IS NOT NULL))
);

-- Restricted quota subject is stored separately from shared artifact/request records.
CREATE TABLE IF NOT EXISTS ti_request_restricted_metadata (
  request_id TEXT PRIMARY KEY REFERENCES ti_generation_requests (request_id) ON DELETE CASCADE,
  quota_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
REVOKE ALL ON ti_request_restricted_metadata FROM PUBLIC;
