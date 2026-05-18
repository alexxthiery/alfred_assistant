// Unit tests for bin/lib/frontmatter.js.
// Run with: node --test tests/unit/
// Or:       npm run test:unit

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fm = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'frontmatter.js'));
const {
  parseFrontmatter,
  serializeFrontmatter,
  migratePage,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
} = fm;

// ─── parseFrontmatter ──────────────────────────────────────────────────────

test('parseFrontmatter: returns empty fm for content with no frontmatter block', () => {
  const out = parseFrontmatter('just a body');
  assert.deepEqual(out, { fm: {}, body: 'just a body', malformed: false });
});

test('parseFrontmatter: parses scalar fields', () => {
  const input = '---\nid: alice\ntitle: Alice\ntype: entity\n---\nbody here\n';
  const { fm: parsed, body } = parseFrontmatter(input);
  assert.equal(parsed.id, 'alice');
  assert.equal(parsed.title, 'Alice');
  assert.equal(parsed.type, 'entity');
  assert.equal(body, 'body here\n');
});

test('parseFrontmatter: parses bracket-list values into arrays', () => {
  const input = '---\ntags: [person, friend, work]\n---\n';
  const { fm: parsed } = parseFrontmatter(input);
  assert.deepEqual(parsed.tags, ['person', 'friend', 'work']);
});

test('parseFrontmatter: empty list parses to empty array', () => {
  const input = '---\ntags: []\n---\n';
  const { fm: parsed } = parseFrontmatter(input);
  assert.deepEqual(parsed.tags, []);
});

test('parseFrontmatter: preserves unknown keys', () => {
  const input = '---\nid: x\ncustom_field: hello world\n---\n';
  const { fm: parsed } = parseFrontmatter(input);
  assert.equal(parsed.custom_field, 'hello world');
});

test('parseFrontmatter: separates body cleanly even when body contains "---"', () => {
  const input = '---\nid: x\n---\nbody line 1\n---\nbody line 3\n';
  const { fm: parsed, body } = parseFrontmatter(input);
  assert.equal(parsed.id, 'x');
  assert.equal(body, 'body line 1\n---\nbody line 3\n');
});

// ─── HR06: malformed-frontmatter detection ─────────────────────────────────

test('parseFrontmatter: bare-body page is malformed:false (legal — no FM block)', () => {
  const out = parseFrontmatter('just a body line\nmore body\n');
  assert.equal(out.malformed, false);
  assert.deepEqual(out.fm, {});
});

test('parseFrontmatter: opened-but-never-closed FM block is malformed:true', () => {
  // The hazard from audit/12 § parser-robustness: page started with --- and a
  // line of frontmatter, but the closing --- got truncated. Today this parses
  // as {fm:{}, body: <everything>}, indistinguishable from a bare-body page —
  // a subsequent re-serialize would silently drop all the original metadata.
  // HR06: malformed:true so the write-path can refuse.
  const input = '---\nid: alice\ntitle: Alice\n(no closing fence)\nbody continues\n';
  const out = parseFrontmatter(input);
  assert.equal(out.malformed, true);
  assert.deepEqual(out.fm, {}, 'no FM extracted on malformed input');
});

test('parseFrontmatter: --- followed by CRLF still detected as malformed', () => {
  const input = '---\r\nid: x\nno close\n';
  const out = parseFrontmatter(input);
  assert.equal(out.malformed, true);
});

test('parseFrontmatter: well-formed FM block is malformed:false', () => {
  const out = parseFrontmatter('---\nid: x\n---\nbody\n');
  assert.equal(out.malformed, false);
  assert.equal(out.fm.id, 'x');
});

// ─── serializeFrontmatter ──────────────────────────────────────────────────

test('serializeFrontmatter: stamps schema_version on unversioned input', () => {
  const input = { id: 'alice', title: 'Alice', type: 'entity' };
  const out = serializeFrontmatter(input, 'body');
  assert.match(out, /schema_version: 1/);
  // serializer mutates input by H07 design — confirmed.
  assert.equal(input.schema_version, CURRENT_SCHEMA_VERSION);
});

test('serializeFrontmatter: does not overwrite existing schema_version', () => {
  const input = { id: 'x', schema_version: 5 };
  const out = serializeFrontmatter(input, '');
  assert.match(out, /schema_version: 5/);
});

test('serializeFrontmatter: emits ordered fields in canonical order', () => {
  const input = {
    summary: 'one-line',  // extra — should land after schema_version
    title: 'T',
    tags: ['a', 'b'],
    id: 'x',
    type: 'entity',
    created: '2026-05-17',
    updated: '2026-05-17T00:00:00Z',
  };
  const out = serializeFrontmatter(input, '');
  const lines = out.split('\n');
  const idLine = lines.findIndex((l) => l.startsWith('id:'));
  const titleLine = lines.findIndex((l) => l.startsWith('title:'));
  const typeLine = lines.findIndex((l) => l.startsWith('type:'));
  const createdLine = lines.findIndex((l) => l.startsWith('created:'));
  const updatedLine = lines.findIndex((l) => l.startsWith('updated:'));
  const tagsLine = lines.findIndex((l) => l.startsWith('tags:'));
  const schemaLine = lines.findIndex((l) => l.startsWith('schema_version:'));
  const summaryLine = lines.findIndex((l) => l.startsWith('summary:'));
  // Canonical order: id, title, type, created, updated, tags, schema_version, then extras
  assert.ok(idLine < titleLine && titleLine < typeLine, 'id < title < type');
  assert.ok(typeLine < createdLine && createdLine < updatedLine, 'type < created < updated');
  assert.ok(updatedLine < tagsLine && tagsLine < schemaLine, 'updated < tags < schema_version');
  assert.ok(schemaLine < summaryLine, 'schema_version < summary (extras)');
});

test('serializeFrontmatter: serializes list values with bracket syntax', () => {
  const input = { id: 'x', tags: ['person', 'friend'] };
  const out = serializeFrontmatter(input, '');
  assert.match(out, /tags: \[person, friend\]/);
});

test('serializeFrontmatter: round-trips through parse', () => {
  const original = {
    id: 'alice',
    title: 'Alice',
    type: 'entity',
    created: '2026-05-17',
    updated: '2026-05-17T00:00:00Z',
    tags: ['person', 'family'],
    summary: 'family member',
  };
  const text = serializeFrontmatter({ ...original }, 'body content\n');
  const { fm: parsed, body } = parseFrontmatter(text);
  assert.equal(parsed.id, original.id);
  assert.equal(parsed.title, original.title);
  assert.deepEqual(parsed.tags, original.tags);
  assert.equal(parsed.summary, original.summary);
  assert.equal(String(parsed.schema_version), String(CURRENT_SCHEMA_VERSION));
  assert.equal(body, 'body content\n');
});

test('serializeFrontmatter: strips leading blank lines from body', () => {
  const out = serializeFrontmatter({ id: 'x' }, '\n\n\nactual body\n');
  assert.equal(out.split('---').slice(2).join('---'), '\nactual body\n');
});

// ─── migratePage ───────────────────────────────────────────────────────────

test('migratePage: unversioned page is stamped to current', () => {
  const { fm: outFm, fromVersion, toVersion } = migratePage({ id: 'x' }, 'body');
  assert.equal(fromVersion, 1);
  assert.equal(toVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(outFm.schema_version, CURRENT_SCHEMA_VERSION);
});

test('migratePage: page already at current is unchanged', () => {
  const { fm: outFm, fromVersion } = migratePage(
    { id: 'x', schema_version: CURRENT_SCHEMA_VERSION },
    'body'
  );
  assert.equal(fromVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(outFm.schema_version, CURRENT_SCHEMA_VERSION);
});

test('migratePage: page with version > current throws NEWER_CLI', () => {
  assert.throws(
    () => migratePage({ id: 'x', schema_version: 999 }, ''),
    (e) => e.code === 'NEWER_CLI' && /999 > current/.test(e.message)
  );
});

test('migratePage: bad schema_version throws', () => {
  assert.throws(
    () => migratePage({ id: 'x', schema_version: 'banana' }, ''),
    /bad schema_version/
  );
  assert.throws(
    () => migratePage({ id: 'x', schema_version: -1 }, ''),
    /bad schema_version/
  );
});

test('migratePage: HR08 — applies a registered transform end-to-end (1→2 via opts)', () => {
  // HR08: opts.currentVersion + opts.migrations let tests exercise the chain
  // without bumping the module-level CURRENT_SCHEMA_VERSION constant.
  const migrations = {
    1: ({ fm, body }) => { fm.migrated_marker = 'yes'; return { fm, body }; },
  };
  const { fm: outFm, fromVersion, toVersion } = migratePage(
    { id: 'x' }, 'body',
    { currentVersion: 2, migrations },
  );
  assert.equal(fromVersion, 1);
  assert.equal(toVersion, 2);
  assert.equal(outFm.schema_version, 2);
  assert.equal(outFm.migrated_marker, 'yes');
});

test('migratePage: HR08 — multi-step chain (1→2→3) runs every transform', () => {
  const migrations = {
    1: ({ fm, body }) => { fm.step1 = true; return { fm, body }; },
    2: ({ fm, body }) => { fm.step2 = true; return { fm, body }; },
  };
  const { fm: outFm, toVersion } = migratePage(
    { id: 'x' }, '',
    { currentVersion: 3, migrations },
  );
  assert.equal(toVersion, 3);
  assert.equal(outFm.step1, true);
  assert.equal(outFm.step2, true);
});

test('migratePage: HR08 — page already at currentVersion (via opts) runs zero transforms', () => {
  const migrations = { 1: () => { throw new Error('should not run'); } };
  const { fm: outFm, fromVersion, toVersion } = migratePage(
    { id: 'x', schema_version: 2 }, '',
    { currentVersion: 2, migrations },
  );
  assert.equal(fromVersion, 2);
  assert.equal(toVersion, 2);
  assert.equal(outFm.schema_version, 2);
});

test('migratePage: HR08 — opts.currentVersion=3 + page=999 throws NEWER_CLI', () => {
  assert.throws(
    () => migratePage({ id: 'x', schema_version: 999 }, '', { currentVersion: 3 }),
    (e) => e.code === 'NEWER_CLI' && /999 > current 3/.test(e.message),
  );
});

test('migratePage: HR08 — missing migration in the gap throws clearly', () => {
  // Now testable via opts: pretend the module is at CURRENT=2 but no 1→2
  // migration is registered. The walker should throw with the gap pinpointed.
  assert.throws(
    () => migratePage({ id: 'x' }, '', { currentVersion: 2, migrations: {} }),
    /no migration registered for schema_version 1 → 2/,
  );
});
