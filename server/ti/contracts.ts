export const CURRENT_TI_INPUT_VERSION = 1 as const;
export const SUPPORTED_TI_INPUT_VERSIONS = [CURRENT_TI_INPUT_VERSION] as const;

export type TiInputVersion = typeof SUPPORTED_TI_INPUT_VERSIONS[number];

/**
 * Every bound is supplied by the owning service configuration. This module intentionally
 * has no fallback values: an absent/unapproved bound must not become launch policy.
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
  readonly publisher: string;
}

export interface CanonicalPostInputV1 {
  readonly schemaVersion: 1;
  readonly postId: string;
  readonly postVersion: string;
  readonly contentHash?: string;
  readonly title: string;
  readonly content: string;
  readonly outputLanguage: string;
  readonly categoryId: string;
  readonly subcategoryId: string;
  readonly topicIds: readonly string[];
  readonly linkedSource: LinkedSourceV1;
  readonly moderationState: string;
  readonly publicationState: string;
  readonly sourceSnapshotRef?: string;
}

export interface PreferenceInputV1 {
  readonly schemaVersion: 1;
  readonly personaId: string;
  readonly personaDefinitionVersion: string;
  readonly interestIds: readonly string[];
  readonly taxonomyVersion: string;
  /** Untrusted data; consumers must not treat this as policy or privileged instructions. */
  readonly generationGuidance?: string;
}

export interface QuoteSnapshotV1 {
  readonly type: "cg_post" | "intelligence_insight";
  readonly snapshotId: string;
  readonly version: string;
  readonly content: string;
}

export interface RecentContextItemV1 {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface DeepDiveRequestInputV1 {
  readonly schemaVersion: 1;
  readonly userMessageId: string;
  readonly requestRef: string;
  readonly conversationRef: string;
  readonly currentMessage: string;
  readonly recentContext: readonly RecentContextItemV1[];
  readonly quoteSnapshot?: QuoteSnapshotV1;
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
    serialized = JSON.stringify(value);
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

function readLinkedSource(value: unknown, limits: ContractLimits): LinkedSourceV1 {
  const path = "canonicalPost.linkedSource";
  const source = asRecord(value, path);
  assertKeys(source, ["url", "publisher"], [], path);
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
  return {
    url,
    publisher: readString(source.publisher, `${path}.publisher`, limits),
  };
}

export function validateCanonicalPostInput(
  input: unknown,
  limits: ContractLimits,
): CanonicalPostInputV1 {
  assertLimits(limits);
  const path = "canonicalPost";
  const value = asRecord(input, path);
  assertKeys(
    value,
    [
      "schemaVersion",
      "postId",
      "postVersion",
      "title",
      "content",
      "outputLanguage",
      "categoryId",
      "subcategoryId",
      "topicIds",
      "linkedSource",
      "moderationState",
      "publicationState",
    ],
    ["contentHash", "sourceSnapshotRef"],
    path,
  );
  readVersion1(value, path);

  const result: CanonicalPostInputV1 = {
    schemaVersion: 1,
    postId: readString(value.postId, `${path}.postId`, limits),
    postVersion: readString(value.postVersion, `${path}.postVersion`, limits),
    title: readString(value.title, `${path}.title`, limits),
    content: readString(value.content, `${path}.content`, limits),
    outputLanguage: readString(value.outputLanguage, `${path}.outputLanguage`, limits),
    categoryId: readString(value.categoryId, `${path}.categoryId`, limits),
    subcategoryId: readString(value.subcategoryId, `${path}.subcategoryId`, limits),
    topicIds: readStringArray(value.topicIds, `${path}.topicIds`, limits),
    linkedSource: readLinkedSource(value.linkedSource, limits),
    moderationState: readString(value.moderationState, `${path}.moderationState`, limits),
    publicationState: readString(value.publicationState, `${path}.publicationState`, limits),
    ...(value.contentHash === undefined
      ? {}
      : { contentHash: readString(value.contentHash, `${path}.contentHash`, limits) }),
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
  approvedPersonaIds: readonly string[],
): PreferenceInputV1 {
  assertLimits(limits);
  if (!Array.isArray(approvedPersonaIds) || approvedPersonaIds.length !== 6) {
    fail("approvedPersonaIds", "exactly six approved persona IDs must be supplied by configuration");
  }
  const allowedPersonas = new Set(approvedPersonaIds);
  if (allowedPersonas.size !== 6 || approvedPersonaIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    fail("approvedPersonaIds", "must contain six unique, non-empty IDs");
  }

  const path = "preferences";
  const value = asRecord(input, path);
  assertKeys(
    value,
    ["schemaVersion", "personaId", "personaDefinitionVersion", "interestIds", "taxonomyVersion"],
    ["generationGuidance"],
    path,
  );
  readVersion1(value, path);
  const personaId = readString(value.personaId, `${path}.personaId`, limits);
  if (!allowedPersonas.has(personaId)) fail(`${path}.personaId`, "is not an approved persona");
  const interestIds = readStringArray(value.interestIds, `${path}.interestIds`, limits, 3);
  const result: PreferenceInputV1 = {
    schemaVersion: 1,
    personaId,
    personaDefinitionVersion: readString(value.personaDefinitionVersion, `${path}.personaDefinitionVersion`, limits),
    interestIds,
    taxonomyVersion: readString(value.taxonomyVersion, `${path}.taxonomyVersion`, limits),
    ...(value.generationGuidance === undefined
      ? {}
      : { generationGuidance: readString(value.generationGuidance, `${path}.generationGuidance`, limits, { allowEmpty: true }) }),
  };
  assertPayloadSize(input, limits.maxPayloadBytes, path);
  return result;
}

function readQuoteSnapshot(value: unknown, limits: ContractLimits): QuoteSnapshotV1 {
  const path = "deepDive.quoteSnapshot";
  const quote = asRecord(value, path);
  assertKeys(quote, ["type", "snapshotId", "version", "content"], [], path);
  if (quote.type !== "cg_post" && quote.type !== "intelligence_insight") {
    fail(`${path}.type`, "unsupported quote type");
  }
  return {
    type: quote.type,
    snapshotId: readString(quote.snapshotId, `${path}.snapshotId`, limits),
    version: readString(quote.version, `${path}.version`, limits),
    content: readString(quote.content, `${path}.content`, limits),
  };
}

function readRecentContext(value: unknown, limits: ContractLimits): RecentContextItemV1[] {
  const path = "deepDive.recentContext";
  if (!Array.isArray(value)) return fail(path, "must be an array");
  if (value.length > limits.maxContextItems) {
    fail(path, `exceeds configured context item bound (${limits.maxContextItems})`);
  }
  let totalBytes = 0;
  const result = value.map((item, index): RecentContextItemV1 => {
    const itemPath = `${path}[${index}]`;
    const context = asRecord(item, itemPath);
    assertKeys(context, ["messageId", "role", "content"], [], itemPath);
    if (context.role !== "user" && context.role !== "assistant") {
      fail(`${itemPath}.role`, "must be user or assistant");
    }
    const parsed = {
      messageId: readString(context.messageId, `${itemPath}.messageId`, limits),
      role: context.role,
      content: readString(context.content, `${itemPath}.content`, limits),
    } as const;
    totalBytes += new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
    return parsed;
  });
  if (totalBytes > limits.maxContextBytes) {
    fail(path, `exceeds configured context byte bound (${limits.maxContextBytes} bytes)`);
  }
  return result;
}

export function validateDeepDiveRequestInput(
  input: unknown,
  limits: ContractLimits,
): DeepDiveRequestInputV1 {
  assertLimits(limits);
  const path = "deepDive";
  const value = asRecord(input, path);
  assertKeys(
    value,
    ["schemaVersion", "userMessageId", "requestRef", "conversationRef", "currentMessage", "recentContext"],
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
    recentContext: readRecentContext(value.recentContext, limits),
    ...(value.quoteSnapshot === undefined ? {} : { quoteSnapshot: readQuoteSnapshot(value.quoteSnapshot, limits) }),
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
