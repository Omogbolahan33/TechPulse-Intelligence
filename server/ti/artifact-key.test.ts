import assert from "node:assert/strict";
import test from "node:test";
import {
  ArtifactKeyValidationError,
  createProsConsArtifactKey,
  createSummaryArtifactKey,
  type ArtifactKeyCommonInput,
  type ProsConsArtifactKeyInput,
} from "./artifact-key";

const policy = { maxIdentifierCodePoints: 128 } as const;
const summary: ArtifactKeyCommonInput = {
  postId: "synthetic-post-17",
  postContentVersion: 4,
  contentHash: "synthetic-content-hash-v4",
  evidence: { availability: "available", evidenceVersion: "synthetic-evidence-v2" },
  outputLanguage: "en",
  generationDefinitionVersion: "synthetic-summary-definition-3",
  promptVersion: "synthetic-prompt-7",
  schemaVersion: 2,
};

const prosCons = (overrides: Partial<ProsConsArtifactKeyInput> = {}): ProsConsArtifactKeyInput => ({
  ...summary,
  personaId: "Engineer",
  personaDefinitionVersion: "synthetic-persona-v2",
  interestTaxonomyVersion: "synthetic-taxonomy-v8",
  interestIds: ["cloud", "ai"],
  ...overrides,
});

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations(values.filter((_, itemIndex) => itemIndex !== index))
    .map((tail) => [value, ...tail]));
}

test("Summary key is deterministic, versioned, and opaque", () => {
  const key = createSummaryArtifactKey(summary, policy);
  assert.match(key, /^ti:summary:v1:[a-f0-9]{64}$/);
  assert.equal(key, "ti:summary:v1:401583c9a4f3fc2af4dddd2d914375fd0dbd13340e2b534f31b19ac284c831b5");
  assert.equal(createSummaryArtifactKey({ ...summary }, policy), key);
  for (const excludedField of ["personaId", "interestIds", "userId", "providerId", "modelId"]) {
    assert.equal(key.includes(excludedField), false);
  }
});

test("Summary identity changes for every content, grounding, language, or definition version", () => {
  const original = createSummaryArtifactKey(summary, policy);
  const variants: ArtifactKeyCommonInput[] = [
    { ...summary, postId: "synthetic-post-18" },
    { ...summary, postContentVersion: 5 },
    { ...summary, contentHash: "synthetic-content-hash-v5" },
    { ...summary, evidence: { availability: "available", evidenceVersion: "synthetic-evidence-v3" } },
    { ...summary, evidence: { availability: "unavailable" } },
    { ...summary, outputLanguage: "fr" },
    { ...summary, generationDefinitionVersion: "synthetic-summary-definition-4" },
    { ...summary, promptVersion: "synthetic-prompt-8" },
    { ...summary, schemaVersion: 3 },
  ];
  for (const variant of variants) assert.notEqual(createSummaryArtifactKey(variant, policy), original);
  assert.notEqual(
    createSummaryArtifactKey({ ...summary, postContentVersion: undefined, contentHash: "synthetic-content-hash-v4" }, policy),
    original,
    "version-only and hash-only post identities have explicit, non-colliding tuple slots",
  );
});

test("unavailable evidence is an explicit stable marker and never collides with available evidence", () => {
  const unavailable: ArtifactKeyCommonInput = { ...summary, evidence: { availability: "unavailable" } };
  const key = createSummaryArtifactKey(unavailable, policy);
  assert.equal(key, createSummaryArtifactKey({ ...unavailable }, policy));
  assert.notEqual(key, createSummaryArtifactKey(summary, policy));
  assert.notEqual(
    createSummaryArtifactKey({ ...summary, evidence: { availability: "available", evidenceVersion: 2 } }, policy),
    createSummaryArtifactKey({ ...summary, evidence: { availability: "available", evidenceVersion: "2" } }, policy),
    "numeric and string evidence versions retain their typed identity",
  );
  assert.throws(
    () => createSummaryArtifactKey({ ...summary, evidence: { availability: "available" } as never }, policy),
    ArtifactKeyValidationError,
  );
  assert.throws(
    () => createSummaryArtifactKey({ ...summary, evidence: { availability: "unavailable", evidenceVersion: "unexpected" } as never }, policy),
    /unavailable evidence must not provide evidenceVersion/,
  );
});

test("Pros/Cons uses sorted unique stable interest IDs and hides their raw values in the shared key", () => {
  const values = ["ai", "cloud", "security"];
  const keys = permutations(values).map((interestIds) => createProsConsArtifactKey(prosCons({ interestIds }), policy));
  assert.equal(new Set(keys).size, 1, "every interest ordering must produce the same identity");
  assert.equal(
    createProsConsArtifactKey(prosCons({ interestIds: ["ai", "cloud", "ai"] }), policy),
    createProsConsArtifactKey(prosCons({ interestIds: ["cloud", "ai"] }), policy),
    "duplicate IDs do not create a different set identity",
  );
  const key = keys[0];
  for (const interestId of values) assert.equal(key.includes(interestId), false, "raw stable IDs must not be exposed in the key");
  assert.match(key, /^ti:pros_cons:v1:[a-f0-9]{64}$/);
  assert.equal(
    createProsConsArtifactKey(prosCons(), policy),
    "ti:pros_cons:v1:148c59bdfbf2da9edba0399158e54afa262a1a1b929aa6aa1e5ff54a63240378",
  );
});

test("Pros/Cons partitions by persona, taxonomy, post, evidence, language, and generator definitions", () => {
  const original = createProsConsArtifactKey(prosCons(), policy);
  const variants: ProsConsArtifactKeyInput[] = [
    prosCons({ personaId: "Operator" }),
    prosCons({ personaDefinitionVersion: "synthetic-persona-v3" }),
    prosCons({ interestTaxonomyVersion: "synthetic-taxonomy-v9" }),
    prosCons({ interestIds: ["cloud", "security"] }),
    prosCons({ postContentVersion: 5 }),
    prosCons({ evidence: { availability: "unavailable" } }),
    prosCons({ outputLanguage: "fr" }),
    prosCons({ generationDefinitionVersion: "synthetic-pros-cons-definition-4" }),
    prosCons({ promptVersion: "synthetic-prompt-8" }),
    prosCons({ schemaVersion: 3 }),
  ];
  for (const variant of variants) assert.notEqual(createProsConsArtifactKey(variant, policy), original);
});

test("strict validation rejects identity/provider fields, malformed versions, unbounded IDs, and invalid evidence forms", () => {
  assert.throws(
    () => createSummaryArtifactKey({ ...summary, userId: "synthetic-user" } as never, policy),
    /unsupported field: userId/,
  );
  assert.throws(
    () => createProsConsArtifactKey({ ...prosCons(), providerId: "synthetic-provider" } as never, policy),
    /unsupported field: providerId/,
  );
  assert.throws(
    () => createSummaryArtifactKey({ ...summary, postContentVersion: undefined, contentHash: undefined }, policy),
    /postContentVersion or contentHash is required/,
  );
  assert.throws(
    () => createSummaryArtifactKey({ ...summary, schemaVersion: 0 }, policy),
    /schemaVersion must be a positive safe integer/,
  );
  assert.throws(
    () => createSummaryArtifactKey({ ...summary, postId: "x".repeat(129) }, policy),
    /exceeds the configured 128-code-point bound/,
  );
  assert.throws(
    () => createProsConsArtifactKey(prosCons({ interestIds: ["ai", "cloud", "security", "fintech"] }), policy),
    /at most three stable IDs/,
  );
  assert.throws(
    () => createProsConsArtifactKey(prosCons({ interestIds: ["ai", " "] }), policy),
    /must be a non-empty string/,
  );
  const sparseInterestIds = new Array<string>(1);
  assert.throws(
    () => createProsConsArtifactKey(prosCons({ interestIds: sparseInterestIds }), policy),
    /dense array/,
  );
  const getterInput = Object.defineProperty({ ...summary }, "postId", {
    enumerable: true,
    get() { throw new Error("untrusted getter must not execute"); },
  });
  assert.throws(() => createSummaryArtifactKey(getterInput as never, policy), /enumerable data properties/);
  assert.throws(
    () => createProsConsArtifactKey(prosCons({ personaId: "Other" as never }), policy),
    /not an approved stable persona ID/,
  );
  assert.throws(
    () => createProsConsArtifactKey(prosCons(), { maxIdentifierCodePoints: 0 }),
    /must be explicitly configured/,
  );
});
