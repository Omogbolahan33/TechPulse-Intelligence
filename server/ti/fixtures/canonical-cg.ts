/** Synthetic, immutable CG contract examples. No production values or user identity. */
function deepFreeze<const T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const canonicalPost = deepFreeze({
  schemaVersion: 1,
  postId: "synthetic-post-01",
  postContentVersion: "synthetic-post-version-03",
  contentHash: "sha256:synthetic-post-hash",
  title: "Synthetic multilingual technology post",
  content: "Texte synthétique sur une technologie émergente.",
  language: "fr",
  contentFormat: "text/markdown",
  categoryId: "synthetic-category-02",
  subcategoryId: "synthetic-subcategory-05",
  topicIds: ["synthetic-topic-ai", "synthetic-topic-policy"],
  source: {
    url: "https://publisher.example/synthetic-original",
    attribution: "Synthetic Publisher",
  },
  moderationState: "visible",
  publicationState: "published",
  sourceVersion: "synthetic-source-version-05",
  sourceSnapshotReference: "synthetic-source-snapshot-03",
});

export const canonicalPreferenceV2 = deepFreeze({
  schemaVersion: 2,
  personaId: "General",
  personaDefinitionVersion: "synthetic-persona-v2",
  resolvedPersonaGuidance: "Synthetic resolved guidance for a general audience.",
  selectedInterests: [],
  preferenceRevision: "synthetic-preference-revision-08",
  interestTaxonomyVersion: "synthetic-interest-taxonomy-v4",
});

export const preferenceWithInterestsV2 = deepFreeze({
  ...canonicalPreferenceV2,
  personaId: "Engineer",
  selectedInterests: [
    { id: "synthetic-interest-ai", label: "Artificial intelligence", description: "Synthetic interest description." },
    { id: "synthetic-interest-cloud", label: "Cloud systems", description: "Synthetic cloud systems description." },
  ],
});

export const cgPostQuoteSnapshot = deepFreeze({
  type: "cg_post",
  postId: "synthetic-post-01",
  postContentVersion: "synthetic-post-version-03",
  contentHash: "sha256:synthetic-post-hash",
  title: "Synthetic quoted post",
  content: "Quoted synthetic content with multilingual context.",
  language: "fr",
  contentFormat: "text/markdown",
  source: { url: "https://publisher.example/synthetic-original", attribution: "Synthetic Publisher" },
  sourceVersion: "synthetic-source-version-05",
  sourceSnapshotReference: "synthetic-source-snapshot-03",
  capturedAt: "2026-11-26T08:00:00Z",
  knownCurrentPostContentVersion: "synthetic-post-version-04",
});

export const insightQuoteSnapshot = deepFreeze({
  type: "intelligence_insight",
  artifactId: "synthetic-artifact-01",
  artifactVersion: "synthetic-artifact-version-02",
  itemId: "synthetic-item-01",
  content: "Synthetic intelligence insight.",
  language: "fr",
  capturedAt: "2026-11-26T08:01:00Z",
  knownCurrentArtifactVersion: null,
});

export const cgPostQuoteEnvelope = deepFreeze({
  quoteId: "synthetic-cg-quote-post-01",
  parentPostId: "synthetic-post-01",
  parentPostContentVersion: "synthetic-post-version-03",
  post: {
    postId: "synthetic-post-01",
    postContentVersion: "synthetic-post-version-03",
    contentHash: "sha256:synthetic-post-hash",
    title: "Synthetic quoted post",
    content: "Quoted synthetic content with multilingual context.",
    language: "fr",
    contentFormat: "text/markdown",
    source: { url: "https://publisher.example/synthetic-original", attribution: "Synthetic Publisher" },
    sourceVersion: "synthetic-source-version-05",
    sourceSnapshotReference: "synthetic-source-snapshot-03",
    capturedAt: "2026-11-26T08:00:00Z",
    knownCurrentPostContentVersion: "synthetic-post-version-04",
  },
});

export const cgInsightQuoteEnvelope = deepFreeze({
  quoteId: "synthetic-cg-quote-insight-01",
  parentPostId: "synthetic-post-01",
  parentPostContentVersion: "synthetic-post-version-03",
  insight: {
    artifactId: "synthetic-artifact-01",
    artifactVersion: "synthetic-artifact-version-02",
    itemId: "synthetic-item-01",
    content: "Synthetic intelligence insight.",
    language: "fr",
    capturedAt: "2026-11-26T08:01:00Z",
    knownCurrentArtifactVersion: null,
  },
});

export const cgDeepDiveDispatch = deepFreeze({
  userMessageId: "synthetic-message-01",
  requestReference: "synthetic-request-reference-01",
  conversationRef: "synthetic-conversation-ref-01",
  currentMessage: {
    text: "Que signifie cette affirmation synthétique ?",
    quote: cgPostQuoteEnvelope,
  },
  recentContext: [
    { messageId: "synthetic-message-previous", role: "user", text: "Question précédente synthétique." },
    { messageId: "synthetic-message-answer", role: "assistant", text: "Réponse précédente synthétique.", quote: cgInsightQuoteEnvelope },
  ],
  responseConstraints: {
    responseSchemaVersion: "synthetic-deep-dive-v2",
    postLanguage: "fr",
    safetyRequirements: { groundingRequired: true, noRawIdentity: true },
  },
});

export const deepDiveRequest = deepFreeze({
  schemaVersion: 1,
  userMessageId: "synthetic-message-01",
  requestRef: "synthetic-request-ref-01",
  conversationRef: "synthetic-conversation-ref-01",
  currentMessage: "Que signifie cette affirmation synthétique ?",
  recentContext: [
    { messageId: "synthetic-message-previous", role: "user", content: "Question précédente synthétique." },
    {
      messageId: "synthetic-message-answer",
      role: "assistant",
      content: "Réponse précédente synthétique.",
      quoteSnapshot: insightQuoteSnapshot,
    },
  ],
  quoteSnapshot: cgPostQuoteSnapshot,
  responseConstraints: {
    schemaVersion: 1,
    outputSchemaVersion: "synthetic-deep-dive-v1",
    safetyPolicyVersion: "synthetic-safety-v1",
    locale: "fr-NG",
  },
});
