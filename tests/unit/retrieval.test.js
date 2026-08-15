'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  queryTokens,
  labelMatch,
  coverageForText,
  confidenceForCandidate,
  rankRetrievalCandidates,
} = require('../../bin/lib/retrieval.js');

test('queryTokens drops question boilerplate but keeps content words', () => {
  assert.deepEqual(queryTokens('What do I know about Ronald Fisher?'), ['know', 'ronald', 'fisher']);
});

test('labelMatch treats an exact title match as strong identity evidence', () => {
  const page = { slug: 'ronald-fisher', fm: { title: 'Ronald Fisher', aliases: ['Fisher'] } };
  const m = labelMatch('Ronald Fisher', page);
  assert.equal(m.strong, true);
  assert.equal(m.via, 'title-exact');
  assert.equal(m.coverage, 1);
});

test('labelMatch handles aliases and slug words without substring false positives', () => {
  const page = { slug: 'go-game', fm: { title: 'Go', aliases: ['baduk'] } };
  assert.equal(labelMatch('baduk', page).strong, true);
  assert.equal(labelMatch('ago', page), null);
});

test('coverageForText measures query-word coverage independently of BM25 score', () => {
  const c = coverageForText('Morgan Alice relation', 'Morgan visited Springfield and later met Alice.');
  assert.equal(c.coverage, 2 / 3);
  assert.deepEqual(c.matchedTokens, ['morgan', 'alice']);
  assert.deepEqual(c.missingTokens, ['relation']);
});

test('confidenceForCandidate accepts exact labels even when body is empty', () => {
  const c = confidenceForCandidate(
    'Ronald Fisher',
    { slug: 'ronald-fisher', fm: { title: 'Ronald Fisher' }, body: '' },
  );
  assert.equal(c.confident, true);
  assert.equal(c.reason, 'title-exact');
});

test('confidenceForCandidate rejects weak multi-token body coincidences', () => {
  const c = confidenceForCandidate(
    'school visit deadline',
    { slug: 'decoy', fm: { title: 'Unrelated' }, body: 'The deadline moved.' },
    { threshold: 0.5 },
  );
  assert.equal(c.confident, false);
  assert.equal(c.reason, 'low-coverage');
  assert.deepEqual(c.missingTokens, ['school', 'visit']);
});

test('rankRetrievalCandidates puts exact identity hits ahead of mention-heavy body hits', () => {
  const rows = rankRetrievalCandidates('Ronald Fisher', [
    {
      slug: 'mentions-fisher',
      fm: { title: 'Statistics Reading Notes' },
      body: 'Ronald Fisher appears in this paragraph. Fisher appears again.',
    },
    {
      slug: 'ronald-fisher',
      fm: { title: 'Ronald Fisher' },
      body: '',
    },
  ]);
  assert.equal(rows[0].slug, 'ronald-fisher');
  assert.equal(rows[0].via, 'title-exact');
});
