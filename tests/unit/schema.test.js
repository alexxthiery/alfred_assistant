// Unit tests for bin/lib/schema.js. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const schema = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'schema.js'));
const {
  KNOWN_TYPES,
  ENTITY_KIND_TAGS,
  STALE_THRESHOLDS,
  STALE_DEFAULT_DAYS,
  SLUG_RE,
  validSlug,
  isReserved,
  parseSchemaContent,
  loadSchema,
  knownRelationVerbs,
} = schema;

// ─── closed-set constants ──────────────────────────────────────────────────

test('KNOWN_TYPES: exactly the 8 documented page types', () => {
  assert.equal(KNOWN_TYPES.size, 8);
  for (const t of ['entity', 'concept', 'decision', 'source', 'synthesis', 'todo', 'note', 'event']) {
    assert.ok(KNOWN_TYPES.has(t), `KNOWN_TYPES missing ${t}`);
  }
});

test('ENTITY_KIND_TAGS: 5 entity-kind markers', () => {
  assert.equal(ENTITY_KIND_TAGS.size, 5);
  for (const t of ['person', 'org', 'tool', 'paper', 'media']) {
    assert.ok(ENTITY_KIND_TAGS.has(t), `ENTITY_KIND_TAGS missing ${t}`);
  }
});

test('STALE_THRESHOLDS: shape — sorted ascending by days, tags non-empty', () => {
  assert.ok(STALE_THRESHOLDS.length > 0);
  let prev = -Infinity;
  for (const t of STALE_THRESHOLDS) {
    assert.ok(typeof t.days === 'number' && t.days > 0);
    assert.ok(Array.isArray(t.tags) && t.tags.length > 0);
    assert.ok(t.days >= prev, 'STALE_THRESHOLDS should be sorted by days');
    prev = t.days;
  }
});

test('STALE_DEFAULT_DAYS: positive number', () => {
  assert.equal(typeof STALE_DEFAULT_DAYS, 'number');
  assert.ok(STALE_DEFAULT_DAYS > 0);
});

// ─── slug helpers ──────────────────────────────────────────────────────────

test('SLUG_RE / validSlug: accepts well-formed slugs', () => {
  for (const ok of ['alice', 'bob-jones', 'a', '0abc', 'a-b-c-d', 'abc123']) {
    assert.ok(validSlug(ok), `should accept ${ok}`);
    assert.ok(SLUG_RE.test(ok));
  }
});

test('validSlug: rejects malformed slugs', () => {
  for (const bad of ['-alice', 'Alice', 'alice_smith', 'alice smith', '', 'alice.smith', 'alice/bob']) {
    assert.ok(!validSlug(bad), `should reject "${bad}"`);
  }
});

test('isReserved: catches index and log; everything else OK', () => {
  assert.ok(isReserved('index'));
  assert.ok(isReserved('log'));
  assert.ok(!isReserved('alice'));
  assert.ok(!isReserved('indexes'));
  assert.ok(!isReserved('logger'));
});

// ─── parseSchemaContent ────────────────────────────────────────────────────

test('parseSchemaContent: empty input returns empty-schema sentinel (tags===null)', () => {
  const out = parseSchemaContent('');
  assert.equal(out.tags, null);
  assert.ok(out.forbidden instanceof Set && out.forbidden.size === 0);
  assert.ok(out.symmetric instanceof Set && out.symmetric.size === 0);
  assert.ok(out.inverses instanceof Map && out.inverses.size === 0);
});

test('parseSchemaContent: non-string input returns empty-schema sentinel', () => {
  for (const bad of [null, undefined, 0, {}, []]) {
    const out = parseSchemaContent(bad);
    assert.equal(out.tags, null);
  }
});

test('parseSchemaContent: parses tag taxonomy code block', () => {
  const md = [
    '## Tag taxonomy',
    'Some prose.',
    '```',
    'person org',
    'tool paper',
    'event',
    '```',
    '',
  ].join('\n');
  const out = parseSchemaContent(md);
  assert.ok(out.tags instanceof Set);
  assert.deepEqual([...out.tags].sort(), ['event', 'org', 'paper', 'person', 'tool']);
});

test('parseSchemaContent: parses forbidden aggregator slugs', () => {
  const md = [
    '## Forbidden aggregator slugs',
    '```',
    'family people projects',
    '```',
    '',
  ].join('\n');
  const out = parseSchemaContent(md);
  assert.deepEqual([...out.forbidden].sort(), ['family', 'people', 'projects']);
});

test('parseSchemaContent: parses symmetric verbs and one-way verbs', () => {
  const md = [
    '## Relations',
    '### Symmetric',
    '```',
    'spouse_of sibling_of',
    'colleague_of',
    '```',
    '### One-way verbs',
    '```',
    'works_at located_in',
    '```',
    '',
  ].join('\n');
  const out = parseSchemaContent(md);
  assert.deepEqual([...out.symmetric].sort(), ['colleague_of', 'sibling_of', 'spouse_of']);
  assert.deepEqual([...out.oneWay].sort(), ['located_in', 'works_at']);
});

test('parseSchemaContent: parses inverse pairs (one pair per line, two tokens)', () => {
  const md = [
    '### Inverse pairs',
    '```',
    'parent_of child_of',
    'employs works_at',
    'malformed-line-with-one-token',
    'three tokens here',
    '```',
    '',
  ].join('\n');
  const out = parseSchemaContent(md);
  assert.equal(out.inverses.get('parent_of'), 'child_of');
  assert.equal(out.inverses.get('employs'), 'works_at');
  // Malformed lines are silently dropped:
  assert.equal(out.inverses.size, 2);
});

test('parseSchemaContent: parses event-keyword regex tokens', () => {
  const md = [
    '## Event-keyword title regex',
    '```',
    'meeting lunch dinner appointment',
    '```',
    '',
  ].join('\n');
  const out = parseSchemaContent(md);
  assert.deepEqual([...out.eventKeywords].sort(), ['appointment', 'dinner', 'lunch', 'meeting']);
});

test('parseSchemaContent: missing sections result in empty sets, not undefined', () => {
  // Only one section present; others should be empty Sets/Map.
  const md = '## Tag taxonomy\n```\nperson\n```\n';
  const out = parseSchemaContent(md);
  assert.ok(out.tags instanceof Set);
  assert.ok(out.forbidden instanceof Set);
  assert.ok(out.symmetric instanceof Set);
  assert.ok(out.inverses instanceof Map);
  assert.equal(out.forbidden.size, 0);
});

test('parseSchemaContent: ignores tokens that don\'t match the tag-name regex', () => {
  const md = [
    '## Tag taxonomy',
    '```',
    'person  -invalid  Has_Caps  ok-tag also_ok',
    '```',
    '',
  ].join('\n');
  const out = parseSchemaContent(md);
  assert.ok(out.tags.has('person'));
  assert.ok(out.tags.has('ok-tag'));
  assert.ok(out.tags.has('also_ok'));
  assert.ok(!out.tags.has('-invalid'));
  assert.ok(!out.tags.has('Has_Caps'));
});

// ─── loadSchema ────────────────────────────────────────────────────────────

test('loadSchema: missing path returns empty-schema sentinel', () => {
  const out = loadSchema('/definitely-does-not-exist-' + Date.now());
  assert.equal(out.tags, null);
});

test('loadSchema: reads + parses real test vault SCHEMA.md', () => {
  const p = path.resolve(__dirname, '..', 'vault', 'SCHEMA.md');
  const out = loadSchema(p);
  // Sanity: the test vault declares at least the common page-type tags.
  assert.ok(out.tags instanceof Set);
  assert.ok(out.tags.size > 0, 'tests/vault/SCHEMA.md should declare tags');
  assert.ok(out.tags.has('person'), '"person" tag should be declared in tests/vault/SCHEMA.md');
});

// ─── knownRelationVerbs ────────────────────────────────────────────────────

test('knownRelationVerbs: union of symmetric + oneWay + inverse-pair-keys-and-values', () => {
  const fake = {
    symmetric: new Set(['spouse_of', 'sibling_of']),
    oneWay: new Set(['works_at']),
    inverses: new Map([['parent_of', 'child_of'], ['employs', 'works_for']]),
  };
  const all = knownRelationVerbs(fake);
  for (const v of ['spouse_of', 'sibling_of', 'works_at', 'parent_of', 'child_of', 'employs', 'works_for']) {
    assert.ok(all.has(v), `knownRelationVerbs should contain ${v}`);
  }
  assert.equal(all.size, 7);
});

test('knownRelationVerbs: handles empty schema gracefully', () => {
  const empty = { symmetric: new Set(), oneWay: new Set(), inverses: new Map() };
  const all = knownRelationVerbs(empty);
  assert.equal(all.size, 0);
});
