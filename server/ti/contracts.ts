export const CURRENT_TI_INPUT_VERSION = 1 as const;
export const SUPPORTED_TI_INPUT_VERSIONS = [CURRENT_TI_INPUT_VERSION] as const;

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
  readonly categoryId: StableId;
  readonly subcategoryId: string;
  readonly topicIds: readonly string[];
  readonly source?: LinkedSourceV1;
  readonly moderationState: string;
  readonly publicationState: string;
  readonly sourceSnapshotRef?: string;
}

export interface PreferenceInputV1 {
  readonly schemaVersion: 1;
  readonly personaId: PersonaId;
  readonly personaDefinitionVersion: string;
  readonly interestIds: readonly string[];
  readonly preferenceRevision: StableId;
  readonly interestTaxonomyVersion: string;
  /** Untrusted data; consumers must not treat this as policy or privileged instructions. */
  readonly generationGuidance?: string;
}

export interface CGPostQuoteSnapshotV1 {
  readonly type: "cg_post";
  readonly postId: string;
  readonly postContentVersion?: StableId;
  readonly contentHash?: string;
  readonly title: string;
  readonly content: string;
  readonly language: string;
  readonly source?: LinkedSourceV1;
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
    ["postContentVersion", "contentHash", "source", "sourceSnapshotRef"],
    path,
  );
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
    categoryId: readStableId(value.categoryId, `${path}.categoryId`, limits),
    subcategoryId: readString(value.subcategoryId, `${path}.subcategoryId`, limits),
    topicIds: readStringArray(value.topicIds, `${path}.topicIds`, limits),
    ...(source === undefined ? {} : { source }),
    moderationState: readString(value.moderationState, `${path}.moderationState`, limits),
    publicationState: readString(value.publicationState, `${path}.publicationState`, limits),
    ...(value.sourceSnapshotRef === undefined
      ? {}
      : { sourceSnapshotRef: readString(value.sourceSnapshotRef, `${path}.sourceSnapshotRef`, limits) }),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return result;
}

export function validatePreferenceInput(
  input: unknown,
  limits: ContractLimits,
): PreferenceInputV1 {
  assertLimits(limits);
  const path = "preferences";
  const value = asRecord(input, path);
  assertKeys(
    value,
    ["schemaVersion", "personaId", "personaDefinitionVersion", "interestIds", "preferenceRevision", "interestTaxonomyVersion"],
    ["generationGuidance"],
    path,
  );
  readVersion1(value, path);
  const personaId = readString(value.personaId, `${path}.personaId`, limits);
  if (!(APPROVED_PERSONA_IDS as readonly string[]).includes(personaId)) {
    fail(`${path}.personaId`, "is not an approved persona");
  }
  const interestIds = readStringArray(value.interestIds, `${path}.interestIds`, limits, 3);
  if (new Set(interestIds).size !== interestIds.length) {
    fail(`${path}.interestIds`, "must not contain duplicate IDs");
  }
  const canonicalInterestIds = [...interestIds].sort();
  const result: PreferenceInputV1 = {
    schemaVersion: 1,
    personaId: personaId as PersonaId,
    personaDefinitionVersion: readString(value.personaDefinitionVersion, `${path}.personaDefinitionVersion`, limits),
    interestIds: canonicalInterestIds,
    preferenceRevision: readStableId(value.preferenceRevision, `${path}.preferenceRevision`, limits),
    interestTaxonomyVersion: readString(value.interestTaxonomyVersion, `${path}.interestTaxonomyVersion`, limits),
    ...(value.generationGuidance === undefined
      ? {}
      : { generationGuidance: readString(value.generationGuidance, `${path}.generationGuidance`, limits, { allowEmpty: true }) }),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return result;
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
      ["postContentVersion", "contentHash", "source", "sourceSnapshotRef"],
      path,
    );
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
      ...(source === undefined ? {} : { source }),
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
