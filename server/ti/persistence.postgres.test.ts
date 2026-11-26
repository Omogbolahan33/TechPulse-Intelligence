import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  callbackRef: "synthetic-callback-ref-01",
  waitExpiresAt: new Date(Date.now() + 30_000),
  retentionClass: "synthetic-test-policy-unset",
  quotaSubject: "synthetic-restricted-quota-subject",
  ...overrides,
});

test("production persistence refuses absent or invalid owner-approved retention policy evidence", () => {
  const poolWithoutConnections = {} as unknown as Pool;
  const base = {
    maxWaitHorizonMs: 120_000,
    maxRetentionAgeMsByClass: { "synthetic-test-class": 86_400_000 },
  };
  assert.throws(
    () => new TiPersistence(poolWithoutConnections, { ...base, runtimeMode: "production" }),
    /requires owner-approved retention policy evidence/,
  );
  assert.throws(
    () => new TiPersistence(poolWithoutConnections, {
      ...base,
      runtimeMode: "production",
      retentionPolicyApproval: {
        status: "approved",
        ownerRole: "builder" as never,
        approvalReference: "synthetic-unapproved-owner-reference",
      },
    }),
    /authorized owner role/,
  );
  assert.doesNotThrow(() => new TiPersistence(poolWithoutConnections, {
    ...base,
    runtimeMode: "production",
    retentionPolicyApproval: {
      status: "approved",
      ownerRole: "operations",
      approvalReference: "synthetic-owner-approved-policy-reference",
    },
  }));
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
      const retentionIndexes = await migrationClient.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[])",
        [schema, [
          "ti_artifacts_retention_created_at_idx",
          "ti_evidence_retention_created_at_idx",
          "ti_generation_requests_retention_created_at_idx",
          "ti_generation_requests_queue_idx",
          "ti_generation_requests_claim_expiry_idx",
        ]],
      );
      assert.equal(retentionIndexes.rowCount, 5, "retention and queue indexes are created by the migration");
      const completionTable = await migrationClient.query(
        "SELECT to_regclass($1) AS table_name",
        [`${schema}.ti_generation_completions`],
      );
      assert.equal(completionTable.rows[0].table_name, `${schema}.ti_generation_completions`);
      await migrationClient.query('BEGIN');
      await migrationClient.query(migration);
      await migrationClient.query('COMMIT');
    } finally {
      migrationClient.release();
    }

    servicePool = new Pool({
      connectionString: databaseUrl,
      max: 16,
      options: `-c search_path=${schema}`,
    });
    const retentionAges: Record<string, number | null> = {
      "synthetic-test-policy-unset": 86_400_000,
      "synthetic-short-retention": 1_000,
      "synthetic-indefinite-retention": null,
    };
    const persistence = new TiPersistence(servicePool, {
      runtimeMode: 'test',
      maxWaitHorizonMs: 120_000,
      maxRetentionAgeMsByClass: retentionAges,
    });
    // Policy is snapshotted at construction; later configuration mutation cannot alter cleanup or read behavior.
    retentionAges["synthetic-test-policy-unset"] = 1_000;

    // Create/read/versioning and prove failed publication leaves the valid current row intact.
    assert.equal(await persistence.publishArtifact(artifact()), 1);
    const first = await persistence.getArtifact("synthetic-pg-artifact-01");
    assert.equal(first?.version, 1);
    assert.equal(first?.isCurrent, true);
    assert.deepEqual(first?.payload, { summary: "Synthetic PostgreSQL-backed artifact." });
    assert.equal(await persistence.publishArtifact(artifact({ payload: { summary: "Synthetic version two." } })), 2);
    const auditedV1 = await persistence.getArtifactVersionForAudit("synthetic-pg-artifact-01", 1);
    assert.equal(auditedV1?.isCurrent, false);
    assert.equal(auditedV1?.status, "ready");
    assert.equal((await persistence.getArtifact("synthetic-pg-artifact-01"))?.version, 2);

    const validCurrent = await persistence.getArtifact("synthetic-pg-artifact-01");
    await assert.rejects(
      persistence.publishArtifact(artifact({ artifactType: "not-a-supported-type" as ArtifactInput["artifactType"] })),
      /check constraint/i,
    );
    const afterFailure = await persistence.getArtifact("synthetic-pg-artifact-01");
    assert.equal(afterFailure?.version, validCurrent?.version);
    assert.equal(afterFailure?.isCurrent, true, "failed insert must atomically preserve prior current publication");
    await assert.rejects(
      persistence.publishArtifact(artifact({ retentionClass: "unconfigured-retention-class" })),
      /retentionClass is not present in the configured retention policy/,
    );
    const artifactRowsBeforePrivacyReject = await servicePool.query(
      "SELECT COUNT(*)::integer AS count FROM ti_artifacts WHERE artifact_key = $1",
      ["synthetic-pg-artifact-01"],
    );
    await assert.rejects(
      persistence.publishArtifact(artifact({ payload: { summary: "Synthetic", userId: "must-not-persist" } })),
      /prohibited identity\/PII field/,
    );
    await assert.rejects(
      persistence.publishArtifact(artifact({ citations: [{ matchingUserIds: ["synthetic-private-id"] }] })),
      /prohibited identity\/PII field/,
    );
    await assert.rejects(
      persistence.publishArtifact(artifact({ payload: { rawChat: ["synthetic private text"] } })),
      /prohibited identity\/PII field/,
    );
    await assert.rejects(
      persistence.publishArtifact(artifact({ payload: { userMessage: "synthetic raw message" } })),
      /prohibited identity\/PII field/,
    );
    const cyclicPayload: Record<string, unknown> = {};
    cyclicPayload.self = cyclicPayload;
    await assert.rejects(persistence.publishArtifact(artifact({ payload: cyclicPayload })), /must not contain cycles/);
    const getterPayload = Object.defineProperty({}, "summary", {
      enumerable: true,
      get() { throw new Error("untrusted getter must not execute"); },
    });
    await assert.rejects(persistence.publishArtifact(artifact({ payload: getterPayload })), /enumerable data properties/);
    const artifactRowsAfterPrivacyReject = await servicePool.query(
      "SELECT COUNT(*)::integer AS count FROM ti_artifacts WHERE artifact_key = $1",
      ["synthetic-pg-artifact-01"],
    );
    assert.equal(artifactRowsAfterPrivacyReject.rows[0].count, artifactRowsBeforePrivacyReject.rows[0].count);

    const concurrentVersions = await Promise.all([
      persistence.publishArtifact(artifact({
        artifactKey: "synthetic-concurrent-publication",
        postContentVersion: "synthetic-writer-a-version",
        contentHash: "synthetic-writer-a-hash",
        payload: { summary: "Synthetic concurrent writer A." },
      })),
      persistence.publishArtifact(artifact({
        artifactKey: "synthetic-concurrent-publication",
        postContentVersion: "synthetic-writer-b-version",
        contentHash: "synthetic-writer-b-hash",
        payload: { summary: "Synthetic concurrent writer B." },
      })),
    ]);
    assert.deepEqual([...concurrentVersions].sort((left, right) => left - right), [1, 2]);
    const concurrentCurrent = await persistence.getArtifact("synthetic-concurrent-publication");
    assert.equal(concurrentCurrent?.version, 2);
    const winningPayload = (concurrentCurrent?.payload as { summary: string }).summary;
    if (winningPayload === "Synthetic concurrent writer A.") {
      assert.equal(concurrentCurrent?.postContentVersion, "synthetic-writer-a-version");
      assert.equal(concurrentCurrent?.contentHash, "synthetic-writer-a-hash");
    } else {
      assert.equal(winningPayload, "Synthetic concurrent writer B.");
      assert.equal(concurrentCurrent?.postContentVersion, "synthetic-writer-b-version");
      assert.equal(concurrentCurrent?.contentHash, "synthetic-writer-b-hash");
    }
    const concurrentVersionsInDatabase = await servicePool.query(
      "SELECT COUNT(*)::integer AS total, COUNT(*) FILTER (WHERE is_current)::integer AS current FROM ti_artifacts WHERE artifact_key = $1",
      ["synthetic-concurrent-publication"],
    );
    assert.equal(concurrentVersionsInDatabase.rows[0].total, 2);
    assert.equal(concurrentVersionsInDatabase.rows[0].current, 1);

    const numericVersionKey = 'synthetic-numeric-post-version';
    await persistence.publishArtifact(artifact({ artifactKey: numericVersionKey, postContentVersion: 0, contentHash: undefined }));
    assert.equal((await persistence.getArtifact(numericVersionKey))?.postContentVersion, '0',
      'numeric stable ID zero is valid and persists losslessly through the text column');

    const moderatedKey = "synthetic-moderation-override";
    await persistence.publishArtifact(artifact({ artifactKey: moderatedKey }));
    const moderationRaceReads = Promise.all(Array.from({ length: 16 }, () => persistence.getArtifact(moderatedKey)));
    const hidePublication = persistence.publishArtifact(artifact({ artifactKey: moderatedKey, status: "hidden" }));
    const [racedReads] = await Promise.all([moderationRaceReads, hidePublication]);
    assert.ok(racedReads.every((read) => read === null || (read.status === "ready" && read.isCurrent)),
      "a racing read may observe the pre-hide ready version or no result, never a hidden/stale version");
    assert.equal(await persistence.getArtifact(moderatedKey), null, "a hidden current version must override older ready cache data");
    assert.equal((await persistence.getArtifactVersionForAudit(moderatedKey, 1))?.isCurrent, false);
    const hiddenAuditVersion = await persistence.getArtifactVersionForAudit(moderatedKey, 2);
    assert.equal(hiddenAuditVersion?.status, "hidden");
    assert.equal(hiddenAuditVersion?.isCurrent, true);

    const staleKey = "synthetic-stale-current-artifact";
    await persistence.publishArtifact(artifact({ artifactKey: staleKey, status: "stale" }));
    assert.equal(await persistence.getArtifact(staleKey), null, "a stale current version is never returned as a cache hit");
    assert.equal((await persistence.getArtifactVersionForAudit(staleKey, 1))?.status, "stale");

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
    await assert.rejects(
      persistence.storeEvidence({ ...evidence, postContentVersion: "synthetic-wrong-post-version" }),
      /does not match the exact persisted artifact version/,
      "evidence must be bound to the artifact's exact canonical post snapshot",
    );
    await assert.rejects(
      persistence.storeEvidence({ ...evidence, groundingMode: "cg_plus_source" }),
      /does not match the exact persisted artifact version/,
      "evidence grounding mode must match the artifact's persisted mode",
    );
    await assert.rejects(
      persistence.storeEvidence({ ...evidence, artifactVersion: 99 }),
      /does not match the exact persisted artifact version/,
      "evidence cannot be attached to a nonexistent artifact version",
    );
    await assert.rejects(
      persistence.storeEvidence({ ...evidence, evidencePayload: { user: { profileVisibility: "synthetic" } } }),
      /prohibited identity\/PII field/,
    );
    const numericVersionEvidence = await persistence.storeEvidence({
      ...evidence,
      artifactKey: 'synthetic-numeric-post-version',
      artifactVersion: 1,
      postContentVersion: 0,
      contentHash: undefined,
    });
    assert.equal((await persistence.getEvidence(numericVersionEvidence))?.postContentVersion, '0',
      'evidence persistence accepts canonical numeric stable ID zero');

    // Request creation/read includes no quota subject; the restricted record is separate.
    await assert.rejects(
      persistence.createOrGetGenerationRequest(request({ idempotencyKey: "synthetic-expired-key", waitExpiresAt: new Date(Date.now() - 1) })),
      /waitExpiresAt must be in the future/,
    );
    await assert.rejects(
      persistence.createOrGetGenerationRequest(request({ idempotencyKey: "synthetic-unconfigured-retention-key", retentionClass: "unconfigured-retention-class" })),
      /retentionClass is not present in the configured retention policy/,
    );
    await assert.rejects(
      persistence.createOrGetGenerationRequest(request({ idempotencyKey: "synthetic-unbounded-key", waitExpiresAt: new Date(Date.now() + 121_000) })),
      /exceeds the configured 120000ms wait horizon/,
    );
    await assert.rejects(
      persistence.createOrGetGenerationRequest(request({ idempotencyKey: "synthetic-invalid-date-key", waitExpiresAt: new Date(Number.NaN) })),
      /waitExpiresAt must be a valid Date/,
    );
    const created = await persistence.createOrGetGenerationRequest(request());
    assert.equal(created.created, true);
    const storedRequest = await persistence.getGenerationRequest(created.requestId);
    assert.equal(storedRequest?.inputHash, "synthetic-input-hash-01");
    assert.equal(storedRequest && "quotaSubject" in storedRequest, false);
    const firstClaim = await persistence.claimNextGenerationRequest({ leaseDurationMs: 30_000, maxAttempts: 3 });
    assert.equal(firstClaim?.requestId, created.requestId);
    assert.equal(firstClaim?.attemptCount, 1);
    assert.ok(firstClaim?.claimToken);
    const processingStatus = await persistence.reconcileGenerationRequest(created.requestId, "synthetic-correlation-01");
    assert.equal(processingStatus?.state, "processing");
    assert.equal(await persistence.reconcileGenerationRequest(created.requestId, "wrong-correlation"), null);

    const scheduledRetry = await persistence.releaseGenerationRequestClaim({
      requestId: created.requestId,
      claimToken: firstClaim!.claimToken,
      failureClass: 'generation_failed',
      retryAt: new Date(Date.now()),
      maxAttempts: 3,
    });
    assert.equal(scheduledRetry, 'queued');
    const secondClaim = await persistence.claimNextGenerationRequest({ leaseDurationMs: 30_000, maxAttempts: 3 });
    assert.equal(secondClaim?.requestId, created.requestId);
    assert.equal(secondClaim?.attemptCount, 2);

    const callback = {
      requestId: created.requestId,
      correlationId: 'synthetic-correlation-01',
      inputHash: 'synthetic-input-hash-01',
      callbackRef: 'synthetic-callback-ref-01',
      callbackId: 'synthetic-callback-event-01',
      claimToken: secondClaim!.claimToken,
      outcome: 'ready' as const,
      resultHash: createHash('sha256').update('synthetic validated completion').digest('hex'),
    };
    assert.deepEqual(await persistence.completeGenerationRequest(callback), {
      requestId: created.requestId, state: 'ready', applied: true,
    });
    assert.deepEqual(await persistence.completeGenerationRequest(callback), {
      requestId: created.requestId, state: 'ready', applied: false,
    });
    await assert.rejects(
      persistence.completeGenerationRequest({ ...callback, resultHash: createHash('sha256').update('conflicting result').digest('hex') }),
      /different input/,
    );
    const updatedRequest = await persistence.getGenerationRequest(created.requestId);
    assert.equal(updatedRequest?.state, "ready");
    assert.equal(updatedRequest?.attemptCount, 2);
    assert.equal(updatedRequest?.lastFailureClass, undefined);
    const completionCount = await servicePool.query(
      'SELECT COUNT(*)::integer AS count FROM ti_generation_completions WHERE request_id = $1', [created.requestId],
    );
    assert.equal(completionCount.rows[0].count, 1, 'duplicate callbacks persist one content-free receipt');

    const leaseRequest = await persistence.createOrGetGenerationRequest(request({
      idempotencyKey: 'synthetic-lease-recovery-request',
      callbackRef: 'synthetic-lease-recovery-callback',
    }));
    const expiredClaim = await persistence.claimNextGenerationRequest({ leaseDurationMs: 5, maxAttempts: 3 });
    assert.equal(expiredClaim?.requestId, leaseRequest.requestId);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const recoveredClaim = await persistence.claimNextGenerationRequest({ leaseDurationMs: 30_000, maxAttempts: 3 });
    assert.equal(recoveredClaim?.requestId, leaseRequest.requestId);
    assert.equal(recoveredClaim?.attemptCount, 2, 'expired worker leases are reclaimed with monotonic attempts');
    const recoveredCompletion = {
      requestId: leaseRequest.requestId,
      correlationId: 'synthetic-correlation-01',
      inputHash: 'synthetic-input-hash-01',
      callbackRef: 'synthetic-lease-recovery-callback',
      callbackId: 'synthetic-lease-recovery-event',
      claimToken: recoveredClaim!.claimToken,
      outcome: 'ready' as const,
      resultHash: createHash('sha256').update('recovered result').digest('hex'),
    };
    assert.equal((await persistence.completeGenerationRequest(recoveredCompletion)).applied, true);

    const exhaustedLease = await persistence.createOrGetGenerationRequest(request({
      idempotencyKey: 'synthetic-exhausted-lease-request',
      callbackRef: 'synthetic-exhausted-lease-callback',
    }));
    const finalClaim = await persistence.claimNextGenerationRequest({ leaseDurationMs: 5, maxAttempts: 1 });
    assert.equal(finalClaim?.requestId, exhaustedLease.requestId);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(await persistence.claimNextGenerationRequest({ leaseDurationMs: 30_000, maxAttempts: 1 }), null);
    assert.equal((await persistence.reconcileGenerationRequest(exhaustedLease.requestId, 'synthetic-correlation-01'))?.lastFailureClass,
      'worker_lease_expired');

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
    const claimRace = await Promise.all(Array.from({ length: 12 }, () =>
      persistence.claimNextGenerationRequest({ leaseDurationMs: 30_000, maxAttempts: 3 }),
    ));
    const successfulRacingClaims = claimRace.filter((claim) => claim !== null);
    assert.equal(successfulRacingClaims.length, 1, 'concurrent workers claim one queued row at most once');
    assert.equal(successfulRacingClaims[0]?.requestId, concurrent[0]?.requestId);

    await persistence.publishArtifact(artifact({
      artifactKey: "synthetic-expiring-artifact",
      retentionClass: "synthetic-short-retention",
    }));
    const expiringEvidenceId = await persistence.storeEvidence({
      artifactKey: "synthetic-expiring-artifact",
      artifactVersion: 1,
      postId: "synthetic-pg-post-01",
      postContentVersion: "synthetic-post-version-02",
      groundingMode: "cg_only",
      sourceSnapshots: [],
      evidencePayload: { rationale: "synthetic short-lived evidence" },
      schemaVersion: 1,
      retentionClass: "synthetic-short-retention",
    });
    const expiringRequest = await persistence.createOrGetGenerationRequest(request({
      idempotencyKey: "synthetic-expiring-request",
      retentionClass: "synthetic-short-retention",
    }));
    await persistence.publishArtifact(artifact({
      artifactKey: "synthetic-indefinite-artifact",
      retentionClass: "synthetic-indefinite-retention",
    }));

    await assert.rejects(persistence.purgeExpiredRecords(0), /batchSize must be a safe integer/);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const purgeTotals = { evidenceBundles: 0, generationRequests: 0, artifacts: 0 };
    for (let batch = 0; batch < 10; batch += 1) {
      const purged = await persistence.purgeExpiredRecords(1);
      purgeTotals.evidenceBundles += purged.evidenceBundles;
      purgeTotals.generationRequests += purged.generationRequests;
      purgeTotals.artifacts += purged.artifacts;
      assert.ok(purged.evidenceBundles <= 2 && purged.generationRequests <= 2 && purged.artifacts <= 2,
        "one-record batches remain bounded across the configured expiring classes");
    }
    assert.ok(purgeTotals.evidenceBundles >= 1, "short-lived evidence expires under its configured policy");
    assert.ok(purgeTotals.generationRequests >= 1, "short-lived requests expire and their restricted metadata is removed");
    assert.ok(purgeTotals.artifacts >= 1, "short-lived artifacts expire after dependent evidence cleanup");
    assert.ok(await persistence.getArtifact("synthetic-pg-artifact-01"), "records within the longer retention class remain available");
    assert.equal(await persistence.getArtifact("synthetic-expiring-artifact"), null);
    assert.equal(await persistence.getEvidence(expiringEvidenceId), null);
    assert.equal(await persistence.getGenerationRequest(expiringRequest.requestId), null);
    assert.ok(await persistence.getEvidence(evidenceId), "evidence in the longer retention class remains available");
    assert.ok(await persistence.getGenerationRequest(created.requestId), "requests in the longer retention class remain available");
    assert.ok(await persistence.getArtifact("synthetic-indefinite-artifact"), "explicit null retention remains available");
    const restrictedMetadataAfterPurge = await servicePool.query(
      "SELECT COUNT(*)::integer AS count FROM ti_request_restricted_metadata WHERE request_id = $1",
      [expiringRequest.requestId],
    );
    assert.equal(restrictedMetadataAfterPurge.rows[0].count, 0, "restricted quota metadata is removed with expired requests");
  } finally {
    await servicePool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
});
