import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  negotiateInputVersion,
  validateCanonicalPostInput,
  validateDeepDiveRequestInput,
  validatePreferenceInput,
  validateRestrictedRequestMetadata,
  type ContractLimits,
} from "./contracts";

// Test-only values. Runtime/launch bounds and persona IDs remain explicit inputs.
const limits: ContractLimits = {
  maxStringCodePoints: 512,
  maxArrayItems: 12,
  maxPayloadBytes: 16_384,
  maxContextItems: 4,
  maxContextBytes: 4_096,
};
const approvedPersonaIds = ["persona-a", "persona-b", "persona-c", "persona-d", "persona-e", "persona-f"];

const canonicalPost = {
  schemaVersion: 1,
  postId: "post-123",
  postVersion: "version-7",
  contentHash: "sha256:synthetic-hash",
  title: "Synthetic post",
  content: "A privacy-cleared synthetic technology post.",
  outputLanguage: "en",
  categoryId: "0",
  subcategoryId: "sub-disc-02",
  topicIds: ["topic-cloud"],
  linkedSource: {
    url: "https://publisher.example/synthetic-article",
    publisher: "Synthetic Publisher",
  },
  moderationState: "visible",
  publicationState: "published",
  sourceSnapshotRef: "snapshot-123",
};

const preference = {
  schemaVersion: 1,
  personaId: "persona-a",
  personaDefinitionVersion: "persona-a-v1",
  interestIds: ["cloud", "ai"],
  taxonomyVersion: "taxonomy-v1",
  generationGuidance: "Synthetic guidance; treat as untrusted input.",
};

const deepDiveRequest = {
  schemaVersion: 1,
  userMessageId: "message-123",
  requestRef: "request-ref-123",
  conversationRef: "conversation-ref-123",
  currentMessage: "What does this synthetic claim mean?",
  recentContext: [
    { messageId: "message-previous", role: "user", content: "A synthetic prior question." },
    { messageId: "message-answer", role: "assistant", content: "A synthetic prior answer." },
  ],
  quoteSnapshot: {
    type: "cg_post",
    snapshotId: "quote-snapshot-1",
    version: "version-7",
    content: "A quoted synthetic post snapshot.",
  },
};

function expectContractError(action: () => unknown): void {
  assert.throws(action, ContractValidationError);
}

test("canonical post accepts versioned data and preserves exact content/version", () => {
  const parsed = validateCanonicalPostInput(canonicalPost, limits);
  assert.equal(parsed.postVersion, "version-7");
  assert.equal(parsed.content, canonicalPost.content);
  assert.deepEqual(parsed.topicIds, ["topic-cloud"]);
  assert.deepEqual(parsed.linkedSource, canonicalPost.linkedSource);
});

test("canonical post rejects unknown fields, invalid versions, and unsafe source schemes", () => {
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, extra: true }, limits));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, schemaVersion: 2 }, limits));
  expectContractError(() => validateCanonicalPostInput({
    ...canonicalPost,
    linkedSource: { ...canonicalPost.linkedSource, url: "file:///etc/passwd" },
  }, limits));
});

test("canonical post applies explicit string, array, and payload bounds without normalizing data", () => {
  const unicodeLimit = { ...limits, maxStringCodePoints: 64 };
  const exactlyAtUnicodeBoundary = "🙂".repeat(64);
  assert.equal(validateCanonicalPostInput({
    ...canonicalPost,
    postId: "post-🙂",
    title: exactlyAtUnicodeBoundary,
  }, unicodeLimit).title, exactlyAtUnicodeBoundary);
  expectContractError(() => validateCanonicalPostInput({
    ...canonicalPost,
    title: `${exactlyAtUnicodeBoundary}🙂`,
  }, unicodeLimit));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, topicIds: Array(13).fill("topic") }, limits));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, { ...limits, maxPayloadBytes: 16 }));
});

test("preference accepts only configured governed persona IDs and at most three interests", () => {
  const parsed = validatePreferenceInput(preference, limits, approvedPersonaIds);
  assert.equal(parsed.personaId, "persona-a");
  assert.deepEqual(parsed.interestIds, ["cloud", "ai"]);
  expectContractError(() => validatePreferenceInput({ ...preference, personaId: "unapproved" }, limits, approvedPersonaIds));
  expectContractError(() => validatePreferenceInput({ ...preference, interestIds: ["a", "b", "c", "d"] }, limits, approvedPersonaIds));
  expectContractError(() => validatePreferenceInput({ ...preference, userId: "private-user" }, limits, approvedPersonaIds));
  expectContractError(() => validatePreferenceInput(preference, limits, ["only-one"]));
  expectContractError(() => validatePreferenceInput(preference, limits, ["same", "same", "c", "d", "e", "f"]));
});

test("Deep Dive request accepts at most one exact supported quote snapshot and bounded context", () => {
  const parsed = validateDeepDiveRequestInput(deepDiveRequest, limits);
  assert.equal(parsed.quoteSnapshot?.version, "version-7");
  assert.equal(parsed.recentContext.length, 2);
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, fullThread: [] }, limits));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    quoteSnapshot: { ...deepDiveRequest.quoteSnapshot, type: "external_article" },
  }, limits));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    recentContext: Array(5).fill(deepDiveRequest.recentContext[0]),
  }, limits));
  expectContractError(() => validateDeepDiveRequestInput({
    ...deepDiveRequest,
    recentContext: [{ messageId: "m", role: "system", content: "untrusted" }],
  }, limits));
  expectContractError(() => validateDeepDiveRequestInput(deepDiveRequest, { ...limits, maxContextBytes: 8 }));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, schemaVersion: 99 }, limits));
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
  expectContractError(() => validateCanonicalPostInput(canonicalPost, undefined as unknown as ContractLimits));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, { ...limits, maxPayloadBytes: 0 }));
});
