import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { TiPersistence, type ArtifactInput, type EvidenceInput, type GenerationRequestInput } from "./persistence";

const databaseUrl = process.env.TI_TEST_DATABASE_URL;
const migration = await readFile(new URL("./migrations/001_ti_persistence.sql", import.meta.url), "utf8");
if (!databaseUrl) {
  console.error("BLOCKED: real PostgreSQL TI persistence qualification requires TI_TEST_DATABASE_URL; pg-mem is not used as a substitute.");
}

const artifact = (overrides: Partial<ArtifactInput> = {}): ArtifactInput => ({
  artifactKey: "synthetic-pg-artifact-01",
  artifactType: "summary",
  postId: "synthetic-pg-post-01",
  postContentVersion: "synthetic-post-version-02",
  outputLanguage: "fr",
  payload: { summary: "Synthetic PostgreSQL-backed artifact." },
  groundingMode: "cg_only",
  citations: [],
  limitations: ["Synthetic test limitation."],
  schemaVersion: 1,
  promptVersion: "synthetic-prompt-version-01",
  moderationState: "approved",
  status: "ready",
  retentionClass: "synthetic-test-policy-unset",
  ...overrides,
});

const request = (overrides: Partial<GenerationRequestInput> = {}): GenerationRequestInput => ({
  idempotencyKey: "synthetic-pg-idempotency-01",
  operationKind: "summary",
  inputHash: "synthetic-input-hash-01",
  state: "accepted",
  correlationId: "synthetic-correlation-01",
  waitExpiresAt: new Date("2026-11-26T08:00:00.000Z"),
  retentionClass: "synthetic-test-policy-unset",
  quotaSubject: "synthetic-restricted-quota-subject",
  ...overrides,
});

test("isolated real PostgreSQL migration, rollback, persistence, restricted metadata, and concurrency", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl, "test skip guard requires TI_TEST_DATABASE_URL");
  const adminPool = new Pool({ connectionString: databaseUrl, max: 16 });
  const schema = `ti_test_${randomUUID().replaceAll("-", "")}`;
  let servicePool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);

    // Exercise a real migration rollback before applying the same SQL successfully.
    const migrationClient = await adminPool.connect();
    try {
      await migrationClient.query(`SET search_path TO ${schema}`);
      await migrationClient.query("BEGIN");
      await migrationClient.query(migration);
      await migrationClient.query("ROLLBACK");
      const rolledBack = await migrationClient.query("SELECT to_regclass('ti_artifacts') AS table_name");
      assert.equal(rolledBack.rows[0].table_name, null, "migration rollback must remove all created relations");
      await migrationClient.query("BEGIN");
      await migrationClient.query(migration);
      await migrationClient.query("COMMIT");
    } finally {
      migrationClient.release();
    }

    servicePool = new Pool({
      connectionString: databaseUrl,
      max: 16,
      options: `-c search_path=${schema}`,
    });
    const persistence = new TiPersistence(servicePool);

    // Create/read/versioning and prove failed publication leaves the valid current row intact.
    assert.equal(await persistence.publishArtifact(artifact()), 1);
    const first = await persistence.getArtifact("synthetic-pg-artifact-01");
    assert.equal(first?.version, 1);
    assert.equal(first?.isCurrent, true);
    assert.deepEqual(first?.payload, { summary: "Synthetic PostgreSQL-backed artifact." });
    assert.equal(await persistence.publishArtifact(artifact({ payload: { summary: "Synthetic version two." } })), 2);
    assert.equal((await persistence.getArtifact("synthetic-pg-artifact-01", 1))?.isCurrent, false);
    assert.equal((await persistence.getArtifact("synthetic-pg-artifact-01"))?.version, 2);

    const validCurrent = await persistence.getArtifact("synthetic-pg-artifact-01");
    await assert.rejects(
      persistence.publishArtifact(artifact({ artifactType: "not-a-supported-type" as ArtifactInput["artifactType"] })),
      /check constraint/i,
    );
    const afterFailure = await persistence.getArtifact("synthetic-pg-artifact-01");
    assert.equal(afterFailure?.version, validCurrent?.version);
    assert.equal(afterFailure?.isCurrent, true, "failed insert must atomically preserve prior current publication");

    const evidence: EvidenceInput = {
      artifactKey: "synthetic-pg-artifact-01",
      artifactVersion: 2,
      postId: "synthetic-pg-post-01",
      postContentVersion: "synthetic-post-version-02",
      groundingMode: "cg_only",
      sourceSnapshots: [],
      evidencePayload: { rationale: "Synthetic evidence payload." },
      schemaVersion: 1,
      retentionClass: "synthetic-test-policy-unset",
    };
    const evidenceId = await persistence.storeEvidence(evidence);
    const readEvidence = await persistence.getEvidence(evidenceId);
    assert.equal(readEvidence?.artifactVersion, 2);
    assert.deepEqual(readEvidence?.evidencePayload, { rationale: "Synthetic evidence payload.", sourceSnapshots: [] });

    // Request creation/read includes no quota subject; the restricted record is separate.
    const created = await persistence.createOrGetGenerationRequest(request());
    assert.equal(created.created, true);
    const storedRequest = await persistence.getGenerationRequest(created.requestId);
    assert.equal(storedRequest?.inputHash, "synthetic-input-hash-01");
    assert.equal(storedRequest && "quotaSubject" in storedRequest, false);
    const restricted = await servicePool.query(
      "SELECT quota_subject FROM ti_request_restricted_metadata WHERE request_id = $1",
      [created.requestId],
    );
    assert.equal(restricted.rows[0].quota_subject, "synthetic-restricted-quota-subject");
    const publicPrivileges = await servicePool.query(
      `SELECT COALESCE(bool_or(privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')), FALSE) AS has_public_dml
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
       WHERE n.nspname = $1 AND c.relname = 'ti_request_restricted_metadata' AND acl.grantee = 0`,
      [schema],
    );
    assert.equal(publicPrivileges.rows[0].has_public_dml, false, "restricted metadata must not grant PUBLIC table access");

    // Real concurrent transactions exercise PostgreSQL row locking and the unique idempotency key.
    const concurrentInput = request({
      requestId: undefined,
      idempotencyKey: "synthetic-pg-concurrent-key-01",
      inputHash: "synthetic-pg-concurrent-hash-01",
    });
    const concurrent = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      persistence.createOrGetGenerationRequest({
        ...concurrentInput,
        requestId: `synthetic-concurrent-request-${index}`,
        quotaSubject: `synthetic-concurrent-quota-${index}`,
      }),
    ));
    assert.equal(new Set(concurrent.map((result) => result.requestId)).size, 1);
    assert.equal(concurrent.filter((result) => result.created).length, 1);
    const count = await servicePool.query(
      "SELECT COUNT(*)::integer AS count FROM ti_generation_requests WHERE operation_kind = $1 AND idempotency_key = $2",
      [concurrentInput.operationKind, concurrentInput.idempotencyKey],
    );
    assert.equal(count.rows[0].count, 1);
    await assert.rejects(
      persistence.createOrGetGenerationRequest({ ...concurrentInput, inputHash: "synthetic-different-input-hash" }),
      /different input/,
    );
  } finally {
    await servicePool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
});
