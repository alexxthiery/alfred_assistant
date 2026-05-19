// Unit tests for bin/lib/synonyms.js — parses a small SYNONYMS.md file and
// expands a query string at retrieval time.
//
// API design note: the plan originally sketched a boolean-syntax expansion
// ("(a OR b) AND c") but DuckDB's `match_bm25` tokenizes its input as a flat
// bag-of-tokens — there is no AND/OR. So `expandQuery` returns a flat
// space-separated string of canonical-form tokens, which is what BM25 actually
// consumes. Simpler+robust than implementing a boolean wrapper.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSynonymsFile, expandQuery } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'synonyms.js'),
);

// ─── parseSynonymsFile ─────────────────────────────────────────────────────

test('parseSynonymsFile on empty input returns empty Map', () => {
  const m = parseSynonymsFile('');
  assert.ok(m instanceof Map);
  assert.equal(m.size, 0);
});

test('parseSynonymsFile on "school = class, classroom" returns Map(school → [class, classroom])', () => {
  const m = parseSynonymsFile('school = class, classroom');
  assert.deepEqual(m.get('school'), ['class', 'classroom']);
});

test('parseSynonymsFile is case-insensitive on keys; canonical key is lowercase', () => {
  const m = parseSynonymsFile('SCHOOL = Class, Classroom');
  assert.deepEqual(m.get('school'), ['class', 'classroom']);
  // No upper-case key lingers.
  assert.equal(m.get('SCHOOL'), undefined);
});

test('parseSynonymsFile ignores comment lines starting with #', () => {
  const text = '# this is a comment\nschool = class\n# trailing comment';
  const m = parseSynonymsFile(text);
  assert.equal(m.size, 1);
  assert.deepEqual(m.get('school'), ['class']);
});

test('parseSynonymsFile skips blank lines and trims whitespace around tokens', () => {
  const text = '\n  school   =   class ,  classroom  \n\nteacher = instructor\n';
  const m = parseSynonymsFile(text);
  assert.deepEqual(m.get('school'), ['class', 'classroom']);
  assert.deepEqual(m.get('teacher'), ['instructor']);
});

test('parseSynonymsFile silently skips malformed lines (no = sign)', () => {
  const text = 'school = class\nthis line has no equals sign\nteacher = instructor';
  const m = parseSynonymsFile(text);
  assert.equal(m.size, 2);
  assert.ok(m.has('school'));
  assert.ok(m.has('teacher'));
});

// ─── expandQuery ───────────────────────────────────────────────────────────

test('expandQuery returns the query unchanged when no synonyms match', () => {
  const syns = parseSynonymsFile('school = class, classroom');
  assert.equal(expandQuery('unrelated', syns), 'unrelated');
});

test('expandQuery appends synonyms to a single-word query', () => {
  const syns = parseSynonymsFile('school = class, classroom');
  // The first token should be the canonical input term; the synonyms follow.
  // Token order within the expansion is not asserted (BM25 is order-agnostic).
  const out = expandQuery('school', syns);
  const tokens = out.split(/\s+/);
  assert.deepEqual(new Set(tokens), new Set(['school', 'class', 'classroom']));
});

test('expandQuery expands each word in a multi-word query independently', () => {
  const syns = parseSynonymsFile('school = class, classroom\nvisit = trip');
  const out = expandQuery('school visit', syns);
  const tokens = out.split(/\s+/);
  // Every input term + every synonym is present.
  for (const t of ['school', 'class', 'classroom', 'visit', 'trip']) {
    assert.ok(tokens.includes(t), `expected token "${t}" in expansion, got: ${out}`);
  }
});

test('expandQuery is case-insensitive on input lookup', () => {
  const syns = parseSynonymsFile('school = class, classroom');
  // Capitalised input still triggers expansion.
  const out = expandQuery('School', syns);
  const tokens = out.split(/\s+/);
  assert.ok(tokens.includes('class'));
  assert.ok(tokens.includes('classroom'));
});

test('expandQuery handles empty input gracefully', () => {
  const syns = parseSynonymsFile('school = class');
  assert.equal(expandQuery('', syns), '');
});

test('expandQuery on null/undefined synonyms Map returns the query lowercased', () => {
  // Defensive: caller may pass null when no synonyms file is present.
  assert.equal(expandQuery('school visit', null), 'school visit');
  assert.equal(expandQuery('school visit', undefined), 'school visit');
});
