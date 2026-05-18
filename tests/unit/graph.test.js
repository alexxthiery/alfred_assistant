// Unit tests for bin/lib/graph.js. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const graph = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'graph.js'));
const {
  aliasesOf,
  backlinkRegex,
  firstBodyLine,
  extractWikilinks,
  extractProvenanceMarkers,
  parseObservations,
  parseRelations,
  levenshtein,
  scoreSlugCandidates,
} = graph;

// ─── aliasesOf ─────────────────────────────────────────────────────────────

test('aliasesOf: undefined fm returns []', () => {
  assert.deepEqual(aliasesOf(undefined), []);
});

test('aliasesOf: fm with no aliases field returns []', () => {
  assert.deepEqual(aliasesOf({ title: 'X' }), []);
});

test('aliasesOf: fm.aliases as array passes through', () => {
  assert.deepEqual(aliasesOf({ aliases: ['Alice', 'Smith'] }), ['Alice', 'Smith']);
});

test('aliasesOf: fm.aliases as string wraps to single-element array', () => {
  // YAML round-trip can deliver `aliases: "Alice"` as a scalar string.
  assert.deepEqual(aliasesOf({ aliases: 'Alice' }), ['Alice']);
});

test('aliasesOf: returns the underlying array reference (caller must clone for mutation)', () => {
  // Document the contract — callers that intend to mutate use [...aliasesOf(fm)].
  const arr = ['A'];
  const out = aliasesOf({ aliases: arr });
  assert.equal(out, arr, 'same reference (not a clone)');
});

// ─── backlinkRegex ─────────────────────────────────────────────────────────

test('backlinkRegex: matches the canonical [[slug]] form', () => {
  const re = backlinkRegex('alice');
  assert.ok(re.test('see [[alice]] for details'));
  assert.equal(re.flags, '');
});

test('backlinkRegex: with `g` flag produces a global regex (for replace)', () => {
  const re = backlinkRegex('alice', 'g');
  assert.equal(re.flags, 'g');
  const out = 'see [[alice]] and [[alice]] twice'.replace(re, '[[bob]]');
  assert.equal(out, 'see [[bob]] and [[bob]] twice');
});

test('backlinkRegex: escapes regex specials in the slug (prophylactic for SLUG_RE loosening)', () => {
  // Today SLUG_RE forbids `.` `+` etc, but the escape protects against a
  // future loosening that would otherwise break every caller silently.
  const re = backlinkRegex('foo.bar');
  assert.ok(re.test('see [[foo.bar]]'));
  // Without escaping, `.` would match any char — the test value below would
  // false-positive on `foo-bar` etc. Confirm it does NOT match:
  assert.equal(re.test('see [[foo-bar]]'), false);
});

test('backlinkRegex: coerces non-string input to string', () => {
  // Defensive: callers occasionally pass slug-derived strings that may be
  // String-objects from older codepaths. Don't crash.
  const re = backlinkRegex('x');
  assert.ok(re.test('see [[x]]'));
});

// ─── firstBodyLine ─────────────────────────────────────────────────────────

test('firstBodyLine: returns first non-empty, non-heading, non-frontmatter line', () => {
  assert.equal(firstBodyLine('# Title\n\nfirst real line\nsecond'), 'first real line');
});

test('firstBodyLine: skips frontmatter delimiters', () => {
  assert.equal(firstBodyLine('---\nbody starts here\nmore'), 'body starts here');
});

test('firstBodyLine: returns empty string when body has no usable line', () => {
  assert.equal(firstBodyLine(''), '');
  assert.equal(firstBodyLine('# only heading\n# another'), '');
});

test('firstBodyLine: truncates to 120 chars', () => {
  const long = 'x'.repeat(200);
  assert.equal(firstBodyLine(long).length, 120);
});

// ─── extractWikilinks ──────────────────────────────────────────────────────

test('extractWikilinks: returns sorted unique slug set', () => {
  const body = 'See [[alice]] and [[bob-jones]] and again [[alice]].';
  assert.deepEqual(extractWikilinks(body), ['alice', 'bob-jones']);
});

test('extractWikilinks: empty body → empty array', () => {
  assert.deepEqual(extractWikilinks(''), []);
});

test('extractWikilinks: ignores malformed wikilinks', () => {
  const body = '[[ ]] [[InvalidCase]] [[-leading-dash]] [[valid-one]]';
  assert.deepEqual(extractWikilinks(body), ['valid-one']);
});

// ─── extractProvenanceMarkers ──────────────────────────────────────────────

test('extractProvenanceMarkers: catches each scheme', () => {
  const body = 'something ^[raw:foo/bar.md] and ^[telegram:123] and ^[conversation:abc]';
  const out = extractProvenanceMarkers(body);
  assert.equal(out.length, 3);
  assert.ok(out[0].startsWith('^[raw:'));
  assert.ok(out[1].startsWith('^[telegram:'));
});

test('extractProvenanceMarkers: empty body → empty array', () => {
  assert.deepEqual(extractProvenanceMarkers(''), []);
});

// ─── parseObservations ─────────────────────────────────────────────────────

test('parseObservations: parses basic fact', () => {
  const body = '- [fact] Alice is a person ^[telegram:1]\n- [hypothesis] Bob might be in Lisbon';
  const obs = parseObservations(body);
  assert.equal(obs.length, 2);
  assert.equal(obs[0].category, 'fact');
  assert.equal(obs[0].body, 'Alice is a person');
  assert.deepEqual(obs[0].provenance, ['telegram:1']);
  assert.equal(obs[1].category, 'hypothesis');
  assert.equal(obs[1].superseded, false);
});

test('parseObservations: extracts date tags', () => {
  const body = '- [fact] Joined [since 2024-01] and left [until 2025-06] ^[lab:hr]';
  const obs = parseObservations(body);
  assert.equal(obs[0].dates.since, '2024-01');
  assert.equal(obs[0].dates.until, '2025-06');
  // Cleaned body strips date tags + provenance:
  assert.equal(obs[0].body, 'Joined and left');
});

test('parseObservations: as-of becomes asOf', () => {
  const body = '- [hypothesis] Maybe Lisbon [as-of 2026-04]';
  const obs = parseObservations(body);
  assert.equal(obs[0].dates.asOf, '2026-04');
  assert.equal(obs[0].dates['as-of'], undefined);
});

test('parseObservations: marks strikethrough as superseded', () => {
  const body = '- ~~[fact] Was the case ~~[until 2025-06]';
  const obs = parseObservations(body);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].superseded, true);
});

test('parseObservations: parses prediction category', () => {
  const body = '- [prediction] X will happen by 2027-06 [confidence: 0.6] ^[telegram:1]';
  const obs = parseObservations(body);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].category, 'prediction');
  assert.deepEqual(obs[0].provenance, ['telegram:1']);
});

test('parseObservations: ignores non-observation list items', () => {
  const body = '- works_at [[example-corp]]\n- regular bullet\n- [fact] real';
  const obs = parseObservations(body);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].body, 'real');
});

test('parseObservations: empty body → empty array', () => {
  assert.deepEqual(parseObservations(''), []);
});

// ─── parseRelations ────────────────────────────────────────────────────────

test('parseRelations: parses bare-verb relations', () => {
  const body = '- works_at [[example-corp]]\n- spouse_of [[morgan-smith]]';
  const out = parseRelations(body);
  assert.deepEqual(out, [
    { verb: 'works_at', target: 'example-corp' },
    { verb: 'spouse_of', target: 'morgan-smith' },
  ]);
});

test('parseRelations: parses quoted multi-word verbs', () => {
  const body = '- "mentioned by" [[bob-jones]]\n- "is a kind of" [[mammal]]';
  const out = parseRelations(body);
  assert.equal(out.length, 2);
  assert.equal(out[0].verb, 'mentioned by');
  assert.equal(out[0].target, 'bob-jones');
});

test('parseRelations: ignores non-relation list items', () => {
  const body = '- [fact] this is an observation\n- works_at [[example-corp]]\n- bare bullet';
  const out = parseRelations(body);
  assert.equal(out.length, 1);
  assert.equal(out[0].verb, 'works_at');
});

test('parseRelations: empty body → empty array', () => {
  assert.deepEqual(parseRelations(''), []);
});

// ─── levenshtein ───────────────────────────────────────────────────────────

test('levenshtein: identical strings = 0', () => {
  assert.equal(levenshtein('alice', 'alice'), 0);
});

test('levenshtein: one substitution = 1', () => {
  assert.equal(levenshtein('alice', 'alyce'), 1);
});

test('levenshtein: insert/delete = 1', () => {
  assert.equal(levenshtein('alice', 'alices'), 1);
  assert.equal(levenshtein('alices', 'alice'), 1);
});

test('levenshtein: empty-string cases', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('levenshtein: completely different = max length', () => {
  assert.equal(levenshtein('abc', 'xyz'), 3);
});

// ─── scoreSlugCandidates ───────────────────────────────────────────────────

test('scoreSlugCandidates: exact slug → confidence 1.0', () => {
  const pages = [
    { slug: 'alice', title: 'Alice' },
    { slug: 'bob', title: 'Bob' },
  ];
  const out = scoreSlugCandidates('alice', pages);
  assert.equal(out[0].slug, 'alice');
  assert.equal(out[0].confidence, 1.0);
  assert.equal(out[0].reason, 'exact slug');
});

test('scoreSlugCandidates: exact-title (case-insensitive) → 0.95', () => {
  // Title must not normalize to the slug, or the 1.0 exact-slug branch wins
  // first. Acronym-style slugs (mcmc) with their full-form title are the
  // common real-world case where this matters.
  const pages = [{ slug: 'mcmc', title: 'Markov chain Monte Carlo' }];
  const out = scoreSlugCandidates('markov chain monte carlo', pages);
  assert.equal(out[0].confidence, 0.95);
  assert.ok(/exact title/.test(out[0].reason));
});

test('scoreSlugCandidates: alias match → 0.9', () => {
  const pages = [{ slug: 'mcmc', title: 'MCMC', aliases: ['Markov chain Monte Carlo'] }];
  const out = scoreSlugCandidates('markov chain monte carlo', pages);
  assert.equal(out[0].slug, 'mcmc');
  assert.equal(out[0].confidence, 0.9);
});

test('scoreSlugCandidates: substring match → 0.7', () => {
  const pages = [{ slug: 'alice-smith', title: 'Alice Smith' }];
  const out = scoreSlugCandidates('Alice', pages);
  assert.equal(out[0].confidence, 0.7);
});

test('scoreSlugCandidates: Levenshtein ≤2 → 0.5 / 0.4 / 0.3', () => {
  const pages = [{ slug: 'alyce', title: 'Alyce' }];
  // levenshtein("alyce","alice") = 1 → confidence 0.4
  const out = scoreSlugCandidates('alice', pages);
  assert.ok(out.length === 1, 'should match via Levenshtein');
  assert.ok(Math.abs(out[0].confidence - 0.4) < 1e-9);
  assert.ok(/Levenshtein/.test(out[0].reason));
});

test('scoreSlugCandidates: excludeSlug skips a page', () => {
  const pages = [
    { slug: 'alice', title: 'Alice' },
    { slug: 'bob', title: 'Bob' },
  ];
  const out = scoreSlugCandidates('alice', pages, { excludeSlug: 'alice' });
  assert.equal(out.length, 0);
});

test('scoreSlugCandidates: returns sorted by descending confidence', () => {
  const pages = [
    { slug: 'one', title: 'something' },     // no match
    { slug: 'two', title: 'Alyce' },         // levenshtein → 0.4
    { slug: 'three', title: 'alice-here' },  // substring → 0.7
    { slug: 'alice', title: 'Alice' },       // exact title → 0.95
  ];
  const out = scoreSlugCandidates('alice', pages);
  assert.equal(out[0].slug, 'alice');
  // Verify descending order:
  for (let i = 0; i < out.length - 1; i++) {
    assert.ok(out[i].confidence >= out[i + 1].confidence, 'must be sorted descending');
  }
});

test('scoreSlugCandidates: handles missing title/aliases gracefully', () => {
  const pages = [{ slug: 'lone' }];  // no title, no aliases
  const out = scoreSlugCandidates('lone', pages);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 1.0);  // matched by exact slug
});

test('scoreSlugCandidates: aliases-as-scalar-string is normalized to list', () => {
  // Mirrors the bin/wiki resolveSlugCandidates fallback for legacy data
  // where aliases sometimes lands as a single string after the YAML round-trip.
  const pages = [{ slug: 'mia', title: 'Mia', aliases: 'Maya Smith' }];
  const out = scoreSlugCandidates('maya smith', pages);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 0.9);
});

test('scoreSlugCandidates: empty pages list → empty result', () => {
  assert.deepEqual(scoreSlugCandidates('anything', []), []);
});
