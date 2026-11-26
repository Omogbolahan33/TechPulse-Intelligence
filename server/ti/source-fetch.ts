import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Worker } from 'node:worker_threads';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import {
  ContractValidationError,
  validateCanonicalPostInput,
  type CanonicalPostInputV1,
  type ContractLimits,
  type LinkedSourceV1,
  type StableId,
} from './contracts';

export interface SourceFetchLimits {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly maxUrlLength: number;
  readonly maxAttributionCodePoints: number;
  readonly maxDnsAnswers: number;
  readonly maxHeaderBytes: number;
  readonly maxResponseBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxExtractedTextCodePoints: number;
  readonly minUsableTextCodePoints: number;
  readonly maxHtmlNodes: number;
  readonly maxEvidenceBlocks: number;
  readonly maxWorkerOldGenerationMb: number;
  readonly maxWorkerYoungGenerationMb: number;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface RawSourceResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface PinnedSourceTransport {
  request(url: URL, address: ResolvedAddress, timeoutMs: number, maxResponseBytes: number, maxHeaderBytes: number): Promise<RawSourceResponse>;
}

export type SourceFailureCode =
  | 'source_not_linked'
  | 'invalid_canonical_post'
  | 'ineligible_post'
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'network_error'
  | 'unsupported_port'
  | 'credentials_not_allowed'
  | 'blocked_address'
  | 'dns_failed'
  | 'timeout'
  | 'redirect_rejected'
  | 'too_many_redirects'
  | 'http_status'
  | 'response_too_large'
  | 'response_headers_too_large'
  | 'unsupported_content_type'
  | 'unsupported_content_encoding'
  | 'decompression_failed'
  | 'unsupported_charset'
  | 'extraction_failed';

export interface SourceFailure {
  readonly retrievalStatus: 'failed';
  readonly extractionStatus: 'not_attempted';
  readonly groundingStatus: 'not_assessed';
  readonly failureCode: SourceFailureCode;
  readonly retrievedAt: string;
}

export interface UnusableRetrievedSource {
  readonly retrievalStatus: 'retrieved';
  readonly extractionStatus: 'unusable';
  readonly groundingStatus: 'not_assessed';
  readonly originalUrl: string;
  readonly sourceAttribution: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly sourceVersion: string;
  readonly contentHash: string;
  readonly contentType: string;
  readonly title: '';
  readonly text: '';
  readonly evidenceBlocks: readonly [];
  readonly truncated: false;
  readonly extractionLimits: Pick<SourceFetchLimits, 'maxDecompressedBytes' | 'maxExtractedTextCodePoints' | 'maxEvidenceBlocks' | 'maxHtmlNodes' | 'maxWorkerOldGenerationMb' | 'maxWorkerYoungGenerationMb'>;
  readonly failureCode: SourceFailureCode;
  readonly limitation?: 'insufficient_extractable_text';
}

export interface EvidenceBlock {
  readonly evidenceId: string;
  readonly text: string;
}

export interface RetrievedSource {
  readonly retrievalStatus: 'retrieved';
  readonly extractionStatus: 'usable' | 'unusable';
  /** Retrieval/extraction does not assess freshness against prior snapshots or establish grounding. */
  readonly groundingStatus: 'not_assessed';
  readonly originalUrl: string;
  readonly sourceAttribution: string;
  readonly finalUrl: string;
  readonly retrievedAt: string;
  readonly sourceVersion: string;
  readonly contentHash: string;
  readonly contentType: 'text/html' | 'application/xhtml+xml' | 'text/plain';
  readonly title: string;
  readonly text: string;
  readonly evidenceBlocks: readonly EvidenceBlock[];
  readonly truncated: boolean;
  readonly extractionLimits: Pick<SourceFetchLimits, 'maxDecompressedBytes' | 'maxExtractedTextCodePoints' | 'maxEvidenceBlocks' | 'maxHtmlNodes' | 'maxWorkerOldGenerationMb' | 'maxWorkerYoungGenerationMb'>;
  readonly limitation?: 'insufficient_extractable_text';
  readonly failureCode?: SourceFailureCode;
}

export type SourceFetchResult = SourceFailure | UnusableRetrievedSource | RetrievedSource;

export interface SourceFetchDependencies {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly transport?: PinnedSourceTransport;
  readonly extract?: (contentType: RetrievedSource['contentType'], text: string, limits: SourceFetchLimits, timeoutMs: number) => Promise<ExtractedBlocks>;
  readonly now?: () => Date;
}

export interface SourceEligibilityPolicy {
  readonly contractLimits: ContractLimits;
  readonly supportedLanguages: readonly string[];
  readonly eligibleModerationStates: readonly string[];
  readonly eligiblePublicationStates: readonly string[];
}

export interface CanonicalPostSourceReference {
  readonly postId: string;
  readonly version: { readonly kind: 'postContentVersion' | 'contentHash'; readonly value: StableId };
}

export type CanonicalPostSourceFetchResult =
  | { readonly postStatus: 'invalid'; readonly result: SourceFailure }
  | { readonly postStatus: 'ineligible'; readonly canonicalPost: CanonicalPostSourceReference; readonly result: SourceFailure }
  | { readonly postStatus: 'eligible'; readonly canonicalPost: CanonicalPostSourceReference; readonly result: SourceFetchResult };

class FetchFault extends Error {
  constructor(readonly failureCode: SourceFailureCode) { super(failureCode); }
}

function validateLimits(limits: SourceFetchLimits): void {
  const numericKeys: readonly (keyof SourceFetchLimits)[] = [
    'timeoutMs', 'maxRedirects', 'maxUrlLength', 'maxAttributionCodePoints', 'maxDnsAnswers', 'maxHeaderBytes', 'maxResponseBytes', 'maxDecompressedBytes',
    'maxExtractedTextCodePoints', 'minUsableTextCodePoints', 'maxHtmlNodes', 'maxEvidenceBlocks', 'maxWorkerOldGenerationMb', 'maxWorkerYoungGenerationMb',
  ];
  for (const key of numericKeys) {
    const value = limits?.[key];
    if (!Number.isSafeInteger(value) || value < (key === 'maxRedirects' ? 0 : 1)) {
      throw new Error(`limits.${key} must be an explicitly configured safe integer`);
    }
  }
  if (limits.timeoutMs > 2_147_483_647) throw new Error('timeoutMs exceeds the Node.js timer ceiling');
  if (limits.minUsableTextCodePoints > limits.maxExtractedTextCodePoints) {
    throw new Error('minUsableTextCodePoints cannot exceed maxExtractedTextCodePoints');
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function normalizeSourceUrl(input: string, maxUrlLength: number): URL {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input, 'utf8') > maxUrlLength) {
    throw new FetchFault('invalid_url');
  }
  let url: URL;
  try { url = new URL(input); } catch { throw new FetchFault('invalid_url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchFault('unsupported_scheme');
  if (url.username || url.password) throw new FetchFault('credentials_not_allowed');
  if (url.port) throw new FetchFault('unsupported_port');
  // WHATWG URL canonicalization lowercases the host and removes default ports.
  const normalizedHost = normalizeHostname(url.hostname);
  url.hostname = url.hostname.startsWith('[') ? `[${normalizedHost}]` : normalizedHost;
  url.hash = '';
  return url;
}

function readLinkedSource(value: LinkedSourceV1 | undefined, limits: SourceFetchLimits): LinkedSourceV1 {
  if (value === undefined) throw new FetchFault('source_not_linked');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FetchFault('invalid_url');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('url') || !keys.includes('attribution')) throw new FetchFault('invalid_url');
  if (typeof value.url !== 'string' || typeof value.attribution !== 'string' || value.attribution.trim().length === 0) {
    throw new FetchFault('invalid_url');
  }
  if (Array.from(value.attribution).length > limits.maxAttributionCodePoints) throw new FetchFault('invalid_url');
  return value;
}

export function isSafePublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}

async function defaultResolve(hostname: string): Promise<readonly ResolvedAddress[]> {
  if (ipaddr.isValid(hostname)) {
    const parsed = ipaddr.parse(hostname);
    return [{ address: parsed.toString(), family: parsed.kind() === 'ipv4' ? 4 : 6 }];
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

export const makePinnedLookup = (expectedHostname: string, pinned: ResolvedAddress): LookupFunction => (hostname, options, callback) => {
  if (normalizeHostname(hostname) !== expectedHostname) {
    const error = Object.assign(new Error('unexpected lookup hostname'), { code: 'EAI_FAIL' });
    callback(error, '', 0);
    return;
  }
  if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
  else callback(null, pinned.address, pinned.family);
};

function readResponse(url: URL, address: ResolvedAddress, timeoutMs: number, maxResponseBytes: number, maxHeaderBytes: number): Promise<RawSourceResponse> {
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: 'GET',
      agent: false,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        'user-agent': 'TechPulse-SourceFetcher/1.0',
      },
      maxHeaderSize: maxHeaderBytes,
      lookup: makePinnedLookup(normalizeHostname(url.hostname), address),
    };
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, requestOptions);
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (error?: Error, response?: RawSourceResponse) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else if (response) resolve(response);
    };
    timer = setTimeout(() => request.destroy(Object.assign(new Error('source request timed out'), { code: 'TI_SOURCE_TIMEOUT' })), timeoutMs);
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'TI_SOURCE_TIMEOUT') finish(new FetchFault('timeout'));
      else if (error.code === 'HPE_HEADER_OVERFLOW' || error.code === 'ERR_HTTP_HEADERS_TOO_LARGE') {
        finish(new FetchFault('response_headers_too_large'));
      } else finish(error);
    });
    request.on('response', (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400) {
        const headers = response.headers;
        response.destroy();
        finish(undefined, { statusCode, headers, body: Buffer.alloc(0) });
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        response.destroy();
        finish(new FetchFault('response_too_large'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        if (done) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maxResponseBytes) {
          response.destroy();
          finish(new FetchFault('response_too_large'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => finish(undefined, { statusCode, headers: response.headers, body: Buffer.concat(chunks, bytes) }));
      response.on('error', (error) => finish(error));
    });
    request.end();
  });
}

export class PinnedNodeSourceTransport implements PinnedSourceTransport {
  request(url: URL, address: ResolvedAddress, timeoutMs: number, maxResponseBytes: number, maxHeaderBytes: number): Promise<RawSourceResponse> {
    return readResponse(url, address, timeoutMs, maxResponseBytes, maxHeaderBytes);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new FetchFault('timeout')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function resolvePublicAddress(addresses: readonly ResolvedAddress[], maxDnsAnswers: number): ResolvedAddress {
  if (addresses.length === 0 || addresses.length > maxDnsAnswers || addresses.some(({ address, family }) => {
    if (!isSafePublicAddress(address) || (family !== 4 && family !== 6)) return true;
    const parsed = ipaddr.parse(address);
    return (parsed.kind() === 'ipv4' ? 4 : 6) !== family;
  })) throw new FetchFault('blocked_address');
  return addresses[0];
}

function mediaType(headers: IncomingHttpHeaders): RetrievedSource['contentType'] {
  const header = headers['content-type'];
  if (Array.isArray(header) && header.length !== 1) throw new FetchFault('unsupported_content_type');
  const value = Array.isArray(header) ? header[0] : header;
  const type = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml' || type === 'text/plain') return type;
  throw new FetchFault('unsupported_content_type');
}

interface DecodedBody {
  text: string;
  contentHash: string;
}

function decodeBody(headers: IncomingHttpHeaders, body: Buffer, maxDecompressedBytes: number): DecodedBody {
  const encodingHeader = headers['content-encoding'];
  if (Array.isArray(encodingHeader) && encodingHeader.length !== 1) throw new FetchFault('unsupported_content_encoding');
  const encoding = (Array.isArray(encodingHeader) ? encodingHeader[0] : encodingHeader)?.trim().toLowerCase() ?? 'identity';
  let decoded: Buffer;
  try {
    if (encoding === 'identity' || encoding === '') decoded = body;
    else if (encoding === 'gzip') decoded = gunzipSync(body, { maxOutputLength: maxDecompressedBytes });
    else if (encoding === 'deflate') decoded = inflateSync(body, { maxOutputLength: maxDecompressedBytes });
    else if (encoding === 'br') decoded = brotliDecompressSync(body, { maxOutputLength: maxDecompressedBytes });
    else throw new FetchFault('unsupported_content_encoding');
  } catch (error) {
    if (error instanceof FetchFault) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new FetchFault('response_too_large');
    throw new FetchFault('decompression_failed');
  }
  if (decoded.byteLength > maxDecompressedBytes) throw new FetchFault('response_too_large');
  const contentTypeHeader = headers['content-type'];
  const contentTypeValue = (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader) ?? '';
  const charset = /charset\s*=\s*["']?([^;"']+)/i.exec(contentTypeValue)?.[1]?.trim() ?? 'utf-8';
  try {
    return {
      text: new TextDecoder(charset, { fatal: true }).decode(decoded),
      contentHash: createHash('sha256').update(decoded).digest('hex'),
    };
  } catch { throw new FetchFault('unsupported_charset'); }
}

export interface ExtractedBlocks {
  title: string;
  blocks: string[];
  truncated: boolean;
}

function textBlocks(
  contentType: RetrievedSource['contentType'],
  html: string,
  limits: SourceFetchLimits,
  timeoutMs: number,
): Promise<ExtractedBlocks> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./source-extract-worker.js', import.meta.url), {
        workerData: {
          html,
          contentType,
          maxHtmlNodes: limits.maxHtmlNodes,
          maxEvidenceBlocks: limits.maxEvidenceBlocks,
          maxTextCodePoints: limits.maxExtractedTextCodePoints,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: limits.maxWorkerOldGenerationMb,
          maxYoungGenerationSizeMb: limits.maxWorkerYoungGenerationMb,
        },
      });
    } catch {
      reject(new FetchFault('extraction_failed'));
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new FetchFault('timeout'));
    }, Math.max(1, timeoutMs));
    const finish = (error?: Error, data?: ExtractedBlocks) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else if (data) resolve(data);
      else reject(new FetchFault('extraction_failed'));
    };
    worker.once('message', (message: ExtractedBlocks | { error: string }) => {
      if ('error' in message) finish(new FetchFault('extraction_failed'));
      else finish(undefined, message);
    });
    worker.once('error', () => finish(new FetchFault('extraction_failed')));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(new FetchFault('extraction_failed'));
    });
  });
}

async function buildRetrievedSource(
  originalUrl: string,
  sourceAttribution: string,
  finalUrl: URL,
  response: RawSourceResponse,
  retrievedAt: Date,
  limits: SourceFetchLimits,
  extractionTimeoutMs: number,
  extract: NonNullable<SourceFetchDependencies['extract']>,
): Promise<RetrievedSource | UnusableRetrievedSource> {
  const normalizedOriginalUrl = normalizeSourceUrl(originalUrl, limits.maxUrlLength).toString();
  let resolvedContentType = 'unsupported';
  let contentHash = createHash('sha256').update(response.body).digest('hex');
  const unusable = (failureCode: SourceFailureCode): UnusableRetrievedSource => ({
    retrievalStatus: 'retrieved',
    extractionStatus: 'unusable',
    groundingStatus: 'not_assessed',
    originalUrl: normalizedOriginalUrl,
    sourceAttribution,
    finalUrl: finalUrl.toString(),
    retrievedAt: retrievedAt.toISOString(),
    sourceVersion: contentHash,
    contentHash,
    contentType: resolvedContentType,
    title: '',
    text: '',
    evidenceBlocks: [],
    truncated: false,
    extractionLimits: {
      maxDecompressedBytes: limits.maxDecompressedBytes,
      maxExtractedTextCodePoints: limits.maxExtractedTextCodePoints,
      maxEvidenceBlocks: limits.maxEvidenceBlocks,
      maxHtmlNodes: limits.maxHtmlNodes,
      maxWorkerOldGenerationMb: limits.maxWorkerOldGenerationMb,
      maxWorkerYoungGenerationMb: limits.maxWorkerYoungGenerationMb,
    },
    failureCode,
  });
  try {
    const contentType = mediaType(response.headers);
    resolvedContentType = contentType;
    const decoded = decodeBody(response.headers, response.body, limits.maxDecompressedBytes);
    contentHash = decoded.contentHash;
    const extracted = await withTimeout(
      extract(contentType, decoded.text, limits, extractionTimeoutMs),
      extractionTimeoutMs,
    );
    const titleCodePoints = Array.from(extracted.title);
    const title = titleCodePoints.slice(0, limits.maxExtractedTextCodePoints).join('');
    let remaining = limits.maxExtractedTextCodePoints - Array.from(title).length;
    let truncated = extracted.truncated || titleCodePoints.length > Array.from(title).length;
    const boundedBlocks: string[] = [];
    for (const block of extracted.blocks) {
      const chars = Array.from(block);
      if (chars.length === 0) continue;
      if (boundedBlocks.length > 0) {
        if (remaining < 2) { truncated = true; break; }
        remaining -= 2;
      }
      if (remaining <= 0) { truncated = true; break; }
      if (chars.length > remaining) {
        boundedBlocks.push(chars.slice(0, remaining).join(''));
        remaining = 0;
        truncated = true;
        break;
      }
      boundedBlocks.push(block);
      remaining -= chars.length;
    }
    const text = boundedBlocks.join('\n\n');
    const evidenceBlocks = boundedBlocks.map((block, index) => ({
      evidenceId: `src_${createHash('sha256').update(`${normalizedOriginalUrl}\0${contentHash}\0${index}\0${block}`).digest('hex').slice(0, 32)}`,
      text: block,
    }));
    return {
      retrievalStatus: 'retrieved',
      extractionStatus: Array.from(text).length >= limits.minUsableTextCodePoints ? 'usable' : 'unusable',
      groundingStatus: 'not_assessed',
      originalUrl: normalizedOriginalUrl,
      sourceAttribution,
      finalUrl: finalUrl.toString(),
      retrievedAt: retrievedAt.toISOString(),
      sourceVersion: contentHash,
      contentHash,
      contentType,
      title,
      text,
      evidenceBlocks,
      truncated,
      extractionLimits: {
        maxDecompressedBytes: limits.maxDecompressedBytes,
        maxExtractedTextCodePoints: limits.maxExtractedTextCodePoints,
        maxEvidenceBlocks: limits.maxEvidenceBlocks,
        maxHtmlNodes: limits.maxHtmlNodes,
        maxWorkerOldGenerationMb: limits.maxWorkerOldGenerationMb,
        maxWorkerYoungGenerationMb: limits.maxWorkerYoungGenerationMb,
      },
      ...(Array.from(text).length < limits.minUsableTextCodePoints ? { limitation: 'insufficient_extractable_text' as const } : {}),
    };
  } catch (error) {
    return unusable(error instanceof FetchFault ? error.failureCode : 'extraction_failed');
  }
}

async function fetchLinkedSource(
  linkedSource: LinkedSourceV1 | undefined,
  limits: SourceFetchLimits,
  dependencies: SourceFetchDependencies = {},
): Promise<SourceFetchResult> {
  validateLimits(limits);
  const now = dependencies.now ?? (() => new Date());
  const retrievedAt = now();
  const failure = (failureCode: SourceFailureCode): SourceFailure => ({
    retrievalStatus: 'failed',
    extractionStatus: 'not_attempted',
    groundingStatus: 'not_assessed',
    failureCode,
    retrievedAt: retrievedAt.toISOString(),
  });
  let linked: LinkedSourceV1;
  try { linked = readLinkedSource(linkedSource, limits); }
  catch (error) { return failure(error instanceof FetchFault ? error.failureCode : 'source_not_linked'); }
  let initialUrl: URL;
  try { initialUrl = normalizeSourceUrl(linked.url, limits.maxUrlLength); }
  catch (error) { return failure(error instanceof FetchFault ? error.failureCode : 'invalid_url'); }
  const host = normalizeHostname(initialUrl.hostname);
  const resolve = dependencies.resolve ?? defaultResolve;
  const transport = dependencies.transport ?? new PinnedNodeSourceTransport();
  const extract = dependencies.extract ?? textBlocks;
  const deadline = Date.now() + limits.timeoutMs;
  let currentUrl = initialUrl;
  let redirects = 0;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new FetchFault('timeout');
      const currentHost = normalizeHostname(currentUrl.hostname);
      let addresses: readonly ResolvedAddress[];
      try { addresses = await withTimeout(resolve(currentHost), remainingMs); }
      catch (error) {
        if (error instanceof FetchFault) throw error;
        throw new FetchFault('dns_failed');
      }
      const address = resolvePublicAddress(addresses, limits.maxDnsAnswers);
      const responseTimeout = deadline - Date.now();
      if (responseTimeout <= 0) throw new FetchFault('timeout');
      let response: RawSourceResponse;
      try {
        response = await withTimeout(
          transport.request(currentUrl, address, responseTimeout, limits.maxResponseBytes, limits.maxHeaderBytes),
          responseTimeout,
        );
      } catch (error) {
        if (error instanceof FetchFault) throw error;
        throw new FetchFault('network_error');
      }
      if (response.body.byteLength > limits.maxResponseBytes) throw new FetchFault('response_too_large');
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const locationHeader = response.headers.location;
        if (Array.isArray(locationHeader) && locationHeader.length !== 1) throw new FetchFault('redirect_rejected');
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        if (!location) throw new FetchFault('redirect_rejected');
        if (redirects >= limits.maxRedirects) throw new FetchFault('too_many_redirects');
        let nextUrl: URL;
        try { nextUrl = normalizeSourceUrl(new URL(location, currentUrl).toString(), limits.maxUrlLength); }
        catch { throw new FetchFault('redirect_rejected'); }
        if (normalizeHostname(nextUrl.hostname) !== host) throw new FetchFault('redirect_rejected');
        if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') throw new FetchFault('redirect_rejected');
        currentUrl = nextUrl;
        redirects += 1;
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw new FetchFault('http_status');
      const extractionTimeoutMs = deadline - Date.now();
      if (extractionTimeoutMs <= 0) throw new FetchFault('timeout');
      return await buildRetrievedSource(initialUrl.toString(), linked.attribution, currentUrl, response, retrievedAt, limits, extractionTimeoutMs, extract);
    }
  } catch (error) {
    if (error instanceof FetchFault) return failure(error.failureCode);
    if ((error as NodeJS.ErrnoException)?.code === 'TI_SOURCE_TIMEOUT') return failure('timeout');
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') return failure('response_too_large');
    return failure('dns_failed');
  }
}

function assertEligibilityValues(name: string, values: readonly string[]): void {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error(`${name} must be explicitly configured with non-empty canonical values`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicate values`);
}

function assertSourceEligibilityPolicy(policy: SourceEligibilityPolicy): void {
  if (!policy || typeof policy !== 'object') throw new Error('source eligibility policy must be explicitly configured');
  assertEligibilityValues('supportedLanguages', policy.supportedLanguages);
  assertEligibilityValues('eligibleModerationStates', policy.eligibleModerationStates);
  assertEligibilityValues('eligiblePublicationStates', policy.eligiblePublicationStates);
  const contractLimits = policy.contractLimits as ContractLimits | undefined;
  const requiredLimitKeys: readonly (keyof ContractLimits)[] = [
    'maxStringCodePoints', 'maxArrayItems', 'maxPayloadBytes', 'maxContextItems', 'maxContextBytes',
  ];
  if (!contractLimits || typeof contractLimits !== 'object'
      || Object.keys(contractLimits).length !== requiredLimitKeys.length
      || requiredLimitKeys.some((key) => !Object.hasOwn(contractLimits, key))) {
    throw new Error('all canonical contract limits must be explicitly configured');
  }
  for (const key of requiredLimitKeys) {
    const value = contractLimits[key];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`contractLimits.${key} must be a positive safe integer`);
  }
}

export async function fetchCanonicalPostSource(
  input: unknown,
  eligibility: SourceEligibilityPolicy,
  limits: SourceFetchLimits,
  dependencies: SourceFetchDependencies = {},
): Promise<CanonicalPostSourceFetchResult> {
  validateLimits(limits);
  assertSourceEligibilityPolicy(eligibility);
  const now = dependencies.now ?? (() => new Date());
  let post: CanonicalPostInputV1;
  try {
    post = validateCanonicalPostInput(input, eligibility.contractLimits, eligibility.supportedLanguages);
  } catch (error) {
    if (!(error instanceof ContractValidationError)) throw error;
    return {
      postStatus: 'invalid',
      result: {
        retrievalStatus: 'failed',
        extractionStatus: 'not_attempted',
        groundingStatus: 'not_assessed',
        failureCode: 'invalid_canonical_post',
        retrievedAt: now().toISOString(),
      },
    };
  }

  const canonicalPost: CanonicalPostSourceReference = {
    postId: post.postId,
    version: post.postContentVersion !== undefined
      ? { kind: 'postContentVersion', value: post.postContentVersion }
      : { kind: 'contentHash', value: post.contentHash! },
  };
  if (!eligibility.eligibleModerationStates.includes(post.moderationState)
      || !eligibility.eligiblePublicationStates.includes(post.publicationState)) {
    return {
      postStatus: 'ineligible',
      canonicalPost,
      result: {
        retrievalStatus: 'failed',
        extractionStatus: 'not_attempted',
        groundingStatus: 'not_assessed',
        failureCode: 'ineligible_post',
        retrievedAt: now().toISOString(),
      },
    };
  }
  return {
    postStatus: 'eligible',
    canonicalPost,
    result: await fetchLinkedSource(post.source, limits, dependencies),
  };
}
