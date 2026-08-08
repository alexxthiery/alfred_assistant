// Unit tests for bin/lib/autolink.js.
//
// Two pure functions:
//   buildTitleEntries(pages) — title/alias extraction + regex compilation
//   autolinkBody(body, ownSlug, titleMap) — per-page injection w/ fence
//                                            preservation, no-self-link,
//                                            first-mention-per-page
//
// See audit/13 § module-purity. autolink was previously inline in bin/wiki
// with no unit tests; the heuristic is fiddly (regex-special titles, fence
// preservation, alias precedence) so the cost of a regression there is high.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildTitleEntries, autolinkBody } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'autolink.js')
);

// ─── buildTitleEntries ─────────────────────────────────────────────────────

test('buildTitleEntries: extracts title + aliases', () => {
  const pages = [
    { slug: 'alice', fm: { title: 'Alice Smith', aliases: ['Alicia', 'A. Smith'] } },
  ];
  const entries = buildTitleEntries(pages);
  const titles = entries.map((e) => e.title).sort();
  assert.deepEqual(titles, ['A. Smith', 'Alice Smith', 'Alicia'].sort());
});

test('buildTitleEntries: filters out titles shorter than 4 chars', () => {
  // "Alice" passes (5), "Bob" fails (3).
  const pages = [
    { slug: 'alice', fm: { title: 'Alice' } },
    { slug: 'bob',   fm: { title: 'Bob' } },
  ];
  const entries = buildTitleEntries(pages);
  assert.deepEqual(entries.map((e) => e.slug), ['alice']);
});

test('buildTitleEntries: escapes regex special chars in titles', () => {
  // A title like "C++" must not be compiled as a literal `+` quantifier.
  const pages = [{ slug: 'cpp', fm: { title: 'C++ Language' } }];
  const entries = buildTitleEntries(pages);
  assert.equal(entries.length, 1);
  // Should match "C++ Language" literally
  assert.ok(entries[0].pattern.test('We use C++ Language at work'));
  // Reset lastIndex (the .test() side effect on /g regex)
  entries[0].pattern.lastIndex = 0;
  // Should NOT match because of the literal + (i.e., not treating + as quantifier)
  assert.equal(entries[0].pattern.test('CCC Language'), false);
});

test('buildTitleEntries: handles string-form aliases (not just arrays)', () => {
  // YAML can produce either a string or an array depending on syntax.
  const pages = [
    { slug: 'alice', fm: { title: 'Alice Smith', aliases: 'Alice Jones' } },
  ];
  const entries = buildTitleEntries(pages);
  assert.equal(entries.length, 2);
  assert.ok(entries.some((e) => e.title === 'Alice Smith'));
  assert.ok(entries.some((e) => e.title === 'Alice Jones'));
});

test('buildTitleEntries: word-boundary regex (no partial-substring matches)', () => {
  const pages = [{ slug: 'apple', fm: { title: 'Apple Inc' } }];
  const entries = buildTitleEntries(pages);
  // Match: "Apple Inc rocks"
  assert.ok(entries[0].pattern.test('Apple Inc rocks'));
  entries[0].pattern.lastIndex = 0;
  // No match: "Pineapple Inc rocks" — \bApple\b doesn't follow 'pine'
  assert.equal(entries[0].pattern.test('Pineapple Inc rocks'), false);
});

test('buildTitleEntries: empty/whitespace titles excluded', () => {
  const pages = [
    { slug: 'a', fm: { title: '' } },
    { slug: 'b', fm: { title: '   ' } },
    { slug: 'c', fm: { title: undefined } },
  ];
  assert.deepEqual(buildTitleEntries(pages), []);
});

// ─── autolinkBody ──────────────────────────────────────────────────────────

function tm(...entries) {
  // Test-helper: build a titleMap from {slug, title} pairs.
  return entries.map(([slug, title]) => ({
    slug,
    title,
    pattern: new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
  }));
}

test('autolinkBody: replaces a bare title with a wikilink', () => {
  const out = autolinkBody('I work with Alice Smith daily.\n', 'me', tm(['alice', 'Alice Smith']));
  assert.equal(out.injections, 1);
  assert.match(out.body, /\[\[alice\]\]/);
  assert.equal(out.body.includes('Alice Smith'), false);
});

test('autolinkBody: skips ownSlug (no self-link)', () => {
  const out = autolinkBody('My name is Alice Smith.\n', 'alice', tm(['alice', 'Alice Smith']));
  assert.equal(out.injections, 0);
  assert.ok(out.body.includes('Alice Smith'));
});

test('autolinkBody: first-mention-per-page only (not every mention)', () => {
  const body = 'Alice Smith spoke. Then Alice Smith left. Alice Smith returned.\n';
  const out = autolinkBody(body, 'me', tm(['alice', 'Alice Smith']));
  assert.equal(out.injections, 1);
  // First "Alice Smith" → [[alice]]; subsequent stay literal.
  assert.equal((out.body.match(/Alice Smith/g) || []).length, 2);
  assert.equal((out.body.match(/\[\[alice\]\]/g) || []).length, 1);
});

test('autolinkBody: does NOT inject inside a code fence', () => {
  const body = [
    'Here is some prose mentioning Alice Smith.',
    '```',
    'code: Alice Smith inside the fence',
    '```',
    'More prose with Alice Smith again.',
    '',
  ].join('\n');
  const out = autolinkBody(body, 'me', tm(['alice', 'Alice Smith']));
  // First mention (in prose) gets linked. The next prose "Alice Smith" should
  // be skipped under first-mention-per-page semantics. The fenced line stays
  // literal regardless.
  assert.equal(out.injections, 1);
  assert.ok(out.body.includes('code: Alice Smith inside the fence'),
    'fenced code should be untouched');
});

test('autolinkBody: does not re-link text already inside [[...]]', () => {
  const body = 'See [[alice]] for context. Alice Smith is the page title.\n';
  const out = autolinkBody(body, 'me', tm(['alice', 'Alice Smith']));
  // The first "alice" is already inside [[...]] so it doesn't count; the next
  // bare mention "Alice Smith" should get linked.
  assert.equal(out.injections, 1);
  assert.match(out.body, /\[\[alice\]\] for context\. \[\[alice\]\] is the page title\./);
});

test('autolinkBody: respects multiple distinct slugs', () => {
  const body = 'Alice Smith met Bob Jones at the conference.\n';
  const out = autolinkBody(body, 'me', tm(
    ['alice', 'Alice Smith'],
    ['bob',   'Bob Jones'],
  ));
  assert.equal(out.injections, 2);
  assert.match(out.body, /\[\[alice\]\].*\[\[bob\]\]/);
});

test('autolinkBody: handles regex-special title at injection time', () => {
  // "C++ Language" must replace the literal text, not be interpreted as regex.
  const body = 'I write C++ Language code daily.\n';
  const out = autolinkBody(body, 'me', tm(['cpp', 'C++ Language']));
  assert.equal(out.injections, 1);
  assert.match(out.body, /\[\[cpp\]\]/);
  assert.equal(out.body.includes('C++ Language'), false);
});

test('autolinkBody: empty titleMap → no injections (body content preserved modulo trailing newline)', () => {
  // Note: the splitter+rejoiner can add a trailing newline because
  // body.split('\n') on "foo\n" yields ["foo", ""] and each segment gets
  // "\n" appended on rejoin. The contract pinned here is *no replacement
  // when titleMap is empty*; the trailing-newline quirk is documented
  // existing behavior (predates this extraction).
  const body = 'Just some prose.\n';
  const out = autolinkBody(body, 'me', []);
  assert.equal(out.injections, 0);
  assert.ok(out.body.startsWith('Just some prose.'));
  assert.equal(out.body.includes('[['), false);
});

test('autolinkBody: multi-line prose, multiple titles, single fence in middle', () => {
  const body = [
    'First line mentions Alice Smith.',
    '```',
    'fence Alice Smith Bob Jones',
    '```',
    'After the fence: Bob Jones is here.',
    '',
  ].join('\n');
  const out = autolinkBody(body, 'me', tm(
    ['alice', 'Alice Smith'],
    ['bob',   'Bob Jones'],
  ));
  // Alice Smith (prose, before fence) → linked once.
  // Bob Jones (prose, after fence) → linked once.
  // Both names inside fence → untouched.
  assert.equal(out.injections, 2);
  assert.ok(out.body.includes('fence Alice Smith Bob Jones'), 'fence content preserved');
});

// ─── G1: no nested-link corruption (P0) ──────────────────────────────────────

test('autolinkBody: alias matching a hyphen-fragment of a longer slug does NOT corrupt it', () => {
  // Page "value-function-expected-discounted-return" has alias "value-function".
  // A body citing the unrelated slug [[hjb-value-function-log-h]] must be left
  // untouched — no nested [[hjb-[[...]]-log-h]].
  const titleMap = buildTitleEntries([
    { slug: 'value-function-expected-discounted-return', fm: { title: 'Value function', aliases: ['value-function'] } },
  ]);
  const body = '- instance_of [[hjb-value-function-log-h]]\n';
  const out = autolinkBody(body, 'some-other-page', titleMap);
  assert.equal(out.injections, 0, 'must not inject inside an existing wikilink target');
  assert.ok(out.body.includes('[[hjb-value-function-log-h]]'), 'original link intact');
  assert.equal(/\[\[[^\]]*\[\[/.test(out.body), false, 'no nested [[ pattern');
});

test('autolinkBody: a short alias is not injected into the middle of a longer hyphenated slug', () => {
  // alias "alpha" must NOT match the "alpha" inside the slug [[one-alpha-two]].
  const titleMap = buildTitleEntries([
    { slug: 'alpha', fm: { title: 'Alpha', aliases: [] } },
  ]);
  const body = '- related_to [[one-alpha-two]]\n';
  const out = autolinkBody(body, 'some-page', titleMap);
  assert.equal(out.injections, 0);
  assert.ok(out.body.includes('[[one-alpha-two]]'), 'original link intact');
  assert.equal(/\[\[[^\]]*\[\[/.test(out.body), false, 'no nested [[ pattern');
});

test('autolinkBody: a legitimate whole-token mention is still linked (no over-correction)', () => {
  const titleMap = buildTitleEntries([
    { slug: 'value-function-expected-discounted-return', fm: { title: 'Value function', aliases: ['value-function'] } },
  ]);
  const body = 'The value-function is the discounted return.\n';
  const out = autolinkBody(body, 'some-other-page', titleMap);
  assert.equal(out.injections, 1, 'standalone whole-token mention links');
  assert.ok(out.body.includes('[[value-function-expected-discounted-return]]'));
});

// ─── V1: over-linking — generic-alias exclusion + self-subject guard ─────────

test('buildTitleEntries: a generic alias is NOT an autolink anchor; the title still is', () => {
  const tm = buildTitleEntries([
    { slug: 'bellman-optimality-control', fm: { title: 'Bellman optimality control problem', aliases: ['optimal policy'] } },
  ]);
  // No entry whose title is the generic alias "optimal policy".
  assert.equal(tm.some((e) => e.title === 'optimal policy'), false);
  // The canonical title is still an anchor.
  assert.ok(tm.some((e) => e.title === 'Bellman optimality control problem'));
});

test('buildTitleEntries: lowercase person aliases get title-case anchors', () => {
  const tm = buildTitleEntries([
    { slug: 'personone-card', fm: { title: 'Personone Card', type: 'entity', tags: ['person'], aliases: ['personone'] } },
    { slug: 'persontwo-card', fm: { title: 'persontwo', type: 'entity', tags: ['person'], aliases: [] } },
  ]);
  assert.ok(tm.some((e) => e.slug === 'personone-card' && e.title === 'Personone'));
  assert.ok(tm.some((e) => e.slug === 'persontwo-card' && e.title === 'Persontwo'));
  assert.equal(tm.some((e) => e.title === 'personone'), false, 'lowercase generic form remains excluded');
});

test('autolinkBody: title-case person mention from lowercase alias links', () => {
  const tm = buildTitleEntries([
    { slug: 'personone-card', fm: { title: 'Personone Card', type: 'entity', tags: ['person'], aliases: ['personone'] } },
  ]);
  const out = autolinkBody('Personone performs intellectual sophistication.\n', 'identity-note', tm);
  assert.equal(out.injections, 1);
  assert.ok(out.body.includes('[[personone-card]] performs'));
});

test('autolinkBody: generic-alias phrase in prose is left untouched (V1)', () => {
  const tm = buildTitleEntries([
    { slug: 'bellman-optimality-control', fm: { title: 'Bellman optimality control problem', aliases: ['optimal policy'] } },
  ]);
  const out = autolinkBody('the optimal policy obeys the equation.\n', 'some-card', tm);
  assert.equal(out.injections, 0, 'generic phrase must not be linked');
});

test('autolinkBody: a phrase naming THIS page is not linked to another card (V1 self-subject)', () => {
  const tm = buildTitleEntries([
    { slug: 'sibling-card', fm: { title: 'Sibling card', aliases: ['successor-measure-gamma'] } },
  ]);
  // Processing a card whose OWN subject term is "successor-measure-gamma".
  const out = autolinkBody('the successor-measure-gamma is the object.\n', 'my-card', tm, ['successor-measure-gamma']);
  assert.equal(out.injections, 0, 'own subject term must not be linked away');
});

test('autolinkBody: a distinctive alias still links on a NON-own card (no over-correction)', () => {
  const tm = buildTitleEntries([
    { slug: 'sibling-card', fm: { title: 'Sibling card', aliases: ['successor-measure-gamma'] } },
  ]);
  const out = autolinkBody('we use successor-measure-gamma here.\n', 'unrelated', tm, ['unrelated terms']);
  assert.equal(out.injections, 1);
  assert.ok(out.body.includes('[[sibling-card]]'));
});
