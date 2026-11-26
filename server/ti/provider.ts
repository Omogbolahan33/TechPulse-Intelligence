export type ProviderOperationKind = 'summary' | 'pros_cons' | 'deep_dive';

export type ProviderFailureCode =
  | 'timeout'
  | 'overloaded'
  | 'rate_limited'
  | 'transient'
  | 'authentication'
  | 'invalid_request'
  | 'billing'
  | 'policy_rejected'
  | 'unsupported_capability'
  | 'invalid_output'
  | 'cost_limit'
  | 'circuit_open'
  | 'unknown';

const FAILURE_CODES: readonly ProviderFailureCode[] = [
  'timeout', 'overloaded', 'rate_limited', 'transient', 'authentication', 'invalid_request', 'billing',
  'policy_rejected', 'unsupported_capability', 'invalid_output', 'cost_limit', 'circuit_open', 'unknown',
];
const RETRYABLE_FAILURES = new Set<ProviderFailureCode>(['timeout', 'overloaded', 'rate_limited', 'transient']);

export interface StructuredGenerationRequest {
  readonly operationKind: ProviderOperationKind;
  readonly correlationId: string;
  readonly outputLanguage: string;
  readonly schemaVersion: number;
  /** Trusted, server-owned instruction channel; never place post, source, quote, or user data here. */
  readonly trustedInstruction: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export interface ProviderCapabilities {
  readonly structuredOutput: boolean;
  readonly hardCostLimit: boolean;
  readonly maxTimeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  /** Opaque, common accounting unit chosen by deployment configuration; no currency is assumed. */
  readonly costUnit: string;
}

export interface ProviderCompletionOptions {
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly costUnit: string;
  readonly maxCostUnits: number;
  readonly signal: AbortSignal;
}

export interface ProviderCompletion {
  readonly output: unknown;
  /** Actual cost in the exact opaque unit supplied by the deployment's configured cost model. */
  readonly actualCostUnits: number;
}

export interface ProviderAdapter {
  /** Opaque configured identifier. It is provenance, never part of shared artifact identity. */
  readonly providerId: string;
  /** Explicitly configured model identifier; never inferred from SDK defaults. */
  readonly modelId: string;
  readonly capabilities: ProviderCapabilities;
  /** Must return a safe upper bound in the configured common cost unit for this immutable request. */
  estimateMaxCostUnits(request: StructuredGenerationRequest): number;
  /** Implementations must honor AbortSignal and enforce maxCostUnits at the provider boundary. */
  generate(request: StructuredGenerationRequest, options: ProviderCompletionOptions): Promise<ProviderCompletion>;
}

export interface ProviderRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly attemptLimit: number;
  readonly timeoutMs: number;
  /** Per-attempt hard cost ceiling, configured by the deployment's approved cost model. */
  readonly maxCostUnits: number;
}

export interface ProviderPolicy {
  /** Ordered provider candidates; order is explicit and never inferred from installed SDKs. */
  readonly routes: readonly ProviderRoute[];
  readonly maxTotalAttempts: number;
  readonly maxElapsedMs: number;
  readonly totalCostLimitUnits: number;
  readonly costUnit: string;
  readonly retryBackoffMs: number;
  readonly retryableFailures: readonly ProviderFailureCode[];
  /** Failure classes eligible for failover to the next explicitly ordered route. */
  readonly failoverFailures: readonly ProviderFailureCode[];
  readonly failoverOnInvalidOutput: boolean;
}

export interface ProviderAttemptEvent {
  readonly providerId: string;
  readonly modelId: string;
  readonly attempt: number;
  readonly failureCode: ProviderFailureCode | null;
  readonly elapsedMs: number;
  readonly reservedCostUnits: number;
  /** Null when provider-side accounting was not returned or could not be validated. */
  readonly reportedCostUnits: number | null;
}

export interface ProviderGenerationResult {
  readonly output: unknown;
  readonly providerId: string;
  readonly modelId: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly reservedCostUnits: number;
  readonly reportedCostUnits: number;
  readonly costAccountingComplete: boolean;
  readonly costUnit: string;
}

export interface ProviderCircuitPermit {
  /** Idempotent completion; a half-open probe without success reopens for a full cooldown. */
  complete(outcome: 'success' | 'neutral' | ProviderFailureCode): void;
}

export interface ProviderCircuitController {
  /** Returns null while open or when all half-open probe slots are occupied. */
  acquire(providerId: string): ProviderCircuitPermit | null;
}

export interface ProviderCircuitPolicy {
  /** Circuit state is bounded to this explicit provider set; dynamic IDs are rejected. */
  readonly providerIds: readonly string[];
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenProbeLimit: number;
  readonly countedFailures: readonly ProviderFailureCode[];
}

export interface ProviderGenerationDependencies {
  readonly circuitBreaker: ProviderCircuitController;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Receives bounded metadata only. Callback failure never changes generation behavior. */
  readonly onAttempt?: (event: ProviderAttemptEvent) => void;
  /** Must validate schema, language, provenance, grounding and safety before accepting a candidate. */
  readonly validateOutput: (output: unknown, request: StructuredGenerationRequest) => boolean;
}

export class ProviderAdapterError extends Error {
  readonly code: ProviderFailureCode;
  constructor(code: ProviderFailureCode) {
    super(code);
    this.name = 'ProviderAdapterError';
    this.code = code;
  }
}

/** Safe, provider-neutral failure; never contains upstream messages, bodies, prompts or credentials. */
export class ProviderGenerationError extends Error {
  readonly code: ProviderFailureCode;
  readonly attempts: number;
  readonly reservedCostUnits: number;
  readonly reportedCostUnits: number;
  readonly costAccountingComplete: boolean;
  readonly costUnit: string;

  constructor(
    code: ProviderFailureCode,
    attempts: number,
    reservedCostUnits: number,
    reportedCostUnits: number,
    costAccountingComplete: boolean,
    costUnit: string,
  ) {
    super(`generation failed (${code})`);
    this.name = 'ProviderGenerationError';
    this.code = code;
    this.attempts = attempts;
    this.reservedCostUnits = reservedCostUnits;
    this.reportedCostUnits = reportedCostUnits;
    this.costAccountingComplete = costAccountingComplete;
    this.costUnit = costUnit;
  }
}

const fail = (message: string): never => { throw new Error(message); };

function assertPlainDataObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} must not contain symbol properties`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} must contain only enumerable data properties`);
    if (!key.trim()) fail(`${label} property names must be non-empty`);
  }
}

function serializeBoundedJson(value: unknown, label: string, maxDepth = 40): string {
  const active = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > maxDepth) fail(`${label} exceeds the nesting bound`);
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(`${label} must contain finite JSON numbers`);
      return;
    }
    if (typeof current !== 'object' || current === null) fail(`${label} must contain only JSON-compatible values`);
    const objectValue = current as object;
    if (active.has(objectValue)) fail(`${label} must not contain cycles`);
    active.add(objectValue);
    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length > 0 || Object.keys(current).length !== current.length) {
        fail(`${label} arrays must be dense and contain no extra properties`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} arrays must contain data elements`);
        visit(descriptor.value, depth + 1);
      }
    } else {
      assertPlainDataObject(current, label);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) visit(descriptor.value, depth + 1);
    }
    active.delete(objectValue);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail(`${label} must be JSON serializable`);
  return serialized;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function immutableRequest(request: StructuredGenerationRequest, maxInputBytes: number): StructuredGenerationRequest {
  assertPlainDataObject(request, 'generation request');
  const allowed = new Set(['operationKind', 'correlationId', 'outputLanguage', 'schemaVersion', 'trustedInstruction', 'input', 'outputSchema']);
  if (Object.keys(request).some((key) => !allowed.has(key)) || Object.keys(request).length !== allowed.size) {
    fail('generation request must contain exactly the supported fields');
  }
  if (!['summary', 'pros_cons', 'deep_dive'].includes(request.operationKind)) fail('operationKind is unsupported');
  if (typeof request.correlationId !== 'string' || request.correlationId.trim().length === 0) fail('correlationId must be non-empty');
  if (typeof request.outputLanguage !== 'string' || request.outputLanguage.trim().length === 0) fail('outputLanguage must be non-empty');
  if (!Number.isSafeInteger(request.schemaVersion) || request.schemaVersion <= 0) fail('schemaVersion must be a positive safe integer');
  if (typeof request.trustedInstruction !== 'string' || request.trustedInstruction.trim().length === 0) {
    fail('trustedInstruction must be a non-empty server-owned string');
  }
  assertPlainDataObject(request.input, 'generation input');
  assertPlainDataObject(request.outputSchema, 'output schema');
  const serialized = serializeBoundedJson(request, 'generation request');
  if (Buffer.byteLength(serialized, 'utf8') > maxInputBytes) fail(`generation request exceeds configured ${maxInputBytes}-byte bound`);
  return deepFreeze(JSON.parse(serialized) as StructuredGenerationRequest);
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).length !== value.length) {
    fail(`${label} must be a dense array without extra or symbol properties`);
  }
  const arrayValue = value as unknown[];
  const descriptors = Object.getOwnPropertyDescriptors(arrayValue);
  for (let index = 0; index < arrayValue.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label} must contain only data elements`);
  }
}

function validatePolicy(policy: ProviderPolicy): void {
  assertPlainDataObject(policy, 'provider policy');
  const allowedPolicyKeys = [
    'routes', 'maxTotalAttempts', 'maxElapsedMs', 'totalCostLimitUnits', 'costUnit',
    'retryBackoffMs', 'retryableFailures', 'failoverFailures', 'failoverOnInvalidOutput',
  ];
  if (Object.keys(policy).length !== allowedPolicyKeys.length || Object.keys(policy).some((key) => !allowedPolicyKeys.includes(key))) {
    fail('provider policy must contain exactly the supported fields');
  }
  assertDenseArray(policy?.routes, 'provider routes');
  if (policy.routes.length === 0) fail('provider routes must be explicitly configured');
  if (!Number.isSafeInteger(policy.maxTotalAttempts) || policy.maxTotalAttempts <= 0) fail('maxTotalAttempts must be a positive safe integer');
  if (!Number.isSafeInteger(policy.maxElapsedMs) || policy.maxElapsedMs <= 0) fail('maxElapsedMs must be a positive safe integer');
  if (!Number.isSafeInteger(policy.totalCostLimitUnits) || policy.totalCostLimitUnits <= 0) fail('totalCostLimitUnits must be a positive safe integer');
  if (typeof policy.costUnit !== 'string' || policy.costUnit.trim().length === 0) fail('costUnit must be explicitly configured');
  if (!Number.isSafeInteger(policy.retryBackoffMs) || policy.retryBackoffMs < 0) fail('retryBackoffMs must be an explicit non-negative safe integer');
  assertDenseArray(policy.retryableFailures, 'retryableFailures');
  if (policy.retryableFailures.some((code) => !RETRYABLE_FAILURES.has(code))) {
    fail('retryableFailures may contain only timeout, overload, rate-limit, or transient failures');
  }
  assertDenseArray(policy.failoverFailures, 'failoverFailures');
  if (policy.failoverFailures.some((code) => !RETRYABLE_FAILURES.has(code) && code !== 'circuit_open')) {
    fail('failoverFailures may contain only timeout, overload, rate-limit, transient, or circuit-open failures');
  }
  if (typeof policy.failoverOnInvalidOutput !== 'boolean') fail('failoverOnInvalidOutput must be explicitly configured');
  const routeIds = new Set<string>();
  for (const route of policy.routes) {
    assertPlainDataObject(route, 'provider route');
    const routeKeys = ['providerId', 'modelId', 'attemptLimit', 'timeoutMs', 'maxCostUnits'];
    if (Object.keys(route).length !== routeKeys.length || Object.keys(route).some((key) => !routeKeys.includes(key))) {
      fail('provider route must contain exactly the supported fields');
    }
    if (typeof route.providerId !== 'string' || route.providerId.trim().length === 0 || routeIds.has(route.providerId)) {
      fail('provider route IDs must be non-empty and unique');
    }
    if (typeof route.modelId !== 'string' || route.modelId.trim().length === 0) fail('route modelId must be explicitly configured');
    routeIds.add(route.providerId);
    if (!Number.isSafeInteger(route.attemptLimit) || route.attemptLimit <= 0) fail('route attemptLimit must be a positive safe integer');
    if (!Number.isSafeInteger(route.timeoutMs) || route.timeoutMs <= 0 || route.timeoutMs > policy.maxElapsedMs) {
      fail('route timeoutMs must be positive and within the total elapsed-time bound');
    }
    if (!Number.isSafeInteger(route.maxCostUnits) || route.maxCostUnits <= 0 || route.maxCostUnits > policy.totalCostLimitUnits) {
      fail('route maxCostUnits must be positive and within the total cost bound');
    }
  }
  if (policy.routes.reduce((sum, route) => sum + route.attemptLimit, 0) < policy.maxTotalAttempts) {
    fail('maxTotalAttempts exceeds the configured route attempt capacity');
  }
}

export class InMemoryProviderCircuitBreaker implements ProviderCircuitController {
  private readonly providers: Map<string, { failureCount: number; openUntilMs: number | null; halfOpenInFlight: number }>;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenProbeLimit: number;
  private readonly countedFailures: ReadonlySet<ProviderFailureCode>;
  private readonly readClock: () => number;
  private lastClockValue = 0;

  constructor(policy: ProviderCircuitPolicy, dependencies: { readonly now?: () => number } = {}) {
    assertPlainDataObject(dependencies, 'provider circuit dependencies');
    if (Object.keys(dependencies).some((key) => key !== 'now')
        || (dependencies.now !== undefined && typeof dependencies.now !== 'function')) {
      fail('provider circuit dependencies may contain only a monotonic now function');
    }
    assertPlainDataObject(policy, 'provider circuit policy');
    const allowedKeys = ['providerIds', 'failureThreshold', 'cooldownMs', 'halfOpenProbeLimit', 'countedFailures'];
    if (Object.keys(policy).length !== allowedKeys.length || Object.keys(policy).some((key) => !allowedKeys.includes(key))) {
      fail('provider circuit policy must contain exactly the supported fields');
    }
    assertDenseArray(policy.providerIds, 'provider circuit providerIds');
    assertDenseArray(policy.countedFailures, 'provider circuit countedFailures');
    if (policy.providerIds.length === 0 || policy.providerIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
        || new Set(policy.providerIds).size !== policy.providerIds.length) {
      fail('provider circuit providerIds must be a non-empty set of unique configured IDs');
    }
    if (!Number.isSafeInteger(policy.failureThreshold) || policy.failureThreshold <= 0
        || !Number.isSafeInteger(policy.cooldownMs) || policy.cooldownMs <= 0
        || !Number.isSafeInteger(policy.halfOpenProbeLimit) || policy.halfOpenProbeLimit <= 0) {
      fail('provider circuit threshold, cooldown and half-open probe limit must be explicitly configured positive safe integers');
    }
    if (policy.countedFailures.length === 0 || policy.countedFailures.some((code) => !RETRYABLE_FAILURES.has(code))) {
      fail('provider circuit countedFailures must explicitly contain retryable provider health failures only');
    }
    this.providers = new Map(policy.providerIds.map((providerId) => [providerId, {
      failureCount: 0, openUntilMs: null, halfOpenInFlight: 0,
    }]));
    this.failureThreshold = policy.failureThreshold;
    this.cooldownMs = policy.cooldownMs;
    this.halfOpenProbeLimit = policy.halfOpenProbeLimit;
    this.countedFailures = new Set<ProviderFailureCode>(policy.countedFailures as readonly ProviderFailureCode[]);
    this.readClock = dependencies.now ?? (() => performance.now());
  }

  private now(): number {
    const value = this.readClock();
    if (!Number.isFinite(value)) throw new Error('provider circuit clock must return a finite monotonic time');
    this.lastClockValue = Math.max(this.lastClockValue, value);
    return this.lastClockValue;
  }

  getState(providerId: string): 'closed' | 'open' | 'half_open' {
    const state = this.providers.get(providerId);
    if (!state) fail('provider ID is not registered with the circuit breaker');
    if (state.openUntilMs === null) return 'closed';
    return this.now() < state.openUntilMs ? 'open' : 'half_open';
  }

  acquire(providerId: string): ProviderCircuitPermit | null {
    const state = this.providers.get(providerId);
    if (!state) fail('provider ID is not registered with the circuit breaker');
    const now = this.now();
    const probe = state.openUntilMs !== null;
    if (probe && now < state.openUntilMs!) return null;
    if (probe && state.halfOpenInFlight >= this.halfOpenProbeLimit) return null;
    if (probe) state.halfOpenInFlight += 1;
    let completed = false;
    return Object.freeze({
      complete: (outcome: 'success' | 'neutral' | ProviderFailureCode) => {
        if (completed) return;
        completed = true;
        const completedAt = this.now();
        if (probe) {
          state.halfOpenInFlight = Math.max(0, state.halfOpenInFlight - 1);
          if (outcome === 'success') {
            state.failureCount = 0;
            state.openUntilMs = null;
          } else {
            // A half-open request that errors or returns unusable health data cannot close the circuit.
            state.failureCount = Math.max(this.failureThreshold, state.failureCount);
            state.openUntilMs = Math.min(Number.MAX_VALUE, completedAt + this.cooldownMs);
          }
          return;
        }
        if (outcome === 'success') {
          // An older in-flight closed-state request must not erase an opening triggered
          // by a concurrent request that completed after this permit was acquired.
          if (state.openUntilMs === null) state.failureCount = 0;
          return;
        }
        if (outcome !== 'neutral' && this.countedFailures.has(outcome)) {
          state.failureCount += 1;
          if (state.failureCount >= this.failureThreshold) {
            state.openUntilMs = Math.min(Number.MAX_VALUE, completedAt + this.cooldownMs);
          }
        }
      },
    });
  }
}

function snapshotProviderPolicy(input: ProviderPolicy): ProviderPolicy {
  validatePolicy(input);
  return Object.freeze({
    routes: Object.freeze(input.routes.map((route) => Object.freeze({
      providerId: route.providerId,
      modelId: route.modelId,
      attemptLimit: route.attemptLimit,
      timeoutMs: route.timeoutMs,
      maxCostUnits: route.maxCostUnits,
    }))),
    maxTotalAttempts: input.maxTotalAttempts,
    maxElapsedMs: input.maxElapsedMs,
    totalCostLimitUnits: input.totalCostLimitUnits,
    costUnit: input.costUnit,
    retryBackoffMs: input.retryBackoffMs,
    retryableFailures: Object.freeze([...input.retryableFailures]),
    failoverFailures: Object.freeze([...input.failoverFailures]),
    failoverOnInvalidOutput: input.failoverOnInvalidOutput,
  });
}

function snapshotProviderAdapter(input: ProviderAdapter): ProviderAdapter {
  assertPlainDataObject(input, 'provider adapter');
  const adapterKeys = ['providerId', 'modelId', 'capabilities', 'estimateMaxCostUnits', 'generate'];
  if (Object.keys(input).length !== adapterKeys.length || Object.keys(input).some((key) => !adapterKeys.includes(key))) {
    fail('provider adapter must contain exactly the supported fields');
  }
  assertPlainDataObject(input.capabilities, 'provider capabilities');
  const capabilityKeys = ['structuredOutput', 'hardCostLimit', 'maxTimeoutMs', 'maxInputBytes', 'maxOutputBytes', 'costUnit'];
  if (Object.keys(input.capabilities).length !== capabilityKeys.length
      || Object.keys(input.capabilities).some((key) => !capabilityKeys.includes(key))) {
    fail('provider adapter capabilities must contain exactly the supported fields');
  }
  if (typeof input.estimateMaxCostUnits !== 'function' || typeof input.generate !== 'function') {
    fail('provider adapter methods must be functions');
  }
  const estimate = input.estimateMaxCostUnits.bind(input);
  const generate = input.generate.bind(input);
  return Object.freeze({
    providerId: input.providerId,
    modelId: input.modelId,
    capabilities: Object.freeze({ ...input.capabilities }),
    estimateMaxCostUnits: (request) => estimate(request),
    generate: (request, options) => generate(request, options),
  });
}

function validateAdapter(
  adapter: ProviderAdapter,
  route: ProviderRoute,
  policy: ProviderPolicy,
  request: StructuredGenerationRequest,
  attempts: number,
  reservedCostUnits: number,
  reportedCostUnits: number,
  costAccountingComplete: boolean,
): void {
  if (!adapter || adapter.providerId !== route.providerId || adapter.modelId !== route.modelId) fail('provider adapter does not match its configured route');
  const capabilities = adapter.capabilities;
  assertPlainDataObject(capabilities, 'provider capabilities');
  const capabilityKeys = ['structuredOutput', 'hardCostLimit', 'maxTimeoutMs', 'maxInputBytes', 'maxOutputBytes', 'costUnit'];
  if (Object.keys(capabilities).length !== capabilityKeys.length || Object.keys(capabilities).some((key) => !capabilityKeys.includes(key))) {
    throw new ProviderGenerationError('unsupported_capability', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
  }
  if (capabilities.structuredOutput !== true || capabilities.hardCostLimit !== true) {
    throw new ProviderGenerationError('unsupported_capability', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
  }
  if (!Number.isSafeInteger(capabilities.maxTimeoutMs) || capabilities.maxTimeoutMs < route.timeoutMs
      || !Number.isSafeInteger(capabilities.maxInputBytes) || capabilities.maxInputBytes <= 0
      || !Number.isSafeInteger(capabilities.maxOutputBytes) || capabilities.maxOutputBytes <= 0
      || capabilities.costUnit !== policy.costUnit) {
    throw new ProviderGenerationError('unsupported_capability', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
  }
  if (Buffer.byteLength(serializeBoundedJson(request, 'generation request'), 'utf8') > capabilities.maxInputBytes) {
    throw new ProviderGenerationError('unsupported_capability', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function completeWithTimeout(
  adapter: ProviderAdapter,
  request: StructuredGenerationRequest,
  timeoutMs: number,
  costUnit: string,
  maxCostUnits: number,
): Promise<ProviderCompletion> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(() => adapter.generate(request, {
    modelId: adapter.modelId, timeoutMs, costUnit, maxCostUnits, signal: controller.signal,
  }));
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderAdapterError('timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizedFailure(error: unknown): ProviderFailureCode {
  try {
    if (error instanceof ProviderAdapterError && FAILURE_CODES.includes(error.code)) return error.code;
  } catch { /* hostile or malformed exception objects normalize to unknown */ }
  return 'unknown';
}

function readProviderCompletion(value: unknown): { readonly output: unknown; readonly actualCostUnits: number } | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0
        || Object.keys(descriptors).length !== 2
        || !Object.hasOwn(descriptors, 'output') || !Object.hasOwn(descriptors, 'actualCostUnits')
        || !descriptors.output.enumerable || !Object.hasOwn(descriptors.output, 'value')
        || !descriptors.actualCostUnits.enumerable || !Object.hasOwn(descriptors.actualCostUnits, 'value')) return null;
    const actualCostUnits = descriptors.actualCostUnits.value;
    if (!Number.isSafeInteger(actualCostUnits) || actualCostUnits <= 0) return null;
    return { output: descriptors.output.value, actualCostUnits };
  } catch { return null; }
}

function emit(dependencies: ProviderGenerationDependencies, event: ProviderAttemptEvent): void {
  try {
    const result = dependencies.onAttempt?.(Object.freeze(event)) as unknown;
    if (result !== null && typeof result === 'object' && 'then' in result) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch { /* observability must not alter generation */ }
}

/**
 * Provider-neutral, explicit-budget execution boundary. It does not select a provider, write an
 * artifact, log request content, or relax the caller's schema/evidence/safety validation.
 */
export async function runProviderGeneration(
  rawRequest: StructuredGenerationRequest,
  adapters: readonly ProviderAdapter[],
  policy: ProviderPolicy,
  dependencies: ProviderGenerationDependencies,
): Promise<ProviderGenerationResult> {
  policy = snapshotProviderPolicy(policy);
  if (typeof dependencies?.validateOutput !== 'function') fail('validateOutput is required');
  if (!dependencies.circuitBreaker || typeof dependencies.circuitBreaker.acquire !== 'function') {
    fail('a provider circuit-breaker controller is required');
  }
  assertDenseArray(adapters, 'provider adapters');
  const adapterSnapshots = adapters.map(snapshotProviderAdapter);
  const adapterById = new Map<string, ProviderAdapter>();
  for (const adapter of adapterSnapshots) {
    if (adapterById.has(adapter.providerId)) fail('provider adapter IDs must be unique');
    adapterById.set(adapter.providerId, adapter);
  }
  const configuredAdapters = policy.routes.map((route) => {
    const adapter = adapterById.get(route.providerId);
    if (!adapter) throw new ProviderGenerationError('unsupported_capability', 0, 0, 0, true, policy.costUnit);
    return { adapter, route };
  });
  const maxInputBytes = Math.min(...configuredAdapters.map(({ adapter }) => adapter.capabilities.maxInputBytes));
  const request = immutableRequest(rawRequest, maxInputBytes);
  if (dependencies.now !== undefined && typeof dependencies.now !== 'function') fail('monotonic clock must be a function');
  if (dependencies.sleep !== undefined && typeof dependencies.sleep !== 'function') fail('retry sleep must be a function');
  let attempts = 0;
  let reservedCostUnits = 0;
  let reportedCostUnits = 0;
  let costAccountingComplete = true;
  let finalFailure: ProviderFailureCode = 'unknown';
  let hardCostViolation = false;
  const readClock = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? defaultSleep;
  let lastClockValue: number | null = null;
  const now = (): number => {
    let value: number;
    try { value = readClock(); }
    catch {
      throw new ProviderGenerationError('unknown', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    if (!Number.isFinite(value) || (lastClockValue !== null && value < lastClockValue)) {
      throw new ProviderGenerationError('unknown', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    lastClockValue = value;
    return value;
  };
  const startedAt = now();

  for (const { adapter, route } of configuredAdapters) {
    validateAdapter(adapter, route, policy, request, attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete);
    let routeAttempts = 0;
    while (routeAttempts < route.attemptLimit && attempts < policy.maxTotalAttempts) {
      const elapsed = Math.max(0, now() - startedAt);
      const remainingMs = policy.maxElapsedMs - elapsed;
      if (remainingMs <= 0) {
        finalFailure = 'timeout';
        break;
      }
      let estimate: number;
      try {
        estimate = adapter.estimateMaxCostUnits(request);
      } catch {
        throw new ProviderGenerationError('unknown', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
      }
      if (!Number.isSafeInteger(estimate) || estimate <= 0) {
        throw new ProviderGenerationError('unsupported_capability', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
      }
      if (estimate > route.maxCostUnits || reservedCostUnits + estimate > policy.totalCostLimitUnits) {
        finalFailure = 'cost_limit';
        break;
      }
      // Estimation and circuit admission can consume time too. Re-check the global deadline
      // immediately before reserving cost or acquiring a half-open permit.
      const attemptStartedAt = now();
      const dispatchRemainingMs = policy.maxElapsedMs - Math.max(0, attemptStartedAt - startedAt);
      if (dispatchRemainingMs <= 0) {
        finalFailure = 'timeout';
        break;
      }
      let circuitPermit: ProviderCircuitPermit | null;
      try {
        circuitPermit = dependencies.circuitBreaker.acquire(route.providerId);
      } catch {
        throw new ProviderGenerationError('unknown', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
      }
      if (!circuitPermit) {
        finalFailure = 'circuit_open';
        emit(dependencies, {
          providerId: route.providerId, modelId: route.modelId, attempt: attempts + 1,
          failureCode: 'circuit_open', elapsedMs: 0, reservedCostUnits: 0, reportedCostUnits: 0,
        });
        break;
      }
      const timeoutMs = Math.min(route.timeoutMs, dispatchRemainingMs);
      reservedCostUnits += estimate;
      attempts += 1;
      routeAttempts += 1;
      let candidate: ProviderCompletion;
      try {
        candidate = await completeWithTimeout(adapter, request, timeoutMs, policy.costUnit, estimate);
      } catch (error) {
        const code = normalizedFailure(error);
        circuitPermit.complete(code);
        finalFailure = code;
        costAccountingComplete = false;
        const attemptElapsed = Math.max(0, now() - attemptStartedAt);
        emit(dependencies, {
          providerId: route.providerId, modelId: route.modelId, attempt: attempts, failureCode: code,
          elapsedMs: attemptElapsed, reservedCostUnits: estimate, reportedCostUnits: null,
        });
        if (!policy.retryableFailures.includes(code) || !RETRYABLE_FAILURES.has(code)) break;
        if (routeAttempts >= route.attemptLimit || attempts >= policy.maxTotalAttempts) break;
        if (policy.retryBackoffMs > 0) {
          if (policy.retryBackoffMs >= policy.maxElapsedMs - Math.max(0, now() - startedAt)) {
            finalFailure = 'timeout';
            break;
          }
          await sleep(policy.retryBackoffMs);
        }
        continue;
      }

      let attemptElapsed: number;
      try { attemptElapsed = Math.max(0, now() - attemptStartedAt); }
      catch (error) {
        circuitPermit.complete('neutral');
        throw error;
      }
      const completion = readProviderCompletion(candidate);
      if (!completion) {
        circuitPermit.complete('neutral');
        finalFailure = 'unknown';
        costAccountingComplete = false;
        emit(dependencies, {
          providerId: route.providerId, modelId: route.modelId, attempt: attempts, failureCode: finalFailure,
          elapsedMs: attemptElapsed, reservedCostUnits: estimate, reportedCostUnits: null,
        });
        break;
      }
      const { actualCostUnits, output: rawOutput } = completion;
      if (actualCostUnits > estimate) {
        circuitPermit.complete('neutral');
        hardCostViolation = true;
        costAccountingComplete = false;
        finalFailure = 'cost_limit';
        if (Number.isSafeInteger(reportedCostUnits + actualCostUnits)) reportedCostUnits += actualCostUnits;
        emit(dependencies, {
          providerId: route.providerId, modelId: route.modelId, attempt: attempts, failureCode: finalFailure,
          elapsedMs: attemptElapsed, reservedCostUnits: estimate, reportedCostUnits: actualCostUnits,
        });
        break;
      }
      reportedCostUnits += actualCostUnits;
      let outputJson: string;
      try {
        outputJson = serializeBoundedJson(rawOutput, 'provider output');
      } catch {
        circuitPermit.complete('invalid_output');
        finalFailure = 'invalid_output';
        emit(dependencies, {
          providerId: route.providerId, modelId: route.modelId, attempt: attempts, failureCode: finalFailure,
          elapsedMs: attemptElapsed, reservedCostUnits: estimate, reportedCostUnits: actualCostUnits,
        });
        if (!policy.failoverOnInvalidOutput) break;
        break;
      }
      if (Buffer.byteLength(outputJson, 'utf8') > adapter.capabilities.maxOutputBytes) {
        circuitPermit.complete('invalid_output');
        finalFailure = 'invalid_output';
        emit(dependencies, {
          providerId: route.providerId, modelId: route.modelId, attempt: attempts, failureCode: finalFailure,
          elapsedMs: attemptElapsed, reservedCostUnits: estimate, reportedCostUnits: actualCostUnits,
        });
        if (!policy.failoverOnInvalidOutput) break;
        break;
      }
      let output: unknown;
      try {
        output = JSON.parse(outputJson) as unknown;
        if (!dependencies.validateOutput(output, request)) {
          circuitPermit.complete('invalid_output');
          finalFailure = 'invalid_output';
          emit(dependencies, {
            providerId: route.providerId, modelId: route.modelId, attempt: attempts, failureCode: finalFailure,
            elapsedMs: attemptElapsed, reservedCostUnits: estimate, reportedCostUnits: actualCostUnits,
          });
          break;
        }
      } catch {
        circuitPermit.complete('neutral');
        throw new ProviderGenerationError('unknown', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
      }
      let totalElapsedMs: number;
      try { totalElapsedMs = Math.max(0, now() - startedAt); }
      catch (error) {
        circuitPermit.complete('neutral');
        throw error;
      }
      circuitPermit.complete('success');
      emit(dependencies, {
        providerId: route.providerId, modelId: route.modelId, attempt: attempts, failureCode: null,
        elapsedMs: attemptElapsed, reservedCostUnits: estimate, reportedCostUnits: actualCostUnits,
      });
      return Object.freeze({
        output: deepFreeze(output),
        providerId: route.providerId,
        modelId: route.modelId,
        attempts,
        elapsedMs: totalElapsedMs,
        reservedCostUnits,
        reportedCostUnits,
        costAccountingComplete,
        costUnit: policy.costUnit,
      });
    }
    if (hardCostViolation) {
      throw new ProviderGenerationError('cost_limit', attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    if (finalFailure === 'circuit_open') {
      if (policy.failoverFailures.includes('circuit_open')) continue;
      throw new ProviderGenerationError(finalFailure, attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    if (finalFailure === 'timeout' && policy.maxElapsedMs - Math.max(0, now() - startedAt) <= 0) break;
    if (finalFailure === 'unknown') {
      throw new ProviderGenerationError(finalFailure, attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    if (RETRYABLE_FAILURES.has(finalFailure) && !policy.failoverFailures.includes(finalFailure)) {
      throw new ProviderGenerationError(finalFailure, attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    if (!RETRYABLE_FAILURES.has(finalFailure) && finalFailure !== 'invalid_output' && finalFailure !== 'cost_limit') {
      throw new ProviderGenerationError(finalFailure, attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    if (finalFailure === 'invalid_output' && !policy.failoverOnInvalidOutput) {
      throw new ProviderGenerationError(finalFailure, attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
    }
    if (finalFailure === 'cost_limit') {
      // The next explicitly configured provider may have a lower maximum estimate.
      continue;
    }
  }
  throw new ProviderGenerationError(finalFailure, attempts, reservedCostUnits, reportedCostUnits, costAccountingComplete, policy.costUnit);
}
