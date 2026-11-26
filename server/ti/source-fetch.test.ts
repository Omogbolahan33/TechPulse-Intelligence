import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import test from 'node:test';
import {
  fetchCanonicalPostSource,
  PinnedNodeSourceTransport,
  isSafePublicAddress,
  makePinnedLookup,
  normalizeSourceUrl,
  type ExtractedBlocks,
  type PinnedSourceTransport,
  type RawSourceResponse,
  type ResolvedAddress,
  type SourceFetchLimits,
} from './source-fetch';

const limits: SourceFetchLimits = {
  timeoutMs: 5_000,
  maxRedirects: 2,
  maxUrlLength: 2_048,
  maxAttributionCodePoints: 256,
  maxDnsAnswers: 8,
  maxHeaderBytes: 16_384,
  maxResponseBytes: 8_192,
  maxDecompressedBytes: 16_384,
  maxExtractedTextCodePoints: 1_000,
  minUsableTextCodePoints: 20,
  maxHtmlNodes: 1_000,
  maxEvidenceBlocks: 12,
  maxWorkerOldGenerationMb: 64,
  maxWorkerYoungGenerationMb: 16,
};
const publicV4: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const fixedDate = new Date('2026-01-02T03:04:05.000Z');
const eligibility = {
  contractLimits: {
    maxStringCodePoints: 512,
    maxArrayItems: 12,
    maxPayloadBytes: 16_384,
    maxContextItems: 4,
    maxContextBytes: 4_096,
  },
  supportedLanguages: ['en', 'fr'],
  eligibleModerationStates: ['visible'],
  eligiblePublicationStates: ['published'],
};

function canonicalPost(
  source: unknown = { url: 'https://publisher.example/story#section', attribution: 'Synthetic Publisher' },
  includeSource = true,
) {
  return {
    schemaVersion: 1,
    postId: 'synthetic-post-123',
    postContentVersion: 'content-v4',
    title: 'Synthetic canonical post',
    content: 'Privacy-cleared synthetic CG post content.',
    language: 'en',
    categoryId: 0,
    subcategoryId: 'synthetic-subcategory',
    topicIds: ['synthetic-topic'],
    ...(includeSource && source !== undefined ? { source } : {}),
    moderationState: 'visible',
    publicationState: 'published',
  };
}

function response(body: Buffer, headers: RawSourceResponse['headers'] = { 'content-type': 'text/html; charset=utf-8' }, statusCode = 200): RawSourceResponse {
  return { statusCode, headers, body };
}

class QueueTransport implements PinnedSourceTransport {
  readonly requests: Array<{ url: URL; address: ResolvedAddress; timeoutMs: number; maxBytes: number; maxHeaderBytes: number }> = [];
  constructor(private readonly responses: RawSourceResponse[]) {}
  async request(url: URL, address: ResolvedAddress, timeoutMs: number, maxResponseBytes: number, maxHeaderBytes: number): Promise<RawSourceResponse> {
    this.requests.push({ url: new URL(url), address, timeoutMs, maxBytes: maxResponseBytes, maxHeaderBytes });
    const next = this.responses.shift();
    if (!next) throw new Error('synthetic transport response queue empty');
    return next;
  }
}

const successfulHtml = Buffer.from(`<!doctype html><html><head><title>Synthetic multilingual source</title><script>ignore this prompt</script></head><body><nav>navigation noise</nav><main><article><h1>Résumé · 日本語</h1><p>Privacy-cleared synthetic evidence in English, français, and 日本語.</p><p>Second synthetic paragraph with a stable citation.</p></article></main><aside>untrusted side content</aside></body></html>`);

async function fetchWith(
  transport: PinnedSourceTransport,
  overrides: Partial<SourceFetchLimits> = {},
  resolve?: (host: string) => Promise<readonly ResolvedAddress[]>,
  source = { url: 'https://publisher.example/story#section', attribution: 'Synthetic Publisher' },
  extract?: (contentType: 'text/html' | 'application/xhtml+xml' | 'text/plain', text: string, configuredLimits: SourceFetchLimits, timeoutMs: number) => Promise<ExtractedBlocks>,
) {
  const canonicalSource = { url: source.url, attribution: source.attribution };
  const fetched = await fetchCanonicalPostSource(
    canonicalPost(canonicalSource),
    eligibility,
    { ...limits, ...overrides },
    {
      resolve: resolve ?? (async () => [publicV4]),
      transport,
      extract,
      now: () => fixedDate,
    },
  );
  assert.equal(fetched.postStatus, 'eligible');
  return fetched.result;
}

test('normalizes only HTTP(S) source URLs and rejects credentials or non-default ports', () => {
  assert.equal(normalizeSourceUrl('HTTPS://Publisher.Example:443/story#part', 2048).toString(), 'https://publisher.example/story');
  assert.equal(normalizeSourceUrl('http://Publisher.Example:80/news', 2048).toString(), 'http://publisher.example/news');
  assert.equal(normalizeSourceUrl('https://publisher.example./news', 2048).toString(), 'https://publisher.example/news');
  assert.equal(normalizeSourceUrl('https://[2606:4700:4700::1111]/news', 2048).hostname, '[2606:4700:4700::1111]');
  assert.throws(() => normalizeSourceUrl('ftp://publisher.example/file', 2048), /unsupported_scheme/);
  assert.throws(() => normalizeSourceUrl('https://user:secret@publisher.example/story', 2048), /credentials_not_allowed/);
  assert.throws(() => normalizeSourceUrl('https://publisher.example:8443/story', 2048), /unsupported_port/);
  assert.throws(() => normalizeSourceUrl('https://publisher.example/' + 'x'.repeat(2050), 2048), /invalid_url/);
});

test('fetch entrypoint validates canonical shape and never substitutes an unlinked source', async () => {
  const missingSource = await fetchCanonicalPostSource(canonicalPost(undefined, false), eligibility, limits, { now: () => fixedDate });
  assert.equal(missingSource.postStatus, 'eligible');
  if (missingSource.postStatus === 'eligible') {
    assert.equal(missingSource.result.retrievalStatus, 'failed');
    if (missingSource.result.retrievalStatus === 'failed') assert.equal(missingSource.result.failureCode, 'source_not_linked');
  }

  const withIdentity = await fetchCanonicalPostSource(
    canonicalPost({ url: 'https://publisher.example/', attribution: 'Publisher', userId: 'synthetic-user' }),
    eligibility,
    limits,
    { now: () => fixedDate },
  );
  assert.equal(withIdentity.postStatus, 'invalid');
  if (withIdentity.postStatus === 'invalid') assert.equal(withIdentity.result.failureCode, 'invalid_canonical_post');
});

test('fetches only exact canonical versions that match explicit eligibility policy', async () => {
  const ineligibleTransport = new QueueTransport([response(successfulHtml)]);
  const hidden = await fetchCanonicalPostSource(
    { ...canonicalPost(), moderationState: 'hidden' },
    eligibility,
    limits,
    { transport: ineligibleTransport, now: () => fixedDate },
  );
  assert.equal(hidden.postStatus, 'ineligible');
  if (hidden.postStatus === 'ineligible') {
    assert.equal(hidden.canonicalPost.postId, 'synthetic-post-123');
    assert.deepEqual(hidden.canonicalPost.version, { kind: 'postContentVersion', value: 'content-v4' });
    assert.equal(hidden.result.failureCode, 'ineligible_post');
  }
  const draft = await fetchCanonicalPostSource(
    { ...canonicalPost(), publicationState: 'draft' },
    eligibility,
    limits,
    { transport: ineligibleTransport, now: () => fixedDate },
  );
  assert.equal(draft.postStatus, 'ineligible');
  if (draft.postStatus === 'ineligible') assert.equal(draft.result.failureCode, 'ineligible_post');
  assert.equal(ineligibleTransport.requests.length, 0);

  const invalidPost = await fetchCanonicalPostSource(
    { ...canonicalPost(), unexpectedIdentity: 'synthetic-user' },
    eligibility,
    limits,
    { now: () => fixedDate },
  );
  assert.equal(invalidPost.postStatus, 'invalid');
  if (invalidPost.postStatus === 'invalid') assert.equal(invalidPost.result.failureCode, 'invalid_canonical_post');
  await assert.rejects(
    fetchCanonicalPostSource(canonicalPost(), { ...eligibility, supportedLanguages: [] }, limits),
    /supportedLanguages must be explicitly configured/,
  );

  const hashVersioned = await fetchCanonicalPostSource(
    { ...canonicalPost(), postContentVersion: undefined, contentHash: 'canonical-content-hash' },
    eligibility,
    limits,
    { transport: new QueueTransport([response(successfulHtml)]), resolve: async () => [publicV4], extract: async () => ({ title: '', blocks: ['Enough synthetic source content for extraction.'], truncated: false }), now: () => fixedDate },
  );
  assert.equal(hashVersioned.postStatus, 'eligible');
  if (hashVersioned.postStatus === 'eligible') {
    assert.deepEqual(hashVersioned.canonicalPost.version, { kind: 'contentHash', value: 'canonical-content-hash' });
  }
});

test('the real resolver path blocks canonical and legacy-form loopback addresses before transport', async () => {
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/']) {
    const result = await fetchCanonicalPostSource(canonicalPost({ url, attribution: 'Local synthetic source' }), eligibility, limits);
    assert.equal(result.postStatus, 'eligible');
    if (result.postStatus === 'eligible') {
      assert.equal(result.result.retrievalStatus, 'failed');
      if (result.result.retrievalStatus === 'failed') assert.equal(result.result.failureCode, 'blocked_address', url);
    }
  }
});

test('pinned HTTP transport enforces byte/time limits against an isolated loopback fixture', async () => {
  const server = createServer((request, responseStream) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        if (!responseStream.destroyed) responseStream.end('late synthetic response');
      }, 100);
      return;
    }
    if (request.url === '/oversized') {
      responseStream.writeHead(200, { 'content-length': '2048', 'content-type': 'text/plain' });
      responseStream.end('x'.repeat(2048));
      return;
    }
    if (request.url === '/large-header') {
      responseStream.writeHead(200, { 'content-type': 'text/plain', 'x-synthetic-large': 'h'.repeat(2_048) });
      responseStream.end('too much header data');
      return;
    }
    responseStream.writeHead(200, { 'content-type': 'text/plain' });
    responseStream.end('bounded local fixture');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addressInfo = server.address();
  assert.ok(addressInfo && typeof addressInfo !== 'string');
  const transport = new PinnedNodeSourceTransport();
  const pinnedLoopback = { address: '127.0.0.1', family: 4 as const };
  const url = (path: string) => new URL(`http://127.0.0.1:${addressInfo.port}${path}`);
  try {
    const okay = await transport.request(url('/ok'), pinnedLoopback, 1_000, 128, 8_192);
    assert.equal(okay.body.toString(), 'bounded local fixture');
    await assert.rejects(transport.request(url('/oversized'), pinnedLoopback, 1_000, 128, 8_192), /response_too_large/);
    await assert.rejects(
      transport.request(url('/large-header'), pinnedLoopback, 1_000, 1_024, 512),
      (error: Error & { failureCode?: string }) => error.failureCode === 'response_headers_too_large',
    );
    await assert.rejects(transport.request(url('/slow'), pinnedLoopback, 20, 128, 8_192), /timeout/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('public-address policy blocks private, loopback, link-local, metadata, mapped and special-use ranges', () => {
  assert.equal(isSafePublicAddress('93.184.216.34'), true);
  assert.equal(isSafePublicAddress('2606:4700:4700::1111'), true);
  for (const address of [
    '0.0.0.0', '127.0.0.1', '10.0.0.2', '172.16.1.2', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.8', '203.0.113.1',
    '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '64:ff9b::1', '2001::1', '2001:db8::1', '2001:10::1', '2001:20::1', 'ff02::1',
  ]) assert.equal(isSafePublicAddress(address), false, address);
});

test('pinned DNS lookup returns only the previously validated IP and rejects hostname substitution', async () => {
  const lookup = makePinnedLookup('publisher.example', publicV4);
  const success = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
    lookup('publisher.example', { all: false }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address: address as string, family });
    });
  });
  assert.deepEqual(success, { address: publicV4.address, family: 4 });
  await assert.rejects(new Promise((resolve, reject) => {
    lookup('metadata.internal', { all: false }, (error, address) => error ? reject(error) : resolve(address));
  }), /unexpected lookup hostname/);
});

test('retrieves gzip HTML, extracts multilingual evidence and stable provenance without noisy markup', async () => {
  const transport = new QueueTransport([response(gzipSync(successfulHtml), {
    'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip',
  })]);
  const result = await fetchWith(transport, {}, async (host) => {
    assert.equal(host, 'publisher.example');
    return [publicV4];
  });
  assert.equal(result.retrievalStatus, 'retrieved');
  assert.equal(result.extractionStatus, 'usable');
  assert.equal(result.groundingStatus, 'not_assessed');
  if (result.retrievalStatus !== 'retrieved') return;
  assert.equal(result.originalUrl, 'https://publisher.example/story');
  assert.equal(result.sourceAttribution, 'Synthetic Publisher');
  assert.equal(result.finalUrl, 'https://publisher.example/story');
  assert.equal(result.retrievedAt, fixedDate.toISOString());
  assert.equal(result.title, 'Synthetic multilingual source');
  assert.match(result.text, /français/);
  assert.match(result.text, /日本語/);
  assert.doesNotMatch(result.text, /ignore this prompt|navigation noise|untrusted side content/);
  assert.ok(result.evidenceBlocks.length >= 2);
  assert.ok(result.evidenceBlocks.every((block) => /^src_[a-f0-9]{32}$/.test(block.evidenceId)));
  assert.equal(result.contentHash, result.sourceVersion);
  assert.equal(result.extractionLimits.maxHtmlNodes, limits.maxHtmlNodes);
  assert.equal(result.extractionLimits.maxWorkerOldGenerationMb, limits.maxWorkerOldGenerationMb);
  assert.equal(result.extractionLimits.maxWorkerYoungGenerationMb, limits.maxWorkerYoungGenerationMb);
  assert.deepEqual(transport.requests[0].address, publicV4);
  assert.equal(transport.requests[0].maxHeaderBytes, limits.maxHeaderBytes);
  assert.equal(transport.requests[0].url.hash, '');
  const repeated = await fetchWith(new QueueTransport([response(gzipSync(successfulHtml), {
    'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip',
  })]));
  assert.equal(repeated.retrievalStatus, 'retrieved');
  if (repeated.retrievalStatus === 'retrieved') {
    assert.equal(repeated.contentHash, result.contentHash);
    assert.deepEqual(repeated.evidenceBlocks, result.evidenceBlocks);
  }
});

test('re-resolves each same-host redirect and blocks DNS rebinding to a private target', async () => {
  const transport = new QueueTransport([response(Buffer.alloc(0), { location: '/next' }, 302), response(successfulHtml)]);
  let resolutions = 0;
  const result = await fetchWith(transport, {}, async () => {
    resolutions += 1;
    return resolutions === 1 ? [publicV4] : [{ address: '127.0.0.1', family: 4 }];
  });
  assert.equal(result.retrievalStatus, 'failed');
  if (result.retrievalStatus === 'failed') assert.equal(result.failureCode, 'blocked_address');
  assert.equal(resolutions, 2);
  assert.equal(transport.requests.length, 1);
});

test('rejects cross-host and HTTPS-downgrade redirects before following them', async () => {
  const crossHost = await fetchWith(new QueueTransport([response(Buffer.alloc(0), { location: 'https://other.example/article' }, 302)]));
  assert.equal(crossHost.retrievalStatus, 'failed');
  if (crossHost.retrievalStatus === 'failed') assert.equal(crossHost.failureCode, 'redirect_rejected');
  const downgrade = await fetchWith(new QueueTransport([response(Buffer.alloc(0), { location: 'http://publisher.example/cleartext' }, 302)]));
  assert.equal(downgrade.retrievalStatus, 'failed');
  if (downgrade.retrievalStatus === 'failed') assert.equal(downgrade.failureCode, 'redirect_rejected');
});

test('bounds redirects, response bytes, decompressed bytes and unsupported encodings', async () => {
  const tooMany = await fetchWith(new QueueTransport([
    response(Buffer.alloc(0), { location: '/one' }, 302),
    response(Buffer.alloc(0), { location: '/two' }, 302),
    response(Buffer.alloc(0), { location: '/three' }, 302),
  ]));
  assert.equal(tooMany.retrievalStatus, 'failed');
  if (tooMany.retrievalStatus === 'failed') assert.equal(tooMany.failureCode, 'too_many_redirects');

  const rawOversize = await fetchWith(new QueueTransport([response(Buffer.alloc(limits.maxResponseBytes + 1))]));
  assert.equal(rawOversize.retrievalStatus, 'failed');
  if (rawOversize.retrievalStatus === 'failed') assert.equal(rawOversize.failureCode, 'response_too_large');

  const compressionFixtures = [
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const;
  for (const [encoding, compress] of compressionFixtures) {
    const compressedBomb = await fetchWith(new QueueTransport([response(compress(Buffer.from('x'.repeat(20_000))), {
      'content-type': 'text/plain; charset=utf-8', 'content-encoding': encoding,
    })]), { maxDecompressedBytes: 2_000 });
    assert.equal(compressedBomb.retrievalStatus, 'retrieved', encoding);
    if (compressedBomb.retrievalStatus === 'retrieved') {
      assert.equal(compressedBomb.extractionStatus, 'unusable', encoding);
      assert.equal(compressedBomb.failureCode, 'response_too_large', encoding);
    }
  }

  const badEncoding = await fetchWith(new QueueTransport([response(Buffer.from('text'), {
    'content-type': 'text/plain', 'content-encoding': 'compress',
  })]));
  assert.equal(badEncoding.retrievalStatus, 'retrieved');
  if (badEncoding.retrievalStatus === 'retrieved') assert.equal(badEncoding.failureCode, 'unsupported_content_encoding');
});

test('malformed compressed content, unsupported charset, and parser failures return typed unusable evidence', async () => {
  const malformedCompression = await fetchWith(new QueueTransport([response(Buffer.from('not a gzip stream'), {
    'content-type': 'text/plain; charset=utf-8', 'content-encoding': 'gzip',
  })]));
  assert.equal(malformedCompression.retrievalStatus, 'retrieved');
  if (malformedCompression.retrievalStatus === 'retrieved') assert.equal(malformedCompression.failureCode, 'decompression_failed');

  const unsupportedCharset = await fetchWith(new QueueTransport([response(Buffer.from('synthetic source text'), {
    'content-type': 'text/plain; charset=x-unknown-charset',
  })]));
  assert.equal(unsupportedCharset.retrievalStatus, 'retrieved');
  if (unsupportedCharset.retrievalStatus === 'retrieved') assert.equal(unsupportedCharset.failureCode, 'unsupported_charset');

  const invalidUtf8 = await fetchWith(new QueueTransport([response(Buffer.from([0xc3, 0x28]), {
    'content-type': 'text/plain; charset=utf-8',
  })]));
  assert.equal(invalidUtf8.retrievalStatus, 'retrieved');
  if (invalidUtf8.retrievalStatus === 'retrieved') assert.equal(invalidUtf8.failureCode, 'unsupported_charset');

  const parserFailure = await fetchWith(
    new QueueTransport([response(Buffer.from('<article>synthetic body</article>'))]),
    {},
    undefined,
    undefined,
    async () => { throw new Error('synthetic parser exception'); },
  );
  assert.equal(parserFailure.retrievalStatus, 'retrieved');
  if (parserFailure.retrievalStatus === 'retrieved') {
    assert.equal(parserFailure.extractionStatus, 'unusable');
    assert.equal(parserFailure.failureCode, 'extraction_failed');
    assert.equal(parserFailure.evidenceBlocks.length, 0);
  }
});

test('retrieval success is separate from unusable extraction and unsupported content types', async () => {
  const empty = await fetchWith(new QueueTransport([response(Buffer.from('<html><body><script>noise</script></body></html>'))]));
  assert.equal(empty.retrievalStatus, 'retrieved');
  if (empty.retrievalStatus === 'retrieved') {
    assert.equal(empty.extractionStatus, 'unusable');
    assert.equal(empty.groundingStatus, 'not_assessed');
    assert.equal(empty.limitation, 'insufficient_extractable_text');
  }
  const pdf = await fetchWith(new QueueTransport([response(Buffer.from('%PDF'), { 'content-type': 'application/pdf' })]));
  assert.equal(pdf.retrievalStatus, 'retrieved');
  if (pdf.retrievalStatus === 'retrieved') {
    assert.equal(pdf.extractionStatus, 'unusable');
    assert.equal(pdf.failureCode, 'unsupported_content_type');
  }
  const ambiguousType = await fetchWith(new QueueTransport([response(Buffer.from('text'), {
    'content-type': ['text/plain', 'text/html'] as never,
  })]));
  assert.equal(ambiguousType.retrievalStatus, 'retrieved');
  if (ambiguousType.retrievalStatus === 'retrieved') assert.equal(ambiguousType.failureCode, 'unsupported_content_type');
});

test('bounds DNS answers and timeouts without contacting an external host', async () => {
  const tooMany = await fetchWith(new QueueTransport([response(successfulHtml)]), { maxDnsAnswers: 1 }, async () => [
    publicV4, { address: '1.1.1.1', family: 4 },
  ]);
  assert.equal(tooMany.retrievalStatus, 'failed');
  if (tooMany.retrievalStatus === 'failed') assert.equal(tooMany.failureCode, 'blocked_address');

  const dnsTimeout = await fetchWith(new QueueTransport([]), { timeoutMs: 10 }, () => new Promise(() => undefined));
  assert.equal(dnsTimeout.retrievalStatus, 'failed');
  if (dnsTimeout.retrievalStatus === 'failed') assert.equal(dnsTimeout.failureCode, 'timeout');

  const slowTransport: PinnedSourceTransport = { request: () => new Promise(() => undefined) };
  const requestTimeout = await fetchWith(slowTransport, { timeoutMs: 10 });
  assert.equal(requestTimeout.retrievalStatus, 'failed');
  if (requestTimeout.retrievalStatus === 'failed') assert.equal(requestTimeout.failureCode, 'timeout');

  const extractionTimeout = await fetchWith(
    new QueueTransport([response(successfulHtml)]),
    { timeoutMs: 10 },
    undefined,
    undefined,
    () => new Promise(() => undefined),
  );
  assert.equal(extractionTimeout.retrievalStatus, 'retrieved');
  if (extractionTimeout.retrievalStatus === 'retrieved') {
    assert.equal(extractionTimeout.extractionStatus, 'unusable');
    assert.equal(extractionTimeout.failureCode, 'timeout');
  }
});

test('fails closed on mixed public/private DNS answers and non-success HTTP status', async () => {
  let calls = 0;
  const privateMix = await fetchWith(new QueueTransport([response(successfulHtml)]), {}, async () => {
    calls += 1;
    return [publicV4, { address: '10.0.0.5', family: 4 }];
  });
  assert.equal(privateMix.retrievalStatus, 'failed');
  if (privateMix.retrievalStatus === 'failed') assert.equal(privateMix.failureCode, 'blocked_address');
  assert.equal(calls, 1);

  const dnsFailure = await fetchWith(new QueueTransport([]), {}, async () => { throw new Error('synthetic DNS failure'); });
  assert.equal(dnsFailure.retrievalStatus, 'failed');
  if (dnsFailure.retrievalStatus === 'failed') assert.equal(dnsFailure.failureCode, 'dns_failed');

  const networkFailure: PinnedSourceTransport = { request: async () => { throw Object.assign(new Error('synthetic socket failure'), { code: 'ECONNREFUSED' }); } };
  const networkError = await fetchWith(networkFailure);
  assert.equal(networkError.retrievalStatus, 'failed');
  if (networkError.retrievalStatus === 'failed') assert.equal(networkError.failureCode, 'network_error');

  const badStatus = await fetchWith(new QueueTransport([response(Buffer.from('not found'), { 'content-type': 'text/plain' }, 404)]));
  assert.equal(badStatus.retrievalStatus, 'failed');
  if (badStatus.retrievalStatus === 'failed') assert.equal(badStatus.failureCode, 'http_status');
});

test('enforces parser node limits and returns a bounded, explicitly truncated result', async () => {
  const result = await fetchWith(
    new QueueTransport([response(successfulHtml)]),
    { maxHtmlNodes: 2, maxExtractedTextCodePoints: 64 },
  );
  assert.equal(result.retrievalStatus, 'retrieved');
  if (result.retrievalStatus === 'retrieved') {
    assert.equal(result.extractionStatus, 'unusable');
    assert.equal(result.truncated, true);
    assert.ok(Array.from(result.text).length <= 64);
    assert.equal(result.extractionLimits.maxHtmlNodes, 2);
  }
});

test('extracts text-only article containers and avoids duplicate nested-article evidence', async () => {
  const textOnly = await fetchWith(new QueueTransport([response(Buffer.from(
    '<main><article><div>Publisher text stored only in a generic div remains usable evidence.</div></article></main>',
  ))]));
  assert.equal(textOnly.retrievalStatus, 'retrieved');
  if (textOnly.retrievalStatus === 'retrieved') {
    assert.equal(textOnly.extractionStatus, 'usable');
    assert.match(textOnly.text, /generic div remains usable evidence/);
  }

  const nested = await fetchWith(new QueueTransport([response(Buffer.from(
    '<main><article><article><p>Nested article evidence appears exactly once.</p></article><p>Outer article evidence remains present.</p></article></main>',
  ))]));
  assert.equal(nested.retrievalStatus, 'retrieved');
  if (nested.retrievalStatus === 'retrieved') {
    assert.equal(nested.extractionStatus, 'usable');
    assert.equal(nested.text.match(/Nested article evidence appears exactly once\./g)?.length, 1);
    assert.equal(new Set(nested.evidenceBlocks.map(({ evidenceId }) => evidenceId)).size, nested.evidenceBlocks.length);
  }

  const repeated = await fetchWith(new QueueTransport([response(Buffer.from(
    '<article><p>Repeated synthetic evidence is still a distinct block.</p><p>Repeated synthetic evidence is still a distinct block.</p></article>',
  ))]));
  assert.equal(repeated.retrievalStatus, 'retrieved');
  if (repeated.retrievalStatus === 'retrieved') {
    assert.equal(repeated.evidenceBlocks.length, 2);
    assert.notEqual(repeated.evidenceBlocks[0].evidenceId, repeated.evidenceBlocks[1].evidenceId);
  }
});

test('applies one aggregate code-point budget across the title, evidence blocks, and separators', async () => {
  const html = '<html><head><title>Synthetic Title</title></head><body><main><article><p>First content paragraph.</p><p>Second content paragraph.</p></article></main></body></html>';
  const result = await fetchWith(new QueueTransport([response(Buffer.from(html))]), {
    maxExtractedTextCodePoints: 24,
    minUsableTextCodePoints: 1,
    maxEvidenceBlocks: 4,
  });
  assert.equal(result.retrievalStatus, 'retrieved');
  if (result.retrievalStatus === 'retrieved') {
    const total = Array.from(result.title).length + Array.from(result.text).length;
    assert.ok(total <= 24, `aggregate extracted text was ${total}`);
    assert.equal(result.truncated, true);
  }
});

test('reports evidence truncation only when a block is actually omitted', async () => {
  const twoParagraphs = '<main><article><p>First synthetic paragraph with detail.</p><p>Second synthetic paragraph with detail.</p></article></main>';
  const exactLimit = await fetchWith(new QueueTransport([response(Buffer.from(twoParagraphs))]), { maxEvidenceBlocks: 2 });
  assert.equal(exactLimit.retrievalStatus, 'retrieved');
  if (exactLimit.retrievalStatus === 'retrieved') {
    assert.equal(exactLimit.evidenceBlocks.length, 2);
    assert.equal(exactLimit.truncated, false);
  }

  const overLimit = await fetchWith(new QueueTransport([response(Buffer.from(
    `${twoParagraphs.replace('</article>', '<p>Third synthetic paragraph with detail.</p></article>')}`,
  ))]), { maxEvidenceBlocks: 2 });
  assert.equal(overLimit.retrievalStatus, 'retrieved');
  if (overLimit.retrievalStatus === 'retrieved') {
    assert.equal(overLimit.evidenceBlocks.length, 2);
    assert.equal(overLimit.truncated, true);
  }
});

test('applies configured text/evidence limits and stable IDs to text/plain sources', async () => {
  const result = await fetchWith(new QueueTransport([response(Buffer.from('第一段 paragraph.\n\nDeuxième paragraphe avec contenu synthétique.'), {
    'content-type': 'text/plain; charset=utf-8',
  })]), { maxExtractedTextCodePoints: 30, minUsableTextCodePoints: 5, maxEvidenceBlocks: 1 });
  assert.equal(result.retrievalStatus, 'retrieved');
  if (result.retrievalStatus === 'retrieved') {
    assert.equal(result.extractionStatus, 'usable');
    assert.equal(result.evidenceBlocks.length, 1);
    assert.equal(result.truncated, true);
    assert.ok(Array.from(result.text).length <= 30);
  }
});
