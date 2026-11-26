import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceBundle, type EvidenceBundlePolicy } from './evidence';
import { QuoteResolutionError, QuoteSnapshotResolver, type ExactInsightSnapshotLookup, type QuoteResolutionPolicy } from './quote-resolver';

const limits = {
  maxStringCodePoints: 4_096,
  maxArrayItems: 32,
  maxPayloadBytes: 32_768,
  maxContextItems: 8,
  maxContextBytes: 8_192,
};
const evidencePolicy: EvidenceBundlePolicy = {
  contractLimits: limits,
  supportedLanguages: ['en'],
  eligibleModerationStates: ['visible'],
  eligiblePublicationStates: ['published'],
  maxSourceUrlBytes: 2_048,
  maxEvidenceItems: 12,
  maxTotalTextCodePoints: 8_192,
  maxSourceTextCodePoints: 8_192,
  maxCitationClaims: 16,
  maxCitationQuoteCodePoints: 2_048,
};
const resolverPolicy: QuoteResolutionPolicy = {
  contractLimits: limits,
  supportedLanguages: ['en'],
  evidencePolicy: {
    minimumEvidenceCodePoints: 10,
    insufficientEvidenceAction: 'fail',
    maxEvidenceItems: 12,
    maxEvidenceTextCodePoints: 8_192,
  },
};

function post(version = 'post-v4', content = 'The exact quoted post says the project began in 2025.'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    postId: 'post-private-42',
    postContentVersion: version,
    contentHash: 'canonical-hash-v4',
    title: 'Exact quote title',
    content,
    language: 'en',
    contentFormat: 'plain_text',
    categoryId: 2,
    subcategoryId: 'technology',
    topicIds: ['topic-1'],
    moderationState: 'visible',
    publicationState: 'published',
  };
}

function bundle(forPost = post()) {
  const version = forPost.postContentVersion as string;
  return buildEvidenceBundle(forPost, {
    postStatus: 'eligible',
    canonicalPost: { postId: forPost.postId as string, version: { kind: 'postContentVersion', value: version } },
    result: {
      retrievalStatus: 'failed',
      extractionStatus: 'not_attempted',
      groundingStatus: 'not_assessed',
      failureCode: 'source_not_linked',
      retrievedAt: '2026-11-26T10:00:00.000Z',
    },
  }, evidencePolicy);
}

function quote(overrides: Record<string, unknown> = {}) {
  return {
    quoteId: 'quote-private-7',
    parentPostId: 'post-private-42',
    parentPostContentVersion: 'post-v4',
    snapshot: {
      type: 'cg_post',
      postId: 'post-private-42',
      postContentVersion: 'post-v4',
      contentHash: 'canonical-hash-v4',
      title: 'Exact quote title',
      content: 'The exact quoted post says the project began in 2025.',
      language: 'en',
      contentFormat: 'plain_text',
      capturedAt: '2026-11-26T10:00:00.000Z',
      knownCurrentPostContentVersion: 'post-v5',
    },
    ...overrides,
  };
}

function resolver(options: {
  authorized?: boolean;
  lookup?: (postId: string, version: string | number | null, hash?: string) => Promise<{
    status: 'available'; canonicalPost: unknown; evidenceBundle: ReturnType<typeof bundle> | null; currentPostContentVersion: string | null;
  } | { status: 'unavailable'; reason: 'missing' | 'hidden' | 'deleted' | 'tombstoned' | 'not_retained' }>;
  insightLookup?: () => Promise<ExactInsightSnapshotLookup>;
} = {}) {
  return new QuoteSnapshotResolver(resolverPolicy, {
    authorizeCgService: async () => options.authorized ?? true,
    loadExactPostSnapshot: options.lookup ?? (async () => ({
      status: 'available', canonicalPost: post(), evidenceBundle: bundle(), currentPostContentVersion: 'post-v5',
    })),
    loadExactInsightSnapshot: options.insightLookup ?? (async () => ({ status: 'unavailable', reason: 'missing' })),
  });
}

test('resolves only the exact quoted post version and labels newer-current metadata separately', async () => {
  const result = await resolver().resolve([quote()]);
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved' || result.quote.type !== 'cg_post') return;
  assert.equal(result.quote.quotedVersion.value, 'post-v4');
  assert.equal(result.quote.content, 'The exact quoted post says the project began in 2025.');
  assert.equal(result.quote.currentVersion, 'post-v5');
  assert.equal(result.quote.currentVersionDiffers, true);
});

test('changed source snapshot and version mismatch fail safely rather than substituting current content', async () => {
  const called: unknown[] = [];
  const result = await resolver({ lookup: async (postId, version, hash) => {
    called.push([postId, version, hash]);
    return { status: 'available', canonicalPost: post('post-v5', 'New current content, not the quote.'), evidenceBundle: bundle(post('post-v5', 'New current content, not the quote.')), currentPostContentVersion: 'post-v5' };
  } }).resolve([quote()]);
  assert.deepEqual(called, [['post-private-42', 'post-v4', 'canonical-hash-v4']]);
  assert.deepEqual(result, { status: 'unavailable', limitation: 'quote_snapshot_unavailable' });
});

test('hidden, deleted, tombstoned, and unretained lookups share a non-enumerating safe limitation', async () => {
  for (const reason of ['hidden', 'deleted', 'tombstoned', 'not_retained'] as const) {
    const result = await resolver({ lookup: async () => ({ status: 'unavailable', reason }) }).resolve([quote()]);
    assert.deepEqual(result, { status: 'unavailable', limitation: 'quote_snapshot_unavailable' });
  }
});

test('evidence must be bound to the exact quoted post version', async () => {
  const mismatched = bundle(post('post-v5'));
  const result = await resolver({ lookup: async () => ({
    status: 'available', canonicalPost: post(), evidenceBundle: mismatched, currentPostContentVersion: 'post-v5',
  }) }).resolve([quote()]);
  assert.deepEqual(result, { status: 'unavailable', limitation: 'quote_evidence_unavailable' });
});

test('insight quotes retain their exact artifact version and parent evidence binding', async () => {
  const insightQuote = {
    quoteId: 'insight-quote-2',
    parentPostId: 'post-private-42',
    parentPostContentVersion: 'post-v4',
    snapshot: {
      type: 'intelligence_insight',
      artifactId: 'artifact-9',
      artifactVersion: 'artifact-v2',
      itemId: 'item-3',
      content: 'The insight states that the project began in 2025.',
      language: 'en',
      capturedAt: '2026-11-26T10:00:00.000Z',
      knownCurrentArtifactVersion: 'artifact-v3',
    },
  };
  const result = await resolver({ insightLookup: async () => ({
    status: 'available',
    artifactId: 'artifact-9',
    artifactVersion: 'artifact-v2',
    itemId: 'item-3',
    content: 'The insight states that the project began in 2025.',
    language: 'en',
    parentPostId: 'post-private-42',
    parentPostContentVersion: 'post-v4',
    evidenceBundle: bundle(),
    currentArtifactVersion: 'artifact-v3',
  }) }).resolve([insightQuote]);
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved' || result.quote.type !== 'intelligence_insight') return;
  assert.equal(result.quote.artifactVersion, 'artifact-v2');
  assert.equal(result.quote.currentVersionDiffers, true);
  const substituted = await resolver({ insightLookup: async () => ({
    status: 'available',
    artifactId: 'artifact-9', artifactVersion: 'artifact-v3', itemId: 'item-3',
    content: 'The insight states that the project began in 2025.', language: 'en',
    parentPostId: 'post-private-42', parentPostContentVersion: 'post-v4', evidenceBundle: bundle(), currentArtifactVersion: 'artifact-v3',
  }) }).resolve([insightQuote]);
  assert.deepEqual(substituted, { status: 'unavailable', limitation: 'quote_snapshot_unavailable' });
});

test('authorization, quote count, and unsupported quote type fail closed', async () => {
  await assert.rejects(() => resolver({ authorized: false }).resolve([quote()]), (error: unknown) =>
    error instanceof QuoteResolutionError && error.code === 'unauthorized');
  await assert.rejects(() => resolver().resolve([quote(), quote()]), (error: unknown) =>
    error instanceof QuoteResolutionError && error.code === 'invalid_request');
  await assert.rejects(() => resolver().resolve([quote({ snapshot: { ...quote().snapshot as object, type: 'unknown' } })]), (error: unknown) =>
    error instanceof QuoteResolutionError && error.code === 'invalid_request');
});

test('missing exact evidence fails separately without returning quote content', async () => {
  const result = await resolver({ lookup: async () => ({
    status: 'available', canonicalPost: post(), evidenceBundle: null, currentPostContentVersion: null,
  }) }).resolve([quote()]);
  assert.deepEqual(result, { status: 'unavailable', limitation: 'quote_evidence_unavailable' });
});
