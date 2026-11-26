import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProsConsArtifactKey,
  buildSummaryArtifactKey,
  type ProsConsArtifactKeyInput,
  type SummaryArtifactKeyInput,
} from './cache-keys';

// Test bounds only; production limits and languages remain service/operator configuration.
const limits = { maxStringCodePoints: 128, maxInterestIds: 3, maxSerializedIdentityBytes: 8_192 } as const;

const summaryInput: SummaryArtifactKeyInput = {
  postId: 'synthetic-post-7',
  postContentVersion: 'post-rev-4',
  evidence: { kind: 'versioned', version: 'evidence-rev-9' },
  outputLanguage: 'en',
  generationDefinitionVersion: 'summary-definition-v2',
  promptVersion: 'summary-prompt-v3',
  outputSchemaVersion: 'summary-output-v1',
};

const prosConsInput = (overrides: Partial<ProsConsArtifactKeyInput> = {}): ProsConsArtifactKeyInput => ({
  ...summaryInput,
  personaId: 'Engineer',
  personaDefinitionVersion: 'persona-engineer-v2',
  interestTaxonomyVersion: 'taxonomy-v5',
  interestIds: ['ai', 'cloud'],
  ...overrides,
});

const allPermutations = <T,>(values: readonly T[]): T[][] => {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => allPermutations(values.filter((_, i) => i !== index).map((rest) => rest)).map((tail) => [value, ...tail]));
};

test('summary key is deterministic, versioned, and sensitive to every included identity dimension', () => {
  const first = buildSummaryArtifactKey(summaryInput, limits);
  assert.equal(first, buildSummaryArtifactKey({ ...summaryInput }, limits));
  assert.match(first, /^ti:v1:summary:[a-f0-9]{64}$/);

  const variants: SummaryArtifactKeyInput[] = [
    { ...summaryInput, postContentVersion: 'post-rev-5' },
    { ...summaryInput, contentHash: 'content-hash-synthetic' },
    { ...summaryInput, evidence: { kind: 'versioned', version: 'evidence-rev-10' } },
    { ...summaryInput, evidence: { kind: 'unavailable' } },
    { ...summaryInput, outputLanguage: 'fr' },
    { ...summaryInput, generationDefinitionVersion: 'summary-definition-v3' },
    { ...summaryInput, promptVersion: 'summary-prompt-v4' },
    { ...summaryInput, outputSchemaVersion: 'summary-output-v2' },
  ];
  for (const variant of variants) assert.notEqual(buildSummaryArtifactKey(variant, limits), first);
});

test('source unavailability is an explicit non-colliding identity marker', () => {
  const unavailable = buildSummaryArtifactKey({ ...summaryInput, evidence: { kind: 'unavailable' } }, limits);
  const sourceNamedUnavailable = buildSummaryArtifactKey({ ...summaryInput, evidence: { kind: 'versioned', version: 'unavailable' } }, limits);
  assert.notEqual(unavailable, sourceNamedUnavailable);
  assert.throws(() => buildSummaryArtifactKey({ ...summaryInput, evidence: { kind: 'unavailable', version: 'not-allowed' } } as never, limits), /not allowed/);
});

test('Pros/Cons interest-set identity is stable for all orderings and does not expose raw IDs', () => {
  const interests = ['ai', 'cloud', 'security'];
  const keys = allPermutations(interests).map((interestIds) => buildProsConsArtifactKey(prosConsInput({ interestIds }), limits));
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0], /^ti:v1:pros_cons:[a-f0-9]{64}$/);
  for (const rawInterestId of interests) assert.equal(keys[0].includes(rawInterestId), false);
});

test('Pros/Cons keys differ across persona, definition, taxonomy and interest-set changes', () => {
  const base = buildProsConsArtifactKey(prosConsInput(), limits);
  const variants: ProsConsArtifactKeyInput[] = [
    prosConsInput({ personaId: 'Founder' }),
    prosConsInput({ personaDefinitionVersion: 'persona-engineer-v3' }),
    prosConsInput({ interestTaxonomyVersion: 'taxonomy-v6' }),
    prosConsInput({ interestIds: ['ai', 'news'] }),
    prosConsInput({ outputLanguage: 'fr' }),
    prosConsInput({ postContentVersion: 'post-rev-5' }),
    prosConsInput({ evidence: { kind: 'versioned', version: 'evidence-rev-10' } }),
    prosConsInput({ generationDefinitionVersion: 'pros-cons-definition-v3' }),
    prosConsInput({ promptVersion: 'pros-cons-prompt-v4' }),
    prosConsInput({ outputSchemaVersion: 'pros-cons-schema-v2' }),
  ];
  for (const variant of variants) assert.notEqual(buildProsConsArtifactKey(variant, limits), base);
});

test('identity constructors reject user/provider/quota fields and malformed versions or bounds', () => {
  assert.throws(() => buildSummaryArtifactKey({ ...summaryInput, userId: 'synthetic-user' } as never, limits), /not allowed/);
  assert.throws(() => buildSummaryArtifactKey({ ...summaryInput, providerId: 'provider-x' } as never, limits), /not allowed/);
  assert.throws(() => buildSummaryArtifactKey({ ...summaryInput, personaId: 'Engineer' } as never, limits), /not allowed/);
  assert.throws(() => buildSummaryArtifactKey({ ...summaryInput, interestIds: ['ai'] } as never, limits), /not allowed/);
  assert.throws(() => buildProsConsArtifactKey({ ...prosConsInput(), quotaSubject: 'private-subject' } as never, limits), /not allowed/);
  const { postContentVersion: _postVersion, ...withoutPostVersion } = summaryInput;
  assert.throws(() => buildSummaryArtifactKey(withoutPostVersion as never, limits), /postContentVersion or contentHash/);
  assert.throws(() => buildProsConsArtifactKey(prosConsInput({ interestIds: ['ai', 'ai'] }), limits), /unique stable IDs/);
  assert.throws(() => buildProsConsArtifactKey(prosConsInput({ interestIds: ['a', 'b', 'c', 'd'] }), limits), /item bound/);
  assert.throws(() => buildSummaryArtifactKey({ ...summaryInput, postId: 'x'.repeat(129) }, limits), /string bound/);
  assert.throws(() => buildSummaryArtifactKey({ ...summaryInput, postContentVersion: 'x'.repeat(129) }, limits), /string bound/);
  assert.throws(() => buildSummaryArtifactKey(summaryInput, { ...limits, maxSerializedIdentityBytes: 1 }), /byte bound/);
  assert.throws(() => buildSummaryArtifactKey(summaryInput, {} as never), /positive safe integer/);
});
