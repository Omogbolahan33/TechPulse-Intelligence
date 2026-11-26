import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_PERSONA_IDS,
  ContractValidationError,
  mapCanonicalCgInputsToTi,
  negotiateInputVersion,
  negotiatePreferenceVersion,
  validateCanonicalPostInput,
  validateDeepDiveRequestInput,
  validatePreferenceInput,
  validateRestrictedRequestMetadata,
  type ContractLimits,
} from "./contracts";
import {
  canonicalPost,
  canonicalPreferenceV2,
  cgPostQuoteSnapshot,
  deepDiveRequest,
  insightQuoteSnapshot,
  preferenceWithInterestsV2,
} from "./fixtures/canonical-cg";

// Synthetic test bounds/language policy only; no service defaults or launch values.
const limits: ContractLimits = {
  maxStringCodePoints: 512,
  maxArrayItems: 12,
  maxPayloadBytes: 16_384,
  maxContextItems: 4,
  maxContextBytes: 4_096,
};
const supportedLanguages = ["en", "fr"];

function expectContractError(action: () => unknown): void {
  assert.throws(action, ContractValidationError);
}

test("canonical fixtures are deeply immutable and contain synthetic CG-shaped inputs", () => {
  for (const value of [canonicalPost, canonicalPreferenceV2, preferenceWithInterestsV2, deepDiveRequest]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.ok(Object.isFrozen(canonicalPost.source));
  assert.ok(Object.isFrozen(preferenceWithInterestsV2.selectedInterests[0]));
  assert.match(canonicalPost.postId, /^synthetic-/);
  assert.equal("userId" in canonicalPreferenceV2, false);
});

test("canonical post preserves version/hash, language, source and snapshot provenance", () => {
  const parsed = validateCanonicalPostInput(canonicalPost, limits, supportedLanguages);
  assert.equal(parsed.postContentVersion, canonicalPost.postContentVersion);
  assert.equal(parsed.contentHash, canonicalPost.contentHash);
  assert.equal(parsed.language, "fr");
  assert.deepEqual(parsed.source, canonicalPost.source);
  assert.equal(parsed.sourceSnapshotRef, canonicalPost.sourceSnapshotRef);

  const versionOnly = { ...canonicalPost, contentHash: undefined };
  assert.equal(validateCanonicalPostInput(versionOnly, limits, supportedLanguages).postContentVersion, canonicalPost.postContentVersion);
  const hashOnly = { ...canonicalPost, postContentVersion: undefined, source: undefined, sourceSnapshotRef: undefined };
  const hashParsed = validateCanonicalPostInput(hashOnly, limits, supportedLanguages);
  assert.equal(hashParsed.contentHash, canonicalPost.contentHash);
  assert.equal(hashParsed.source, undefined);
  assert.equal(hashParsed.sourceSnapshotRef, undefined);

  const versionAndNoSource = { ...canonicalPost, contentHash: undefined, source: undefined, sourceSnapshotRef: undefined };
  const versionParsed = validateCanonicalPostInput(versionAndNoSource, limits, supportedLanguages);
  assert.equal(versionParsed.postContentVersion, canonicalPost.postContentVersion);
  assert.equal(versionParsed.source, undefined);
});

test("canonical post rejects malformed versions, privacy fields, unknown fields, and unsupported language", () => {
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, schemaVersion: 2 }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, postContentVersion: undefined, contentHash: undefined }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, contentHash: "" }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, unknown: true }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, userId: "synthetic-private-user" }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, language: null }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, language: "not-enabled" }, limits, supportedLanguages));
});

test("post bounds enforce Unicode code points, arrays, and serialized bytes", () => {
  const unicodeLimit = { ...limits, maxStringCodePoints: 128 };
  const boundary = "🙂".repeat(128);
  assert.equal(validateCanonicalPostInput({ ...canonicalPost, title: boundary }, unicodeLimit, supportedLanguages).title, boundary);
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, title: `${boundary}🙂` }, unicodeLimit, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput({ ...canonicalPost, topicIds: Array(13).fill("synthetic-topic") }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, { ...limits, maxPayloadBytes: 16 }, supportedLanguages));
});

test("preference v2 preserves all six personas, revision/taxonomy versions, and General with no interests", () => {
  assert.deepEqual(APPROVED_PERSONA_IDS, ["Founder", "Investor", "Operator", "Engineer", "Regulator", "General"]);
  const parsed = validatePreferenceInput(canonicalPreferenceV2, limits);
  assert.equal(parsed.personaId, "General");
  assert.deepEqual(parsed.selectedInterests, []);
  assert.equal(parsed.preferenceRevision, canonicalPreferenceV2.preferenceRevision);
  assert.equal(parsed.personaDefinitionVersion, canonicalPreferenceV2.personaDefinitionVersion);
  assert.equal(parsed.interestTaxonomyVersion, canonicalPreferenceV2.interestTaxonomyVersion);
  assert.equal(parsed.resolvedPersonaGuidance, canonicalPreferenceV2.resolvedPersonaGuidance);
  for (const personaId of APPROVED_PERSONA_IDS) {
    assert.equal(validatePreferenceInput({ ...canonicalPreferenceV2, personaId }, limits).personaId, personaId);
  }
});

test("selected interests retain stable IDs, labels, and descriptions while treating order as irrelevant", () => {
  const parsed = validatePreferenceInput(preferenceWithInterestsV2, limits);
  assert.deepEqual(parsed.selectedInterests.map((item) => item.id), ["synthetic-interest-ai", "synthetic-interest-cloud"]);
  assert.equal(parsed.selectedInterests[0].label, "Artificial intelligence");
  assert.equal(parsed.selectedInterests[0].description, "Synthetic interest description.");
  const reversed = validatePreferenceInput({
    ...preferenceWithInterestsV2,
    selectedInterests: [...preferenceWithInterestsV2.selectedInterests].reverse(),
  }, limits);
  assert.deepEqual(reversed.selectedInterests, parsed.selectedInterests);
});

test("preference rejects omitted metadata, duplicates, excess interests, unknown IDs/personas, and identity fields", () => {
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, schemaVersion: 1 }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, personaId: "unapproved" }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, resolvedPersonaGuidance: undefined }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, resolvedPersonaGuidance: "   " }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, selectedInterests: [{ id: "i" }] }, limits));
  expectContractError(() => validatePreferenceInput({ ...preferenceWithInterestsV2, selectedInterests: [preferenceWithInterestsV2.selectedInterests[0], preferenceWithInterestsV2.selectedInterests[0]] }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, selectedInterests: Array(4).fill({ id: "i", label: "label", description: "desc" }) }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, userId: "synthetic-private-user" }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, profileId: "synthetic-profile" }, limits));
  expectContractError(() => validatePreferenceInput({ ...canonicalPreferenceV2, unknown: "field" }, limits));
});

test("preference schema change is negotiated explicitly and v1-only peers fail closed", () => {
  assert.equal(negotiatePreferenceVersion([1, 2]), 2);
  expectContractError(() => negotiatePreferenceVersion([1]));
  expectContractError(() => negotiatePreferenceVersion([2, 2.5]));
  assert.equal(negotiateInputVersion([2, 1]), 1);
  expectContractError(() => negotiateInputVersion([2, 3]));
});

test("Deep Dive supports zero or one root quote of either canonical quote type", () => {
  const parsedWithPost = validateDeepDiveRequestInput(deepDiveRequest, limits, supportedLanguages);
  assert.equal(parsedWithPost.quoteSnapshot?.type, "cg_post");
  assert.equal(parsedWithPost.quoteSnapshot?.type === "cg_post" ? parsedWithPost.quoteSnapshot.contentHash : undefined, cgPostQuoteSnapshot.contentHash);
  assert.equal(parsedWithPost.recentContext[1].quoteSnapshot?.type, "intelligence_insight");
  assert.equal(parsedWithPost.responseConstraints.locale, "fr-NG");

  const noQuote = { ...deepDiveRequest, quoteSnapshot: undefined };
  assert.equal(validateDeepDiveRequestInput(noQuote, limits, supportedLanguages).quoteSnapshot, undefined);
  const withInsight = { ...deepDiveRequest, quoteSnapshot: insightQuoteSnapshot };
  assert.equal(validateDeepDiveRequestInput(withInsight, limits, supportedLanguages).quoteSnapshot?.type, "intelligence_insight");

  const hashOnlyQuote = {
    ...cgPostQuoteSnapshot,
    postContentVersion: undefined,
    source: undefined,
    sourceSnapshotRef: undefined,
    knownCurrentPostContentVersion: null,
  };
  const hashQuoteResult = validateDeepDiveRequestInput({ ...deepDiveRequest, quoteSnapshot: hashOnlyQuote }, limits, supportedLanguages);
  assert.equal(hashQuoteResult.quoteSnapshot?.type === "cg_post" ? hashQuoteResult.quoteSnapshot.contentHash : undefined, cgPostQuoteSnapshot.contentHash);
  assert.equal(hashQuoteResult.quoteSnapshot?.type === "cg_post" ? hashQuoteResult.quoteSnapshot.knownCurrentPostContentVersion : undefined, null);
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, quoteSnapshot: [cgPostQuoteSnapshot, insightQuoteSnapshot] }, limits, supportedLanguages));
});

test("Deep Dive preserves embedded context quotes and rejects malformed versions/unsupported quote or context shapes", () => {
  const contextQuote = validateDeepDiveRequestInput(deepDiveRequest, limits, supportedLanguages).recentContext[1].quoteSnapshot;
  assert.equal(contextQuote?.type, "intelligence_insight");
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, fullThread: [] }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, userId: "synthetic-private-user" }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, quoteSnapshots: [cgPostQuoteSnapshot, insightQuoteSnapshot] }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput(deepDiveRequest, { ...limits, maxPayloadBytes: 64 }, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, schemaVersion: 99 }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, quoteSnapshot: { ...cgPostQuoteSnapshot, type: "external_article" } }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, quoteSnapshot: { ...cgPostQuoteSnapshot, language: "unknown" } }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, quoteSnapshot: { ...cgPostQuoteSnapshot, capturedAt: "yesterday" } }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, recentContext: Array(5).fill(deepDiveRequest.recentContext[0]) }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, recentContext: [{ messageId: "synthetic-message", role: "system", content: "synthetic" }] }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput(deepDiveRequest, { ...limits, maxContextBytes: 8 }, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, responseConstraints: { ...deepDiveRequest.responseConstraints, schemaVersion: 2 } }, limits, supportedLanguages));
});

test("restricted metadata is separate and does not admit raw identity to shared inputs", () => {
  const metadata = { schemaVersion: 1, requestId: "synthetic-request-01", quotaSubject: "synthetic-quota-subject" };
  assert.deepEqual(validateRestrictedRequestMetadata(metadata, limits), metadata);
  expectContractError(() => validateRestrictedRequestMetadata({ ...metadata, userId: "synthetic-private-user" }, limits));
});

test("CG-to-TI mapping preserves canonical content and derives output language from the post", () => {
  const mapped = mapCanonicalCgInputsToTi({
    canonicalPost,
    preferences: preferenceWithInterestsV2,
    deepDiveRequest,
  }, limits, supportedLanguages);
  assert.equal(mapped.outputLanguage, canonicalPost.language);
  assert.equal(mapped.canonicalPost.contentHash, canonicalPost.contentHash);
  assert.equal(mapped.canonicalPost.sourceSnapshotRef, canonicalPost.sourceSnapshotRef);
  assert.deepEqual(mapped.preferences.selectedInterests, validatePreferenceInput(preferenceWithInterestsV2, limits).selectedInterests);
  assert.equal(mapped.deepDiveRequest?.quoteSnapshot?.type, "cg_post");
  expectContractError(() => mapCanonicalCgInputsToTi({ canonicalPost, preferences: preferenceWithInterestsV2, outputLanguage: "en" }, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgInputsToTi({ canonicalPost, preferences: { ...canonicalPreferenceV2, userId: "synthetic-private-user" } }, limits, supportedLanguages));
});

test("contract bounds require explicit positive configuration", () => {
  expectContractError(() => validateCanonicalPostInput(canonicalPost, undefined as unknown as ContractLimits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, { ...limits, maxPayloadBytes: 0 }, supportedLanguages));
});
