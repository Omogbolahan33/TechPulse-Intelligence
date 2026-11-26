import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_PERSONA_IDS,
  ContractValidationError,
  negotiateInputVersion,
  validateCanonicalPostInput,
  validateDeepDiveRequestInput,
  validatePreferenceInput,
  validateRestrictedRequestMetadata,
  type ContractLimits,
} from "./contracts";

// Local synthetic bounds and language policy; these are not launch configuration.
const limits: ContractLimits = {
  maxStringCodePoints: 512,
  maxArrayItems: 12,
  maxPayloadBytes: 16_384,
  maxContextItems: 4,
  maxContextBytes: 4_096,
};
const testLanguages = ["en", "fr"];

const canonicalPost = {
  schemaVersion: 1,
  postId: "post-123",
  postContentVersion: "version-7",
  title: "Synthetic post",
  content: "A privacy-cleared synthetic technology post.",
  language: "en",
  categoryId: 0,
  subcategoryId: "sub-disc-02",
  topicIds: ["topic-cloud"],
  source: {
    url: "https://publisher.example/synthetic-article",
    attribution: "Synthetic Publisher",
  },
  moderationState: "visible",
  publicationState: "published",
  sourceSnapshotRef: "snapshot-123",
};

const generalPreference = {
  schemaVersion: 1,
  personaId: "General",
  personaDefinitionVersion: "general-v1",
  interestIds: [],
  preferenceRevision: "preference-rev-7",
  interestTaxonomyVersion: "taxonomy-v1",
};

const cgPostQuote = {
  type: "cg_post",
  postId: "post-123",
  postContentVersion: "version-7",
  title: "Synthetic quoted post",
  content: "A quoted synthetic post snapshot.",
  language: "en",
  source: {
    url: "https://publisher.example/synthetic-article",
    attribution: "Synthetic Publisher",
  },
  sourceSnapshotRef: "source-snapshot-7",
  capturedAt: "2026-11-26T08:00:00Z",
  knownCurrentPostContentVersion: "version-8",
};

const insightQuote = {
  type: "intelligence_insight",
  artifactId: "artifact-123",
  artifactVersion: "artifact-version-2",
  itemId: "item-3",
  content: "A synthetic insight item.",
  language: "en",
  capturedAt: "2026-11-26T08:01:00Z",
  knownCurrentArtifactVersion: null,
};

const deepDiveRequest = {
  schemaVersion: 1,
  userMessageId: "message-123",
  requestRef: "request-ref-123",
  conversationRef: "conversation-ref-123",
  currentMessage: "What does this synthetic claim mean?",
  recentContext: [
    { messageId: "message-previous", role: "user", content: "A synthetic prior question." },
    { messageId: "message-answer", role: "assistant", content: "A synthetic prior answer.", quoteSnapshot: insightQuote },
  ],
  quoteSnapshot: cgPostQuote,
  responseConstraints: {
    schemaVersion: 1,
    outputSchemaVersion: "deep-dive-v1",
    safetyPolicyVersion: "safety-v1",
    locale: "en-NG",
  },
};

function expectContractError(action: () => unknown): void {
  assert.throws(action, ContractValidationError);
}

test("canonical CG post fields, version/hash, category IDs, language, and optional source are preserved", () => {
  const parsed = validateCanonicalPostInput(canonicalPost, limits, testLanguages);
  assert.equal(parsed.postContentVersion, "version-7");
  assert.equal(parsed.language, "en");
  assert.equal(parsed.categoryId, 0);
  assert.deepEqual(parsed.source, canonicalPost.source);
  assert.equal(parsed.content, canonicalPost.content);

  const hashOnlyPost = {
    ...canonicalPost,
    postContentVersion: undefined,
    contentHash: "sha256:synthetic-hash",
    source: undefined,
  };
  const parsedHashOnly = validateCanonicalPostInput(hashOnlyPost, limits, testLanguages);
  assert.equal(parsedHashOnly.contentHash, "sha256:synthetic-hash");
  assert.equal(parsedHashOnly.source, undefined);
});

test("canonical post rejects TI-renamed CG fields, unknown keys, missing version/hash, and unknown language", () => {
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, extra: true }, limits, testLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, schemaVersion: 2 }, limits, testLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, postVersion: "wrong-field" }, limits, testLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, postContentVersion: undefined }, limits, testLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, language: null }, limits, testLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, language: "unknown" }, limits, testLanguages));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, limits, []));
});

test("canonical post applies explicit Unicode, array, and serialized payload bounds", () => {
  const unicodeLimit = { ...limits, maxStringCodePoints: 128 };
  const exactlyAtUnicodeBoundary = "🙂".repeat(128);
  assert.equal(validateCanonicalPostInput({ ...canonicalPost, title: exactlyAtUnicodeBoundary }, unicodeLimit, testLanguages).title,
    exactlyAtUnicodeBoundary);
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, title: `${exactlyAtUnicodeBoundary}🙂` }, unicodeLimit, testLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, topicIds: Array(13).fill("topic") }, limits, testLanguages));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, { ...limits, maxPayloadBytes: 16 }, testLanguages));
});

test("preference accepts the six CG personas, including General with no interests", () => {
  assert.deepEqual(APPROVED_PERSONA_IDS, ["Founder", "Investor", "Operator", "Engineer", "Regulator", "General"]);
  const parsed = validatePreferenceInput(generalPreference, limits);
  assert.equal(parsed.personaId, "General");
  assert.deepEqual(parsed.interestIds, []);
  for (const personaId of APPROVED_PERSONA_IDS) {
    assert.equal(validatePreferenceInput({ ...generalPreference, personaId }, limits).personaId, personaId);
  }
});

test("preference uses canonical revision names, rejects duplicate/excess interests and identity fields, and normalizes set order", () => {
  const first = validatePreferenceInput({
    ...generalPreference,
    personaId: "Engineer",
    interestIds: ["cloud", "ai"],
  }, limits);
  const reversed = validatePreferenceInput({
    ...generalPreference,
    personaId: "Engineer",
    interestIds: ["ai", "cloud"],
  }, limits);
  assert.deepEqual(first.interestIds, ["ai", "cloud"]);
  assert.deepEqual(reversed.interestIds, first.interestIds);
  expectContractError(() => validatePreferenceInput({ ...generalPreference, personaId: "unapproved" }, limits));
  expectContractError(() => validatePreferenceInput({ ...generalPreference, interestIds: ["a", "b", "c", "d"] }, limits));
  expectContractError(() => validatePreferenceInput({ ...generalPreference, interestIds: ["cloud", "cloud"] }, limits));
  expectContractError(() => validatePreferenceInput({ ...generalPreference, taxonomyVersion: "old-name" }, limits));
  expectContractError(() => validatePreferenceInput({ ...generalPreference, userId: "private-user" }, limits));
});

test("Deep Dive preserves versioned post/insight snapshots, staleness metadata, context snapshots, and CG constraints", () => {
  const parsed = validateDeepDiveRequestInput(deepDiveRequest, limits, testLanguages);
  assert.equal(parsed.userMessageId, "message-123");
  assert.equal(parsed.quoteSnapshot?.type, "cg_post");
  assert.equal(parsed.quoteSnapshot?.type === "cg_post" ? parsed.quoteSnapshot.knownCurrentPostContentVersion : undefined, "version-8");
  assert.equal(parsed.quoteSnapshot?.type === "cg_post" ? parsed.quoteSnapshot.sourceSnapshotRef : undefined, "source-snapshot-7");
  assert.equal(parsed.recentContext[1].quoteSnapshot?.type, "intelligence_insight");
  assert.equal(parsed.responseConstraints.locale, "en-NG");
});

test("Deep Dive rejects unsupported quote shapes, timestamps, languages, full threads, and unbounded context", () => {
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, fullThread: [] }, limits, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    quoteSnapshot: { ...cgPostQuote, type: "external_article" },
  }, limits, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    quoteSnapshot: { ...cgPostQuote, language: "unknown" },
  }, limits, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    quoteSnapshot: { ...cgPostQuote, capturedAt: "yesterday" },
  }, limits, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    recentContext: Array(5).fill(deepDiveRequest.recentContext[0]),
  }, limits, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    recentContext: [{ messageId: "m", role: "system", content: "untrusted" }],
  }, limits, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput(deepDiveRequest, { ...limits, maxContextBytes: 8 }, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    responseConstraints: { ...deepDiveRequest.responseConstraints, schemaVersion: 2 },
  }, limits, testLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, schemaVersion: 99 }, limits, testLanguages));
});

test("restricted quota metadata is separate and rejects identity fields", () => {
  const metadata = { schemaVersion: 1, requestId: "request-1", quotaSubject: "pseudonymous-subject" };
  assert.deepEqual(validateRestrictedRequestMetadata(metadata, limits), metadata);
  expectContractError(() => validateRestrictedRequestMetadata({ ...metadata, userId: "private-user" }, limits));
});

test("version negotiation selects a shared explicit version and fails closed when none exists", () => {
  assert.equal(negotiateInputVersion([2, 1]), 1);
  expectContractError(() => negotiateInputVersion([2, 3]));
  expectContractError(() => negotiateInputVersion([1, 1.5]));
});

test("bounds are required rather than supplied by hidden defaults", () => {
  expectContractError(() => validateCanonicalPostInput(canonicalPost, undefined as unknown as ContractLimits, testLanguages));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, { ...limits, maxPayloadBytes: 0 }, testLanguages));
});
