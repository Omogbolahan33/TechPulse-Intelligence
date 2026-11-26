import { createHash } from 'node:crypto';
import {
  validateDeepDiveRequestInput,
  validateDeepDiveRequestInputV2,
  type ContractLimits,
  type DeepDiveRequestInputV1,
  type DeepDiveRequestInputV2,
} from './contracts';
import { PersistenceIdempotencyConflictError, TiPersistence } from './persistence';

export interface AuthenticatedCgDeepDiveCaller {
  /** Restricted quota subject from verified CG service identity; never part of shared request payloads. */
  readonly quotaSubject: string;
  readonly scopes: readonly string[];
}

export type CgDeepDiveAuthenticator = (credential: unknown) => Promise<AuthenticatedCgDeepDiveCaller | null>;

export interface DeepDiveRequestPolicy {
  readonly contractLimits: ContractLimits;
  readonly supportedLanguages: readonly string[];
  readonly waitHorizonMs: number;
  readonly retentionClass: string;
}

export interface DeepDiveRequestDependencies {
  readonly authenticate: CgDeepDiveAuthenticator;
  readonly now?: () => Date;
}

export interface AcceptedDeepDiveOperation {
  readonly requestId: string;
  readonly created: boolean;
  readonly state: 'accepted';
  readonly inputSchemaVersion: 1 | 2;
}

export type DeepDiveRequestFailureCode = 'unauthorized' | 'invalid_request' | 'idempotency_conflict' | 'unavailable';

/** Safe public failure; never exposes credentials, request content, SQL errors or upstream details. */
export class DeepDiveRequestError extends Error {
  readonly code: DeepDiveRequestFailureCode;

  constructor(code: DeepDiveRequestFailureCode) {
    super(`Deep Dive request failed (${code})`);
    this.name = 'DeepDiveRequestError';
    this.code = code;
  }
}

function assertDenseStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Object.getOwnPropertySymbols(value).length > 0
      || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new Error(`${label} must be a dense plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
      throw new Error(`${label} must contain only string data elements`);
    }
  }
}

function snapshotPolicy(input: DeepDiveRequestPolicy): DeepDiveRequestPolicy {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error('Deep Dive request policy must be a plain object');
  }
  const allowed = ['contractLimits', 'supportedLanguages', 'waitHorizonMs', 'retentionClass'];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.getOwnPropertySymbols(input).length > 0
      || Object.keys(descriptors).length !== allowed.length
      || Object.keys(descriptors).some((key) => !allowed.includes(key)
        || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new Error('Deep Dive request policy must contain exactly the supported data fields');
  }
  if (!Number.isSafeInteger(input.waitHorizonMs) || input.waitHorizonMs <= 0) {
    throw new Error('Deep Dive waitHorizonMs must be explicitly configured as a positive safe integer');
  }
  if (typeof input.retentionClass !== 'string' || input.retentionClass.trim().length === 0) {
    throw new Error('Deep Dive retentionClass must be explicitly configured');
  }
  const limitKeys = ['maxStringCodePoints', 'maxArrayItems', 'maxPayloadBytes', 'maxContextItems', 'maxContextBytes'] as const;
  const limitDescriptors = Object.getOwnPropertyDescriptors(input.contractLimits);
  if (input.contractLimits === null || typeof input.contractLimits !== 'object' || Array.isArray(input.contractLimits)
      || (Object.getPrototypeOf(input.contractLimits) !== Object.prototype && Object.getPrototypeOf(input.contractLimits) !== null)
      || Object.getOwnPropertySymbols(input.contractLimits).length > 0
      || Object.keys(limitDescriptors).length !== limitKeys.length
      || Object.keys(limitDescriptors).some((key) => !limitKeys.includes(key as typeof limitKeys[number])
        || !limitDescriptors[key].enumerable || !Object.hasOwn(limitDescriptors[key], 'value'))
      || limitKeys.some((key) => !Number.isSafeInteger(input.contractLimits[key]) || input.contractLimits[key] <= 0)) {
    throw new Error('Deep Dive request contract limits must be explicitly and safely configured');
  }
  assertDenseStringArray(input.supportedLanguages, 'supportedLanguages');
  if (input.supportedLanguages.length === 0 || input.supportedLanguages.some((language) => language.trim().length === 0)
      || new Set(input.supportedLanguages).size !== input.supportedLanguages.length) {
    throw new Error('supportedLanguages must be a non-empty set of unique language IDs');
  }
  const contractLimits = Object.freeze({
    maxStringCodePoints: input.contractLimits.maxStringCodePoints,
    maxArrayItems: input.contractLimits.maxArrayItems,
    maxPayloadBytes: input.contractLimits.maxPayloadBytes,
    maxContextItems: input.contractLimits.maxContextItems,
    maxContextBytes: input.contractLimits.maxContextBytes,
  });
  return Object.freeze({
    contractLimits,
    supportedLanguages: Object.freeze([...input.supportedLanguages]),
    waitHorizonMs: input.waitHorizonMs,
    retentionClass: input.retentionClass,
  });
}

function readSchemaVersion(input: unknown): 1 | 2 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new DeepDiveRequestError('invalid_request');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'schemaVersion');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    throw new DeepDiveRequestError('invalid_request');
  }
  if (descriptor.value !== 1 && descriptor.value !== 2) throw new DeepDiveRequestError('invalid_request');
  return descriptor.value;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalizeJson(record[key])]));
  }
  return value;
}

function canonicalInputHash(value: DeepDiveRequestInputV1 | DeepDiveRequestInputV2): string {
  // Validators normalize schema fields; recursively sorted JSON keys ensure semantically equivalent
  // nested safety constraints produce the same digest regardless of transport property order.
  // Hash content for conflict detection; raw content is never written to generation metadata.
  return createHash('sha256')
    .update(JSON.stringify(['ti-deep-dive-request', value.schemaVersion, canonicalizeJson(value)]), 'utf8')
    .digest('hex');
}

function authenticatePrincipal(value: unknown): AuthenticatedCgDeepDiveCaller {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new DeepDiveRequestError('unauthorized');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = ['quotaSubject', 'scopes'];
  if (Object.getOwnPropertySymbols(value).length > 0
      || Object.keys(descriptors).length !== allowed.length
      || Object.keys(descriptors).some((key) => !allowed.includes(key)
        || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new DeepDiveRequestError('unauthorized');
  }
  const principal = value as AuthenticatedCgDeepDiveCaller;
  if (typeof principal.quotaSubject !== 'string' || principal.quotaSubject.trim().length === 0) {
    throw new DeepDiveRequestError('unauthorized');
  }
  assertDenseStringArray(principal.scopes, 'authenticated CG scopes');
  if (!principal.scopes.includes('deep_dive:create')) throw new DeepDiveRequestError('unauthorized');
  return principal;
}

function readCurrentTime(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) throw new DeepDiveRequestError('unavailable');
  return new Date(value.getTime());
}

/**
 * Authenticated request-validation/idempotency boundary for Deep Dive. This does not enqueue or
 * invoke a provider; accepted durable work is consumed by the separately specified OPS queue path.
 */
export class DeepDiveRequestService {
  private readonly persistence: TiPersistence;
  private readonly policy: DeepDiveRequestPolicy;
  private readonly authenticate: CgDeepDiveAuthenticator;
  private readonly now: () => Date;

  constructor(persistence: TiPersistence, policy: DeepDiveRequestPolicy, dependencies: DeepDiveRequestDependencies) {
    if (!dependencies || typeof dependencies.authenticate !== 'function') {
      throw new Error('Deep Dive service requires an explicit CG service authenticator');
    }
    this.persistence = persistence;
    this.policy = snapshotPolicy(policy);
    this.authenticate = dependencies.authenticate;
    this.now = dependencies.now ?? (() => new Date());
  }

  async accept(credential: unknown, rawInput: unknown): Promise<AcceptedDeepDiveOperation> {
    let principal: AuthenticatedCgDeepDiveCaller;
    try {
      principal = authenticatePrincipal(await this.authenticate(credential));
    } catch {
      throw new DeepDiveRequestError('unauthorized');
    }

    let input: DeepDiveRequestInputV1 | DeepDiveRequestInputV2;
    let version: 1 | 2;
    try {
      version = readSchemaVersion(rawInput);
      input = version === 1
        ? validateDeepDiveRequestInput(rawInput, this.policy.contractLimits, this.policy.supportedLanguages)
        : validateDeepDiveRequestInputV2(rawInput, this.policy.contractLimits, this.policy.supportedLanguages);
    } catch {
      throw new DeepDiveRequestError('invalid_request');
    }

    const createdAt = readCurrentTime(this.now);
    const expiryMs = createdAt.getTime() + this.policy.waitHorizonMs;
    if (!Number.isSafeInteger(expiryMs)) throw new DeepDiveRequestError('unavailable');
    try {
      const result = await this.persistence.createOrGetGenerationRequest({
        idempotencyKey: input.userMessageId,
        operationKind: 'deep_dive',
        inputHash: canonicalInputHash(input),
        state: 'accepted',
        attemptCount: 0,
        correlationId: input.requestRef,
        waitExpiresAt: new Date(expiryMs),
        retentionClass: this.policy.retentionClass,
        quotaSubject: principal.quotaSubject,
      });
      return Object.freeze({
        requestId: result.requestId,
        created: result.created,
        state: 'accepted',
        inputSchemaVersion: version,
      });
    } catch (error) {
      if (error instanceof PersistenceIdempotencyConflictError) {
        throw new DeepDiveRequestError('idempotency_conflict');
      }
      throw new DeepDiveRequestError('unavailable');
    }
  }
}
