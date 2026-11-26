import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVED_PERSONA_IDS,
  ContractValidationError,
  mapCanonicalCgInputsToTi,
  mapCanonicalCgDeepDiveDispatchToTi,
  mapCanonicalCgQuoteSnapshotToTi,
  negotiateInputVersion,
  negotiateDeepDiveInputVersion,
  negotiatePreferenceVersion,
  validateCanonicalPostInput,
  validateCanonicalCgPostInput,
  validateDeepDiveRequestInput,
  validateDeepDiveRequestInputV2,
  validatePreferenceInput,
  validateRestrictedRequestMetadata,
  type ContractLimits,
} from "./contracts";
import {
  canonicalPost,
  canonicalPreferenceV2,
  cgDeepDiveDispatch,
  cgPostQuoteEnvelope,
  cgInsightQuoteEnvelope,
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
  for (const value of [canonicalPost, canonicalPreferenceV2, preferenceWithInterestsV2, deepDiveRequest, cgDeepDiveDispatch]) {
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
  assert.equal(parsed.contentFormat, canonicalPost.contentFormat);
  assert.equal(parsed.sourceVersion, canonicalPost.sourceVersion);
  assert.equal(parsed.sourceSnapshotReference, canonicalPost.sourceSnapshotReference);
  assert.equal(validateCanonicalCgPostInput(canonicalPost, limits, supportedLanguages).contentFormat, "text/markdown");

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
  expectContractError(() => validateCanonicalCgPostInput({ ...canonicalPost, contentFormat: undefined }, limits, supportedLanguages));
  expectContractError(() => validateCanonicalCgPostInput({ ...canonicalPost, sourceSnapshotRef: "synthetic-legacy-alias" }, limits, supportedLanguages));
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
  assert.equal(mapped.canonicalPost.contentFormat, canonicalPost.contentFormat);
  assert.equal(mapped.canonicalPost.sourceVersion, canonicalPost.sourceVersion);
  assert.equal(mapped.canonicalPost.sourceSnapshotReference, canonicalPost.sourceSnapshotReference);
  assert.deepEqual(mapped.preferences.selectedInterests, validatePreferenceInput(preferenceWithInterestsV2, limits).selectedInterests);
  assert.equal(mapped.deepDiveRequest?.quoteSnapshot?.type, "cg_post");
  expectContractError(() => mapCanonicalCgInputsToTi({ canonicalPost, preferences: preferenceWithInterestsV2, outputLanguage: "en" }, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgInputsToTi({ canonicalPost, preferences: { ...canonicalPreferenceV2, userId: "synthetic-private-user" } }, limits, supportedLanguages));
});

test("Deep Dive v1/v2 negotiation is explicit and fails when no supported schema is offered", () => {
  assert.equal(negotiateDeepDiveInputVersion([1, 2]), 2);
  assert.equal(negotiateDeepDiveInputVersion([1]), 1);
  expectContractError(() => negotiateDeepDiveInputVersion([3]));
  expectContractError(() => negotiateDeepDiveInputVersion([2, 1.5]));
});

test("CG quote-v1 mapper preserves outer quote ID/parent version and maps nested post or insight", () => {
  const postQuote = mapCanonicalCgQuoteSnapshotToTi(cgPostQuoteEnvelope, limits, supportedLanguages);
  assert.equal(postQuote.quoteId, cgPostQuoteEnvelope.quoteId);
  assert.equal(postQuote.parentPostId, cgPostQuoteEnvelope.parentPostId);
  assert.equal(postQuote.parentPostContentVersion, cgPostQuoteEnvelope.parentPostContentVersion);
  assert.equal(postQuote.snapshot.type, "cg_post");
  assert.equal(postQuote.snapshot.type === "cg_post" ? postQuote.snapshot.sourceVersion : undefined, "synthetic-source-version-05");
  const insightQuote = mapCanonicalCgQuoteSnapshotToTi(cgInsightQuoteEnvelope, limits, supportedLanguages);
  assert.equal(insightQuote.quoteId, cgInsightQuoteEnvelope.quoteId);
  assert.equal(insightQuote.snapshot.type, "intelligence_insight");
  expectContractError(() => mapCanonicalCgQuoteSnapshotToTi({ ...cgPostQuoteEnvelope, insight: cgInsightQuoteEnvelope.insight }, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgQuoteSnapshotToTi({ ...cgPostQuoteEnvelope, unknown: "field" }, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgQuoteSnapshotToTi({ ...cgPostQuoteEnvelope, post: { ...cgPostQuoteEnvelope.post, type: "intelligence_insight" } }, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgQuoteSnapshotToTi({ ...cgPostQuoteEnvelope, post: { ...cgPostQuoteEnvelope.post, sourceSnapshotRef: "synthetic-legacy-ref" } }, limits, supportedLanguages));
});

test("CG Deep Dive dispatch maps requestReference, text/quote fields and response constraints without inventing IDs", () => {
  const mapped = mapCanonicalCgDeepDiveDispatchToTi(cgDeepDiveDispatch, canonicalPost, limits, supportedLanguages);
  assert.equal(mapped.schemaVersion, 2);
  assert.equal(mapped.requestRef, cgDeepDiveDispatch.requestReference);
  assert.equal(mapped.userMessageId, cgDeepDiveDispatch.userMessageId);
  assert.equal(mapped.currentMessage, cgDeepDiveDispatch.currentMessage.text);
  assert.equal(mapped.quote?.quoteId, cgPostQuoteEnvelope.quoteId);
  assert.equal(mapped.quote?.parentPostContentVersion, canonicalPost.postContentVersion);
  assert.equal(mapped.quote?.snapshot.type, "cg_post");
  assert.equal(mapped.recentContext[1].content, cgDeepDiveDispatch.recentContext[1].text);
  assert.equal(mapped.recentContext[1].quote?.snapshot.type, "intelligence_insight");
  assert.deepEqual(mapped.responseConstraints.safetyRequirements, cgDeepDiveDispatch.responseConstraints.safetyRequirements);
  assert.equal(mapped.responseConstraints.postLanguage, canonicalPost.language);

  const noQuotes = {
    ...cgDeepDiveDispatch,
    currentMessage: { text: cgDeepDiveDispatch.currentMessage.text },
    recentContext: [{ messageId: "synthetic-context-only", role: "user", text: "synthetic" }],
  };
  assert.equal(mapCanonicalCgDeepDiveDispatchToTi(noQuotes, canonicalPost, limits, supportedLanguages).quote, undefined);
  expectContractError(() => mapCanonicalCgDeepDiveDispatchToTi({ ...cgDeepDiveDispatch, responseConstraints: { ...cgDeepDiveDispatch.responseConstraints, postLanguage: "en" } }, canonicalPost, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgDeepDiveDispatchToTi({ ...cgDeepDiveDispatch, userId: "synthetic-private-user" }, canonicalPost, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgDeepDiveDispatchToTi({ ...cgDeepDiveDispatch, currentMessage: { ...cgDeepDiveDispatch.currentMessage, quotes: [cgPostQuoteEnvelope, cgInsightQuoteEnvelope] } }, canonicalPost, limits, supportedLanguages));
  expectContractError(() => mapCanonicalCgDeepDiveDispatchToTi(cgDeepDiveDispatch, canonicalPost, { ...limits, maxPayloadBytes: 64 }, supportedLanguages));
  expectContractError(() => mapCanonicalCgDeepDiveDispatchToTi({ ...cgDeepDiveDispatch, responseConstraints: { ...cgDeepDiveDispatch.responseConstraints, safetyRequirements: "not-an-object" } }, canonicalPost, limits, supportedLanguages));
});

test("context byte bounds count the complete UTF-8 serialized array at its exact boundary", () => {
  const oneMessageDispatch = {
    ...cgDeepDiveDispatch,
    recentContext: [{ messageId: "synthetic-context", role: "user", text: "🙂" }],
  };
  const mapped = mapCanonicalCgDeepDiveDispatchToTi(oneMessageDispatch, canonicalPost, limits, supportedLanguages);
  const exactBytes = Buffer.byteLength(JSON.stringify(mapped.recentContext), "utf8");
  assert.ok(exactBytes > Buffer.byteLength(JSON.stringify(mapped.recentContext[0]), "utf8"));

  const exactLimit = { ...limits, maxContextBytes: exactBytes };
  assert.deepEqual(
    mapCanonicalCgDeepDiveDispatchToTi(oneMessageDispatch, canonicalPost, exactLimit, supportedLanguages).recentContext,
    mapped.recentContext,
  );
  expectContractError(() => mapCanonicalCgDeepDiveDispatchToTi(
    oneMessageDispatch,
    canonicalPost,
    { ...limits, maxContextBytes: exactBytes - 1 },
    supportedLanguages,
  ));

  const normalized = validateDeepDiveRequestInputV2(mapped, exactLimit, supportedLanguages);
  assert.deepEqual(normalized.recentContext, mapped.recentContext);
  expectContractError(() => validateDeepDiveRequestInputV2(
    mapped,
    { ...limits, maxContextBytes: exactBytes - 1 },
    supportedLanguages,
  ));

  const oneMessageV1 = {
    ...deepDiveRequest,
    recentContext: [{ messageId: "synthetic-context", role: "user", content: "🙂" }],
  };
  const validatedV1 = validateDeepDiveRequestInput(oneMessageV1, limits, supportedLanguages);
  const v1ExactBytes = Buffer.byteLength(JSON.stringify(validatedV1.recentContext), "utf8");
  assert.deepEqual(
    validateDeepDiveRequestInput(oneMessageV1, { ...limits, maxContextBytes: v1ExactBytes }, supportedLanguages).recentContext,
    validatedV1.recentContext,
  );
  expectContractError(() => validateDeepDiveRequestInput(
    oneMessageV1,
    { ...limits, maxContextBytes: v1ExactBytes - 1 },
    supportedLanguages,
  ));
});

test("contract bounds require explicit positive configuration", () => {
  expectContractError(() => validateCanonicalPostInput(canonicalPost, undefined as unknown as ContractLimits, supportedLanguages));
  expectContractError(() => validateCanonicalPostInput(canonicalPost, { ...limits, maxPayloadBytes: 0 }, supportedLanguages));
});

test("strict object and array validation rejects getters, symbols, sparse arrays and extra array properties", () => {
  let getterRead = false;
  const accessorRecord = { ...canonicalPost };
  Object.defineProperty(accessorRecord, "title", {
    enumerable: true,
    get() { getterRead = true; return "synthetic getter"; },
  });
  expectContractError(() => validateCanonicalPostInput(accessorRecord, limits, supportedLanguages));
  assert.equal(getterRead, false, "validation inspects descriptors rather than executing request getters");

  const symbolRecord = { ...canonicalPost, [Symbol("synthetic")]: "forbidden" };
  expectContractError(() => validateCanonicalPostInput(symbolRecord, limits, supportedLanguages));
  const sparseContext = new Array(1);
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, recentContext: sparseContext }, limits, supportedLanguages));
  const extraPropertyContext = [...deepDiveRequest.recentContext] as typeof deepDiveRequest.recentContext & { syntheticExtra?: string };
  extraPropertyContext.syntheticExtra = "not in JSON array elements";
  expectContractError(() => validateDeepDiveRequestInput({ ...deepDiveRequest, recentContext: extraPropertyContext }, limits, supportedLanguages));
});

test("normalized v2 request validator checks response envelope, bounds and canonical quote snapshot shape", () => {
  const mapped = mapCanonicalCgDeepDiveDispatchToTi(cgDeepDiveDispatch, canonicalPost, limits, supportedLanguages);
  const validated = validateDeepDiveRequestInputV2(mapped, limits, supportedLanguages);
  assert.deepEqual(validated, mapped);
  expectContractError(() => validateDeepDiveRequestInputV2({ ...mapped, fullThread: [] }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInputV2({ ...mapped, responseConstraints: { ...mapped.responseConstraints, postLanguage: "xx" } }, limits, supportedLanguages));
  expectContractError(() => validateDeepDiveRequestInputV2({ ...mapped, quote: { ...mapped.quote!, unknown: "forbidden" } }, limits, supportedLanguages));
});
