import { createHash } from "node:crypto";
import { APPROVED_PERSONA_IDS, type PersonaId, type StableId } from "./contracts";

export interface ArtifactKeyPolicy {
  /** Explicit bound shared with the owning service's canonical-input configuration. */
  readonly maxIdentifierCodePoints: number;
}

/** `unavailable` means no usable linked-original-source evidence is available to ground this artifact. */
export type EvidenceKeyInput =
  | { readonly availability: "available"; readonly evidenceVersion: StableId }
  | { readonly availability: "unavailable" };

export interface ArtifactKeyCommonInput {
  readonly postId: string;
  readonly postContentVersion?: StableId;
  readonly contentHash?: string;
  readonly evidence: EvidenceKeyInput;
  readonly outputLanguage: string;
  readonly generationDefinitionVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: number;
}

export interface ProsConsArtifactKeyInput extends ArtifactKeyCommonInput {
  readonly personaId: PersonaId;
  readonly personaDefinitionVersion: string;
  readonly interestTaxonomyVersion: string;
  readonly interestIds: readonly string[];
}

export class ArtifactKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactKeyValidationError";
  }
}

const fail = (message: string): never => { throw new ArtifactKeyValidationError(message); };

function validatePolicy(policy: ArtifactKeyPolicy): void {
  if (!Number.isSafeInteger(policy?.maxIdentifierCodePoints) || policy.maxIdentifierCodePoints <= 0) {
    fail("maxIdentifierCodePoints must be explicitly configured as a positive safe integer");
  }
}

function assertRecord(value: unknown, allowedKeys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} must not contain symbol properties`);
  const allowed = new Set(allowedKeys);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.has(key)) fail(`${label} contains an unsupported field: ${key}`);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail(`${label} must contain only enumerable data properties`);
    }
  }
}

function readBoundedString(value: unknown, label: string, policy: ArtifactKeyPolicy): string {
  if (typeof value !== "string") fail(`${label} must be a non-empty string`);
  const text = value as string;
  if (text.trim().length === 0) fail(`${label} must be a non-empty string`);
  if (Array.from(text).length > policy.maxIdentifierCodePoints) {
    fail(`${label} exceeds the configured ${policy.maxIdentifierCodePoints}-code-point bound`);
  }
  return text;
}

function readStableId(value: unknown, label: string, policy: ArtifactKeyPolicy): StableId {
  if (typeof value === "string") return readBoundedString(value, label, policy);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return fail(`${label} must be a non-empty string or non-negative safe integer`);
}

function readEvidence(value: unknown, policy: ArtifactKeyPolicy): readonly ["available" | "unavailable", StableId | null] {
  assertRecord(value, ["availability", "evidenceVersion"], "evidence");
  const candidate = value as Record<string, unknown>;
  if (candidate.availability === "unavailable") {
    if (Object.hasOwn(candidate, "evidenceVersion")) fail("unavailable evidence must not provide evidenceVersion");
    return ["unavailable", null];
  }
  if (candidate.availability !== "available") fail("evidence.availability must be available or unavailable");
  if (!Object.hasOwn(candidate, "evidenceVersion")) fail("available evidence requires evidenceVersion");
  return ["available", readStableId(candidate.evidenceVersion, "evidence.evidenceVersion", policy)];
}

function canonicalJson(value: readonly unknown[]): string {
  // The input is a closed, ordered tuple of JSON primitives; object key order is not involved.
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readCommon(input: unknown, policy: ArtifactKeyPolicy, permittedKeys: readonly string[]) {
  validatePolicy(policy);
  assertRecord(input, permittedKeys, "artifact key input");
  const value = input as Record<string, unknown>;
  const postId = readBoundedString(value.postId, "postId", policy);
  const hasPostVersion = value.postContentVersion !== undefined;
  const hasContentHash = value.contentHash !== undefined;
  if (!hasPostVersion && !hasContentHash) fail("postContentVersion or contentHash is required");
  const postContentVersion = hasPostVersion
    ? readStableId(value.postContentVersion, "postContentVersion", policy)
    : null;
  const contentHash = hasContentHash
    ? readBoundedString(value.contentHash, "contentHash", policy)
    : null;
  const evidence = readEvidence(value.evidence, policy);
  const outputLanguage = readBoundedString(value.outputLanguage, "outputLanguage", policy);
  const generationDefinitionVersion = readBoundedString(value.generationDefinitionVersion, "generationDefinitionVersion", policy);
  const promptVersion = readBoundedString(value.promptVersion, "promptVersion", policy);
  if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) <= 0) {
    fail("schemaVersion must be a positive safe integer");
  }
  return [
    postId,
    postContentVersion,
    contentHash,
    evidence[0],
    evidence[1],
    outputLanguage,
    generationDefinitionVersion,
    promptVersion,
    value.schemaVersion,
  ] as const;
}

function buildKey(kind: "summary" | "pros_cons", identity: readonly unknown[]): string {
  return `ti:${kind}:v1:${sha256Hex(canonicalJson(["ti-artifact-key", 1, kind, ...identity]))}`;
}

/** Stable shared Summary key. User, persona, interest, provider and model identifiers are not accepted. */
export function createSummaryArtifactKey(input: ArtifactKeyCommonInput, policy: ArtifactKeyPolicy): string {
  const identity = readCommon(input, policy, [
    "postId", "postContentVersion", "contentHash", "evidence", "outputLanguage",
    "generationDefinitionVersion", "promptVersion", "schemaVersion",
  ]);
  return buildKey("summary", identity);
}

/**
 * Stable shared Pros/Cons key. Callers pass stable IDs from the validated preference contract.
 * Interest order is canonicalized and only a domain-separated digest of the ID set enters the
 * outer key; raw IDs never appear in the returned key.
 */
export function createProsConsArtifactKey(input: ProsConsArtifactKeyInput, policy: ArtifactKeyPolicy): string {
  const identity = readCommon(input, policy, [
    "postId", "postContentVersion", "contentHash", "evidence", "outputLanguage",
    "generationDefinitionVersion", "promptVersion", "schemaVersion", "personaId",
    "personaDefinitionVersion", "interestTaxonomyVersion", "interestIds",
  ]);
  if (typeof input.personaId !== "string" || !APPROVED_PERSONA_IDS.includes(input.personaId)) {
    fail("personaId is not an approved stable persona ID");
  }
  const personaDefinitionVersion = readBoundedString(input.personaDefinitionVersion, "personaDefinitionVersion", policy);
  const interestTaxonomyVersion = readBoundedString(input.interestTaxonomyVersion, "interestTaxonomyVersion", policy);
  if (!Array.isArray(input.interestIds) || input.interestIds.length > 3) {
    fail("interestIds must be an array containing at most three stable IDs");
  }
  if (Object.getOwnPropertySymbols(input.interestIds).length > 0 || Object.keys(input.interestIds).length !== input.interestIds.length) {
    fail("interestIds must be a dense array without extra or symbol properties");
  }
  const interestDescriptors = Object.getOwnPropertyDescriptors(input.interestIds);
  for (let index = 0; index < input.interestIds.length; index += 1) {
    const descriptor = interestDescriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("interestIds must contain only enumerable data elements");
    }
  }
  const uniqueInterestIds = new Set<string>();
  for (const [index, interestId] of input.interestIds.entries()) {
    uniqueInterestIds.add(readBoundedString(interestId, `interestIds[${index}]`, policy));
  }
  const canonicalInterestIds = [...uniqueInterestIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const interestSetHash = sha256Hex(canonicalJson(["ti-interest-set", 1, canonicalInterestIds]));
  return buildKey("pros_cons", [
    ...identity,
    input.personaId as PersonaId,
    personaDefinitionVersion,
    interestTaxonomyVersion,
    interestSetHash,
  ]);
}
