export const CURRENT_TI_INPUT_VERSION = 1 as const;
export const SUPPORTED_TI_INPUT_VERSIONS = [CURRENT_TI_INPUT_VERSION] as const;

// Preferences gained resolved persona guidance and full interest metadata in v2.
// A peer must negotiate v2; incomplete v1 preferences are never silently upgraded.
export const CURRENT_PREFERENCE_INPUT_VERSION = 2 as const;
export const SUPPORTED_PREFERENCE_INPUT_VERSIONS = [CURRENT_PREFERENCE_INPUT_VERSION] as const;
export const SUPPORTED_DEEP_DIVE_INPUT_VERSIONS = [1, 2] as const;

export const APPROVED_PERSONA_IDS = [
  "Founder",
  "Investor",
  "Operator",
  "Engineer",
  "Regulator",
  "General",
] as const;

export type TiInputVersion = typeof SUPPORTED_TI_INPUT_VERSIONS[number];
export type PersonaId = typeof APPROVED_PERSONA_IDS[number];
export type StableId = string | number;

/**
 * Bounds and supported languages come from explicit service configuration.
 * This module intentionally has no fallback values or production defaults.
 */
export interface ContractLimits {
  readonly maxStringCodePoints: number;
  readonly maxArrayItems: number;
  readonly maxPayloadBytes: number;
  readonly maxContextItems: number;
  readonly maxContextBytes: number;
}

export interface LinkedSourceV1 {
  readonly url: string;
  readonly attribution: string;
}

export interface CanonicalPostInputV1 {
  readonly schemaVersion: 1;
  readonly postId: string;
  readonly postContentVersion?: StableId;
  readonly contentHash?: string;
  readonly title: string;
  readonly content: string;
  /** TI accepts only known, non-null canonical languages; the source field is nullable. */
  readonly language: string;
  /** CG's content representation is carried through the strict TI projection when present. */
  readonly contentFormat?: string;
  readonly categoryId: StableId;
  readonly subcategoryId: string;
  readonly topicIds: readonly string[];
  readonly source?: LinkedSourceV1;
  readonly moderationState: string;
  readonly publicationState: string;
  readonly sourceVersion?: StableId;
  readonly sourceSnapshotReference?: string;
  /** @deprecated TI's pre-CG adapter alias; new CG mappings use sourceSnapshotReference. */
  readonly sourceSnapshotRef?: string;
}

export interface SelectedInterestV2 {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface PreferenceInputV2 {
  readonly schemaVersion: 2;
  readonly personaId: PersonaId;
  readonly personaDefinitionVersion: string;
  /** Resolved, untrusted persona guidance supplied by CG. */
  readonly resolvedPersonaGuidance: string;
  readonly selectedInterests: readonly SelectedInterestV2[];
  readonly preferenceRevision: StableId;
  readonly interestTaxonomyVersion: string;
}


export interface CGPostQuoteSnapshotV1 {
  readonly type: "cg_post";
  readonly postId: string;
  readonly postContentVersion?: StableId;
  readonly contentHash?: string;
  readonly title: string;
  readonly content: string;
  readonly language: string;
  readonly contentFormat?: string;
  readonly source?: LinkedSourceV1;
  readonly sourceVersion?: StableId;
  readonly sourceSnapshotReference?: string;
  /** @deprecated TI's pre-CG adapter alias. */
  readonly sourceSnapshotRef?: string;
  readonly capturedAt: string;
  /** Required nullable value: null means CG did not supply a current version. */
  readonly knownCurrentPostContentVersion: StableId | null;
}

export interface IntelligenceInsightQuoteSnapshotV1 {
  readonly type: "intelligence_insight";
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly itemId: string;
  readonly content: string;
  readonly language: string;
  readonly capturedAt: string;
  /** Required nullable value: null means CG did not supply a current version. */
  readonly knownCurrentArtifactVersion: string | null;
}

export type QuoteSnapshotV1 = CGPostQuoteSnapshotV1 | IntelligenceInsightQuoteSnapshotV1;

export interface RecentContextItemV1 {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Each selected message can carry zero or one exact quote snapshot. */
  readonly quoteSnapshot?: QuoteSnapshotV1;
}

export interface DeepDiveResponseConstraintsV1 {
  readonly schemaVersion: 1;
  readonly outputSchemaVersion: string;
  readonly safetyPolicyVersion: string;
  readonly locale: string;
}

export interface DeepDiveRequestInputV1 {
  readonly schemaVersion: 1;
  readonly userMessageId: string;
  readonly requestRef: string;
  readonly conversationRef: string;
  readonly currentMessage: string;
  readonly recentContext: readonly RecentContextItemV1[];
  readonly quoteSnapshot?: QuoteSnapshotV1;
  readonly responseConstraints: DeepDiveResponseConstraintsV1;
}

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

/** Normalized form retaining the CG quote envelope and exact nested post/insight projection. */
export interface TiMappedCgQuoteV2 {
  readonly quoteId: string;
  readonly parentPostId: string;
  readonly parentPostContentVersion: StableId | null;
  readonly snapshot: QuoteSnapshotV1;
}

export interface DeepDiveResponseConstraintsV2 {
  readonly schemaVersion: 2;
  readonly responseSchemaVersion: string;
  readonly postLanguage: string;
  /** Bounded opaque JSON preserved verbatim; the adapter does not invent policy values. */
  readonly safetyRequirements: JsonObject;
}

export interface DeepDiveContextItemV2 {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly quote?: TiMappedCgQuoteV2;
}

/** Versioned TI normalization of the canonical CG dispatch envelope. */
export interface DeepDiveRequestInputV2 {
  readonly schemaVersion: 2;
  readonly userMessageId: string;
  readonly requestRef: string;
  readonly conversationRef: string;
  readonly currentMessage: string;
  readonly recentContext: readonly DeepDiveContextItemV2[];
  readonly quote?: TiMappedCgQuoteV2;
  readonly responseConstraints: DeepDiveResponseConstraintsV2;
}

export interface CgDispatchQuoteProjector {
  (cgStoredQuote: unknown): TiMappedCgQuoteV2;
}

/** Canonical CG quote-v1 envelope: common parent metadata plus exactly one nested snapshot. */
export interface CanonicalCgQuoteSnapshotV1 {
  readonly quoteId: string;
  readonly parentPostId: string;
  readonly parentPostContentVersion: StableId | null;
  readonly post?: Omit<CGPostQuoteSnapshotV1, "type">;
  readonly insight?: Omit<IntelligenceInsightQuoteSnapshotV1, "type">;
}

/** Restricted operation metadata is deliberately separate from shared artifact inputs. */
export interface RestrictedRequestMetadataV1 {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly quotaSubject: string;
}

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractValidationError";
  }
}

function fail(path: string, reason: string): never {
  throw new ContractValidationError(`${path}: ${reason}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "required field is missing");
  }
}

function assertLimits(limits: ContractLimits): void {
  const entries = Object.entries(limits ?? {});
  const required = [
    "maxStringCodePoints",
    "maxArrayItems",
    "maxPayloadBytes",
    "maxContextItems",
    "maxContextBytes",
  ];
  if (entries.length !== required.length || required.some((key) => !Object.hasOwn(limits ?? {}, key))) {
    fail("limits", "all explicit contract limits are required");
  }
  for (const [name, value] of entries) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`limits.${name}`, "must be a positive safe integer");
    }
  }
}

function assertPayloadSize(value: unknown, maxBytes: number, path: string): void {
  let serialized: string;
  try {
    const result = JSON.stringify(value);
    if (result === undefined) return fail(path, "must be JSON-serializable");
    serialized = result;
  } catch {
    return fail(path, "must be JSON-serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    fail(path, `exceeds configured payload bound (${maxBytes} bytes)`);
  }
}

function readString(
  value: unknown,
  path: string,
  limits: ContractLimits,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") return fail(path, "must be a string");
  if (!options.allowEmpty && value.trim().length === 0) fail(path, "must not be empty");
  if (Array.from(value).length > limits.maxStringCodePoints) {
    fail(path, `exceeds configured string bound (${limits.maxStringCodePoints} code points)`);
  }
  return value;
}

function readStableId(value: unknown, path: string, limits: ContractLimits): StableId {
  if (typeof value === "string") return readString(value, path, limits);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return fail(path, "must be a non-empty string or non-negative safe integer");
}

function readStringArray(
  value: unknown,
  path: string,
  limits: ContractLimits,
  maxItems = limits.maxArrayItems,
): string[] {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  if (value.length > maxItems) fail(path, `exceeds configured item bound (${maxItems})`);
  return value.map((item, index) => readString(item, `${path}[${index}]`, limits));
}

function readVersion1(value: Record<string, unknown>, path: string): 1 {
  if (value.schemaVersion !== CURRENT_TI_INPUT_VERSION) {
    return fail(`${path}.schemaVersion`, "unsupported or missing schema version");
  }
  return CURRENT_TI_INPUT_VERSION;
}

function readKnownLanguage(
  value: unknown,
  path: string,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
): string {
  if (!Array.isArray(supportedLanguages) || supportedLanguages.length === 0) {
    fail("supportedLanguages", "an explicit non-empty language allowlist is required");
  }
  const language = readString(value, path, limits);
  if (!supportedLanguages.includes(language)) fail(path, "is unknown or not enabled for TI");
  return language;
}

function readSource(value: unknown, limits: ContractLimits, path: string): LinkedSourceV1 {
  const source = asRecord(value, path);
  assertKeys(source, ["url", "attribution"], [], path);
  const url = readString(source.url, `${path}.url`, limits);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return fail(`${path}.url`, "must be an absolute URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    fail(`${path}.url`, "must use HTTP or HTTPS");
  }
  return { url, attribution: readString(source.attribution, `${path}.attribution`, limits) };
}

function readOptionalSource(value: Record<string, unknown>, limits: ContractLimits, path: string): LinkedSourceV1 | undefined {
  return value.source === undefined ? undefined : readSource(value.source, limits, `${path}.source`);
}

function assertPostVersion(value: Record<string, unknown>, path: string): void {
  if (value.postContentVersion === undefined && value.contentHash === undefined) {
    fail(path, "postContentVersion or contentHash is required");
  }
}

function readVersionValue(value: unknown, path: string, limits: ContractLimits): StableId {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    return fail(path, "must be a non-negative safe integer");
  }
  return readString(value, path, limits);
}

function readNullableCurrentVersion(value: unknown, path: string, limits: ContractLimits): string | null {
  return value === null ? null : readString(value, path, limits);
}

export function validateCanonicalPostInput(
  input: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
): CanonicalPostInputV1 {
  assertLimits(limits);
  const path = "canonicalPost";
  const value = asRecord(input, path);
  assertKeys(
    value,
    ["schemaVersion", "postId", "title", "content", "language", "categoryId", "subcategoryId", "topicIds", "moderationState", "publicationState"],
    ["postContentVersion", "contentHash", "contentFormat", "source", "sourceVersion", "sourceSnapshotReference", "sourceSnapshotRef"],
    path,
  );
  if (value.sourceSnapshotRef !== undefined && value.sourceSnapshotReference !== undefined) {
    fail(`${path}.sourceSnapshotRef`, "legacy and canonical snapshot reference fields cannot both be supplied");
  }
  readVersion1(value, path);
  assertPostVersion(value, `${path}.version`);
  if (value.contentHash !== undefined) readString(value.contentHash, `${path}.contentHash`, limits);
  const source = readOptionalSource(value, limits, path);
  const result: CanonicalPostInputV1 = {
    schemaVersion: 1,
    postId: readString(value.postId, `${path}.postId`, limits),
    ...(value.postContentVersion === undefined
      ? {}
      : { postContentVersion: readVersionValue(value.postContentVersion, `${path}.postContentVersion`, limits) }),
    ...(value.contentHash === undefined ? {} : { contentHash: value.contentHash as string }),
    title: readString(value.title, `${path}.title`, limits),
    content: readString(value.content, `${path}.content`, limits),
    language: readKnownLanguage(value.language, `${path}.language`, limits, supportedLanguages),
    ...(value.contentFormat === undefined ? {} : { contentFormat: readString(value.contentFormat, `${path}.contentFormat`, limits) }),
    categoryId: readStableId(value.categoryId, `${path}.categoryId`, limits),
    subcategoryId: readString(value.subcategoryId, `${path}.subcategoryId`, limits),
    topicIds: readStringArray(value.topicIds, `${path}.topicIds`, limits),
    ...(source === undefined ? {} : { source }),
    moderationState: readString(value.moderationState, `${path}.moderationState`, limits),
    publicationState: readString(value.publicationState, `${path}.publicationState`, limits),
    ...(value.sourceVersion === undefined ? {} : { sourceVersion: readVersionValue(value.sourceVersion, `${path}.sourceVersion`, limits) }),
    ...(value.sourceSnapshotReference === undefined ? {} : { sourceSnapshotReference: readString(value.sourceSnapshotReference, `${path}.sourceSnapshotReference`, limits) }),
    ...(value.sourceSnapshotRef === undefined
      ? {}
      : { sourceSnapshotRef: readString(value.sourceSnapshotRef, `${path}.sourceSnapshotRef`, limits) }),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return result;
}

export type CanonicalCgPostInputV1 = CanonicalPostInputV1 & { readonly contentFormat: string };

/** Validates the canonical CG post reference shape, including CG-only fields TI must not drop. */
export function validateCanonicalCgPostInput(
  input: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
): CanonicalCgPostInputV1 {
  const post = validateCanonicalPostInput(input, limits, supportedLanguages);
  if (post.contentFormat === undefined) fail("canonicalPost.contentFormat", "required canonical CG field is missing");
  if (post.sourceSnapshotRef !== undefined) fail("canonicalPost.sourceSnapshotRef", "legacy TI alias is not valid in a canonical CG payload");
  return post as CanonicalCgPostInputV1;
}

export function validatePreferenceInput(
  input: unknown,
  limits: ContractLimits,
): PreferenceInputV2 {
  assertLimits(limits);
  const path = "preferences";
  const value = asRecord(input, path);
  assertKeys(
    value,
    ["schemaVersion", "personaId", "personaDefinitionVersion", "resolvedPersonaGuidance", "selectedInterests", "preferenceRevision", "interestTaxonomyVersion"],
    [],
    path,
  );
  if (value.schemaVersion !== CURRENT_PREFERENCE_INPUT_VERSION) {
    fail(`${path}.schemaVersion`, "unsupported or missing preference schema version");
  }
  const personaId = readString(value.personaId, `${path}.personaId`, limits);
  if (!(APPROVED_PERSONA_IDS as readonly string[]).includes(personaId)) {
    fail(`${path}.personaId`, "is not an approved persona");
  }
  if (!Array.isArray(value.selectedInterests)) fail(`${path}.selectedInterests`, "must be an array");
  if (value.selectedInterests.length > 3) fail(`${path}.selectedInterests`, "exceeds the approved maximum of 3 interests");
  const selectedInterests = value.selectedInterests.map((item, index): SelectedInterestV2 => {
    const interestPath = `${path}.selectedInterests[${index}]`;
    const interest = asRecord(item, interestPath);
    assertKeys(interest, ["id", "label", "description"], [], interestPath);
    return {
      id: readString(interest.id, `${interestPath}.id`, limits),
      label: readString(interest.label, `${interestPath}.label`, limits),
      description: readString(interest.description, `${interestPath}.description`, limits),
    };
  });
  const interestIds = selectedInterests.map(({ id }) => id);
  if (new Set(interestIds).size !== interestIds.length) {
    fail(`${path}.selectedInterests`, "must not contain duplicate stable IDs");
  }
  // Stable IDs define an unordered set. Sort whole records, preserving their metadata association.
  selectedInterests.sort((left, right) => left.id.localeCompare(right.id));
  const result: PreferenceInputV2 = {
    schemaVersion: CURRENT_PREFERENCE_INPUT_VERSION,
    personaId: personaId as PersonaId,
    personaDefinitionVersion: readString(value.personaDefinitionVersion, `${path}.personaDefinitionVersion`, limits),
    resolvedPersonaGuidance: readString(value.resolvedPersonaGuidance, `${path}.resolvedPersonaGuidance`, limits),
    selectedInterests,
    preferenceRevision: readStableId(value.preferenceRevision, `${path}.preferenceRevision`, limits),
    interestTaxonomyVersion: readString(value.interestTaxonomyVersion, `${path}.interestTaxonomyVersion`, limits),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return result;
}

/** Selects the highest shared Deep Dive schema; both v1 TI and v2 CG-mapped requests are explicit. */
export function negotiateDeepDiveInputVersion(offeredVersions: readonly number[]): typeof SUPPORTED_DEEP_DIVE_INPUT_VERSIONS[number] {
  if (!Array.isArray(offeredVersions) || offeredVersions.some((version) => !Number.isSafeInteger(version))) {
    fail("offeredDeepDiveVersions", "must contain only integer versions");
  }
  const common = offeredVersions.filter((version): version is typeof SUPPORTED_DEEP_DIVE_INPUT_VERSIONS[number] =>
    (SUPPORTED_DEEP_DIVE_INPUT_VERSIONS as readonly number[]).includes(version),
  );
  if (common.length === 0) fail("offeredDeepDiveVersions", "no supported Deep Dive schema was offered");
  return Math.max(...common) as typeof SUPPORTED_DEEP_DIVE_INPUT_VERSIONS[number];
}

/** Selects the highest explicitly shared preference schema; v1 cannot omit required metadata. */
export function negotiatePreferenceVersion(offeredVersions: readonly number[]): typeof CURRENT_PREFERENCE_INPUT_VERSION {
  if (!Array.isArray(offeredVersions) || offeredVersions.some((version) => !Number.isSafeInteger(version))) {
    fail("offeredPreferenceVersions", "must contain only integer versions");
  }
  if (!offeredVersions.includes(CURRENT_PREFERENCE_INPUT_VERSION)) {
    fail("offeredPreferenceVersions", "no supported preference contract version was offered");
  }
  return CURRENT_PREFERENCE_INPUT_VERSION;
}

function readTimestamp(value: unknown, path: string, limits: ContractLimits): string {
  const timestamp = readString(value, path, limits);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    fail(path, "must be a UTC ISO-8601 timestamp");
  }
  return timestamp;
}

function readQuoteSnapshot(
  value: unknown,
  limits: ContractLimits,
  path: string,
  supportedLanguages: readonly string[],
): QuoteSnapshotV1 {
  const quote = asRecord(value, path);
  if (quote.type === "cg_post") {
    assertKeys(
      quote,
      ["type", "postId", "title", "content", "language", "capturedAt", "knownCurrentPostContentVersion"],
      ["postContentVersion", "contentHash", "contentFormat", "source", "sourceVersion", "sourceSnapshotReference", "sourceSnapshotRef"],
      path,
    );
    if (quote.sourceSnapshotRef !== undefined && quote.sourceSnapshotReference !== undefined) {
      fail(`${path}.sourceSnapshotRef`, "legacy and canonical snapshot reference fields cannot both be supplied");
    }
    assertPostVersion(quote, path);
    const source = readOptionalSource(quote, limits, path);
    return {
      type: "cg_post",
      postId: readString(quote.postId, `${path}.postId`, limits),
      ...(quote.postContentVersion === undefined
        ? {}
        : { postContentVersion: readVersionValue(quote.postContentVersion, `${path}.postContentVersion`, limits) }),
      ...(quote.contentHash === undefined ? {} : { contentHash: readString(quote.contentHash, `${path}.contentHash`, limits) }),
      title: readString(quote.title, `${path}.title`, limits),
      content: readString(quote.content, `${path}.content`, limits),
      language: readKnownLanguage(quote.language, `${path}.language`, limits, supportedLanguages),
      ...(quote.contentFormat === undefined ? {} : { contentFormat: readString(quote.contentFormat, `${path}.contentFormat`, limits) }),
      ...(source === undefined ? {} : { source }),
      ...(quote.sourceVersion === undefined ? {} : { sourceVersion: readVersionValue(quote.sourceVersion, `${path}.sourceVersion`, limits) }),
      ...(quote.sourceSnapshotReference === undefined ? {} : { sourceSnapshotReference: readString(quote.sourceSnapshotReference, `${path}.sourceSnapshotReference`, limits) }),
      ...(quote.sourceSnapshotRef === undefined
        ? {}
        : { sourceSnapshotRef: readString(quote.sourceSnapshotRef, `${path}.sourceSnapshotRef`, limits) }),
      capturedAt: readTimestamp(quote.capturedAt, `${path}.capturedAt`, limits),
      knownCurrentPostContentVersion: quote.knownCurrentPostContentVersion === null
        ? null
        : readVersionValue(quote.knownCurrentPostContentVersion, `${path}.knownCurrentPostContentVersion`, limits),
    };
  }

  if (quote.type === "intelligence_insight") {
    assertKeys(
      quote,
      ["type", "artifactId", "artifactVersion", "itemId", "content", "language", "capturedAt", "knownCurrentArtifactVersion"],
      [],
      path,
    );
    return {
      type: "intelligence_insight",
      artifactId: readString(quote.artifactId, `${path}.artifactId`, limits),
      artifactVersion: readString(quote.artifactVersion, `${path}.artifactVersion`, limits),
      itemId: readString(quote.itemId, `${path}.itemId`, limits),
      content: readString(quote.content, `${path}.content`, limits),
      language: readKnownLanguage(quote.language, `${path}.language`, limits, supportedLanguages),
      capturedAt: readTimestamp(quote.capturedAt, `${path}.capturedAt`, limits),
      knownCurrentArtifactVersion: readNullableCurrentVersion(
        quote.knownCurrentArtifactVersion,
        `${path}.knownCurrentArtifactVersion`,
        limits,
      ),
    };
  }

  return fail(`${path}.type`, "unsupported quote type");
}

function readRecentContext(
  value: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
): RecentContextItemV1[] {
  const path = "deepDive.recentContext";
  if (!Array.isArray(value)) return fail(path, "must be an array");
  if (value.length > limits.maxContextItems) {
    fail(path, `exceeds configured context item bound (${limits.maxContextItems})`);
  }
  let totalBytes = 0;
  const result = value.map((item, index): RecentContextItemV1 => {
    const itemPath = `${path}[${index}]`;
    const context = asRecord(item, itemPath);
    assertKeys(context, ["messageId", "role", "content"], ["quoteSnapshot"], itemPath);
    if (context.role !== "user" && context.role !== "assistant") {
      fail(`${itemPath}.role`, "must be user or assistant");
    }
    const parsed: RecentContextItemV1 = {
      messageId: readString(context.messageId, `${itemPath}.messageId`, limits),
      role: context.role,
      content: readString(context.content, `${itemPath}.content`, limits),
      ...(context.quoteSnapshot === undefined
        ? {}
        : { quoteSnapshot: readQuoteSnapshot(context.quoteSnapshot, limits, `${itemPath}.quoteSnapshot`, supportedLanguages) }),
    };
    totalBytes += new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
    return parsed;
  });
  if (totalBytes > limits.maxContextBytes) {
    fail(path, `exceeds configured context byte bound (${limits.maxContextBytes} bytes)`);
  }
  return result;
}

function readResponseConstraints(value: unknown, limits: ContractLimits): DeepDiveResponseConstraintsV1 {
  const path = "deepDive.responseConstraints";
  const constraints = asRecord(value, path);
  assertKeys(constraints, ["schemaVersion", "outputSchemaVersion", "safetyPolicyVersion", "locale"], [], path);
  readVersion1(constraints, path);
  return {
    schemaVersion: 1,
    outputSchemaVersion: readString(constraints.outputSchemaVersion, `${path}.outputSchemaVersion`, limits),
    safetyPolicyVersion: readString(constraints.safetyPolicyVersion, `${path}.safetyPolicyVersion`, limits),
    locale: readString(constraints.locale, `${path}.locale`, limits),
  };
}

export function validateDeepDiveRequestInput(
  input: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
): DeepDiveRequestInputV1 {
  assertLimits(limits);
  const path = "deepDive";
  const value = asRecord(input, path);
  assertKeys(
    value,
    ["schemaVersion", "userMessageId", "requestRef", "conversationRef", "currentMessage", "recentContext", "responseConstraints"],
    ["quoteSnapshot"],
    path,
  );
  readVersion1(value, path);
  const result: DeepDiveRequestInputV1 = {
    schemaVersion: 1,
    userMessageId: readString(value.userMessageId, `${path}.userMessageId`, limits),
    requestRef: readString(value.requestRef, `${path}.requestRef`, limits),
    conversationRef: readString(value.conversationRef, `${path}.conversationRef`, limits),
    currentMessage: readString(value.currentMessage, `${path}.currentMessage`, limits),
    recentContext: readRecentContext(value.recentContext, limits, supportedLanguages),
    ...(value.quoteSnapshot === undefined
      ? {}
      : { quoteSnapshot: readQuoteSnapshot(value.quoteSnapshot, limits, `${path}.quoteSnapshot`, supportedLanguages) }),
    responseConstraints: readResponseConstraints(value.responseConstraints, limits),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return result;
}

function readJsonValue(value: unknown, path: string, limits: ContractLimits, depth = 0): JsonValue {
  if (depth > 24) fail(path, "exceeds JSON nesting bound");
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return readString(value, path, limits, { allowEmpty: true });
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must contain finite JSON numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) fail(path, `exceeds configured JSON array bound (${limits.maxArrayItems})`);
    return value.map((item, index) => readJsonValue(item, `${path}[${index}]`, limits, depth + 1));
  }
  const object = asRecord(value, path);
  return Object.fromEntries(Object.entries(object).map(([key, child]) => {
    readString(key, `${path} key`, limits);
    return [key, readJsonValue(child, `${path}.${key}`, limits, depth + 1)];
  }));
}

export function mapCanonicalCgQuoteSnapshotToTi(
  input: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
): TiMappedCgQuoteV2 {
  const path = "cgQuoteSnapshot";
  const quote = asRecord(input, path);
  assertKeys(quote, ["quoteId", "parentPostId", "parentPostContentVersion"], ["post", "insight"], path);
  const hasPost = Object.hasOwn(quote, "post");
  const hasInsight = Object.hasOwn(quote, "insight");
  if (hasPost === hasInsight) fail(path, "must contain exactly one nested post or insight snapshot");
  const parentPostContentVersion = quote.parentPostContentVersion === null
    ? null
    : readVersionValue(quote.parentPostContentVersion, `${path}.parentPostContentVersion`, limits);
  const nestedSnapshot = hasPost
    ? asRecord(quote.post, `${path}.post`)
    : asRecord(quote.insight, `${path}.insight`);
  if (Object.hasOwn(nestedSnapshot, "type")) fail(`${path}.snapshot.type`, "snapshot discriminator is derived from its enclosing CG field");
  if (hasPost && Object.hasOwn(nestedSnapshot, "sourceSnapshotRef")) {
    fail(`${path}.post.sourceSnapshotRef`, "legacy TI alias is not valid in a canonical CG quote snapshot");
  }
  const snapshotValue = hasPost
    ? { ...nestedSnapshot, type: "cg_post" }
    : { ...nestedSnapshot, type: "intelligence_insight" };
  return {
    quoteId: readString(quote.quoteId, `${path}.quoteId`, limits),
    parentPostId: readString(quote.parentPostId, `${path}.parentPostId`, limits),
    parentPostContentVersion,
    snapshot: readQuoteSnapshot(snapshotValue, limits, `${path}.snapshot`, supportedLanguages),
  };
}

function readTiMappedCgQuote(
  input: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
  path: string,
): TiMappedCgQuoteV2 {
  const quote = asRecord(input, path);
  assertKeys(quote, ["quoteId", "parentPostId", "parentPostContentVersion", "snapshot"], [], path);
  const parentVersion = quote.parentPostContentVersion === null
    ? null
    : readVersionValue(quote.parentPostContentVersion, `${path}.parentPostContentVersion`, limits);
  return {
    quoteId: readString(quote.quoteId, `${path}.quoteId`, limits),
    parentPostId: readString(quote.parentPostId, `${path}.parentPostId`, limits),
    parentPostContentVersion: parentVersion,
    snapshot: readQuoteSnapshot(quote.snapshot, limits, `${path}.snapshot`, supportedLanguages),
  };
}

/**
 * Maps the known CG dispatch envelope names/shapes into a versioned TI request.
 * Stored quote-v1 payloads are projected by an explicit adapter because CG owns
 * their nested schema; a present quote is never discarded or guessed at here.
 */
export function mapCanonicalCgDeepDiveDispatchToTi(
  input: unknown,
  canonicalPostInput: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
  projectCgQuote?: CgDispatchQuoteProjector,
): DeepDiveRequestInputV2 {
  assertLimits(limits);
  const canonicalPost = validateCanonicalCgPostInput(canonicalPostInput, limits, supportedLanguages);
  const path = "cgDeepDiveDispatch";
  const dispatch = asRecord(input, path);
  assertKeys(dispatch,
    ["userMessageId", "requestReference", "conversationRef", "currentMessage", "recentContext", "responseConstraints"],
    [], path);

  const quoteProjector: CgDispatchQuoteProjector = projectCgQuote
    ?? ((value) => mapCanonicalCgQuoteSnapshotToTi(value, limits, supportedLanguages));
  const projectQuote = (value: unknown, quotePath: string): TiMappedCgQuoteV2 =>
    readTiMappedCgQuote(quoteProjector(value), limits, supportedLanguages, quotePath);
  const current = asRecord(dispatch.currentMessage, `${path}.currentMessage`);
  assertKeys(current, ["text"], ["quote"], `${path}.currentMessage`);
  const contextInput = dispatch.recentContext;
  if (!Array.isArray(contextInput)) fail(`${path}.recentContext`, "must be an array");
  if (contextInput.length > limits.maxContextItems) {
    fail(`${path}.recentContext`, `exceeds configured context item bound (${limits.maxContextItems})`);
  }
  let contextBytes = 0;
  const recentContext = contextInput.map((entry, index): DeepDiveContextItemV2 => {
    const itemPath = `${path}.recentContext[${index}]`;
    const item = asRecord(entry, itemPath);
    assertKeys(item, ["messageId", "role", "text"], ["quote"], itemPath);
    if (item.role !== "user" && item.role !== "assistant") fail(`${itemPath}.role`, "must be user or assistant");
    const normalized: DeepDiveContextItemV2 = {
      messageId: readString(item.messageId, `${itemPath}.messageId`, limits),
      role: item.role,
      content: readString(item.text, `${itemPath}.text`, limits),
      ...(item.quote === undefined ? {} : { quote: projectQuote(item.quote, `${itemPath}.quote`) }),
    };
    contextBytes += new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
    return normalized;
  });
  if (contextBytes > limits.maxContextBytes) {
    fail(`${path}.recentContext`, `exceeds configured context byte bound (${limits.maxContextBytes} bytes)`);
  }

  const constraints = asRecord(dispatch.responseConstraints, `${path}.responseConstraints`);
  assertKeys(constraints, ["responseSchemaVersion", "postLanguage", "safetyRequirements"], [], `${path}.responseConstraints`);
  const postLanguage = readKnownLanguage(constraints.postLanguage, `${path}.responseConstraints.postLanguage`, limits, supportedLanguages);
  if (postLanguage !== canonicalPost.language) {
    fail(`${path}.responseConstraints.postLanguage`, "must equal the linked canonical post language");
  }
  const currentMessage = readString(current.text, `${path}.currentMessage.text`, limits);
  const safetyRequirementsValue = readJsonValue(constraints.safetyRequirements, `${path}.responseConstraints.safetyRequirements`, limits);
  if (safetyRequirementsValue === null || Array.isArray(safetyRequirementsValue) || typeof safetyRequirementsValue !== "object") {
    fail(`${path}.responseConstraints.safetyRequirements`, "must be a JSON object");
  }
  const result: DeepDiveRequestInputV2 = {
    schemaVersion: 2,
    userMessageId: readString(dispatch.userMessageId, `${path}.userMessageId`, limits),
    requestRef: readString(dispatch.requestReference, `${path}.requestReference`, limits),
    conversationRef: readString(dispatch.conversationRef, `${path}.conversationRef`, limits),
    currentMessage,
    recentContext,
    ...(current.quote === undefined ? {} : { quote: projectQuote(current.quote, `${path}.currentMessage.quote`) }),
    responseConstraints: {
      schemaVersion: 2,
      responseSchemaVersion: readString(constraints.responseSchemaVersion, `${path}.responseConstraints.responseSchemaVersion`, limits),
      postLanguage,
      safetyRequirements: safetyRequirementsValue as JsonObject,
    },
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  assertPayloadSize(result, limits.maxPayloadBytes, `${path}.normalized`);
  return result;
}

export interface TiInputMappingV1 {
  readonly schemaVersion: 1;
  readonly canonicalPost: CanonicalPostInputV1;
  readonly preferences: PreferenceInputV2;
  /** Derived only from the canonical post; no independent language/default is accepted. */
  readonly outputLanguage: string;
  readonly deepDiveRequest?: DeepDiveRequestInputV1;
}

/** Validates and maps canonical CG payloads without inventing IDs, defaults, or identity. */
export function mapCanonicalCgInputsToTi(
  input: unknown,
  limits: ContractLimits,
  supportedLanguages: readonly string[],
): TiInputMappingV1 {
  assertLimits(limits);
  const path = "cgToTi";
  const value = asRecord(input, path);
  assertKeys(value, ["canonicalPost", "preferences"], ["deepDiveRequest"], path);
  const canonicalPost = validateCanonicalCgPostInput(value.canonicalPost, limits, supportedLanguages);
  const preferences = validatePreferenceInput(value.preferences, limits);
  const deepDiveRequest = value.deepDiveRequest === undefined
    ? undefined
    : validateDeepDiveRequestInput(value.deepDiveRequest, limits, supportedLanguages);
  const mapped: TiInputMappingV1 = {
    schemaVersion: 1,
    canonicalPost,
    preferences,
    outputLanguage: canonicalPost.language,
    ...(deepDiveRequest === undefined ? {} : { deepDiveRequest }),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return mapped;
}

export function validateRestrictedRequestMetadata(
  input: unknown,
  limits: ContractLimits,
): RestrictedRequestMetadataV1 {
  assertLimits(limits);
  const path = "requestMetadata";
  const value = asRecord(input, path);
  assertKeys(value, ["schemaVersion", "requestId", "quotaSubject"], [], path);
  readVersion1(value, path);
  const result: RestrictedRequestMetadataV1 = {
    schemaVersion: 1,
    requestId: readString(value.requestId, `${path}.requestId`, limits),
    quotaSubject: readString(value.quotaSubject, `${path}.quotaSubject`, limits),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return result;
}

/** Selects the highest explicitly shared contract version; never coerces between versions. */
export function negotiateInputVersion(offeredVersions: readonly number[]): TiInputVersion {
  if (!Array.isArray(offeredVersions) || offeredVersions.some((version) => !Number.isSafeInteger(version))) {
    fail("offeredVersions", "must contain only integer versions");
  }
  const common = offeredVersions.filter((version): version is TiInputVersion =>
    (SUPPORTED_TI_INPUT_VERSIONS as readonly number[]).includes(version),
  );
  if (common.length === 0) fail("offeredVersions", "no supported contract version was offered");
  return Math.max(...common) as TiInputVersion;
}
