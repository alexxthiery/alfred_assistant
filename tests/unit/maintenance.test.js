// Unit tests for bin/lib/maintenance.js.
//
// Three small pure cores: formatIndex (wiki/index.md generator),
// formatLogLine (wiki/log.md line emitter), applyExtraFrontmatter (FM mutator
// from CLI args). These previously lived inline in bin/wiki with no unit
// tests; the index format and log line shape are agent-observable, so pinning
// them prevents surprise drift.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { formatIndex, formatLogLine, applyExtraFrontmatter } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'maintenance.js')
);

// ─── formatIndex ───────────────────────────────────────────────────────────

test('formatIndex: empty pages → "(empty)" marker', () => {
  const out = formatIndex([], { now: '2026-05-18T12:00:00Z' });
  assert.match(out, /^# Wiki Index/);
  assert.ok(out.includes('_(empty)_'));
  assert.ok(out.includes('_Regenerated 2026-05-18T12:00:00Z_'));
});

test('formatIndex: one page per type, multiple types alphabetical', () => {
  const pages = [
    { slug: 'alice', fm: { title: 'Alice', type: 'entity' }, body: 'A short summary.\nMore prose.' },
    { slug: 'bob',   fm: { title: 'Bob',   type: 'concept' }, body: 'Concept summary.\n' },
  ];
  const out = formatIndex(pages, { now: 'X' });
  // Sections appear alphabetically: concept before entity.
  const conceptIdx = out.indexOf('## concept');
  const entityIdx  = out.indexOf('## entity');
  assert.ok(conceptIdx >= 0 && entityIdx >= 0, 'both sections present');
  assert.ok(conceptIdx < entityIdx, 'concept section comes before entity (alphabetical)');
  assert.ok(out.includes('- [[alice]] — Alice: A short summary.'));
  assert.ok(out.includes('- [[bob]] — Bob: Concept summary.'));
});

test('formatIndex: fm.id overrides file slug', () => {
  const pages = [
    { slug: 'old-name', fm: { id: 'new-name', title: 'T', type: 'note' }, body: '' },
  ];
  const out = formatIndex(pages, { now: '' });
  assert.ok(out.includes('[[new-name]]'));
  assert.equal(out.includes('[[old-name]]'), false);
});

test('formatIndex: missing fm.title falls back to slug', () => {
  const pages = [{ slug: 'x', fm: { type: 'note' }, body: '' }];
  const out = formatIndex(pages, { now: '' });
  assert.ok(out.includes('[[x]] — x'));
});

test('formatIndex: missing fm.type defaults to "note"', () => {
  const pages = [{ slug: 'x', fm: { title: 'X' }, body: '' }];
  const out = formatIndex(pages, { now: '' });
  assert.ok(out.includes('## note'));
});

test('formatIndex: empty body → no trailing ": <summary>"', () => {
  const pages = [{ slug: 'x', fm: { title: 'X', type: 'note' }, body: '' }];
  const out = formatIndex(pages, { now: '' });
  // Line ends after the title (no `: ...` tail).
  assert.match(out, /- \[\[x\]\] — X(?!:)/);
});

// ─── formatLogLine ─────────────────────────────────────────────────────────

test('formatLogLine: pins the exact line shape', () => {
  const line = formatLogLine('2026-05-18 12:34:56', 'merge', 'a -> b');
  assert.equal(line, '## [2026-05-18 12:34:56] merge | a -> b\n');
});

test('formatLogLine: trailing newline is included', () => {
  assert.match(formatLogLine('t', 'o', 'd'), /\n$/);
});

test('formatLogLine: detail with pipe character is preserved literally', () => {
  // No escaping of `|`; the format is loose. Document the current contract.
  const line = formatLogLine('t', 'op', 'a | b');
  assert.equal(line, '## [t] op | a | b\n');
});

// ─── applyExtraFrontmatter ─────────────────────────────────────────────────

test('applyExtraFrontmatter: copies a scalar field', () => {
  const fm = {};
  applyExtraFrontmatter(fm, { status: 'open' });
  assert.equal(fm.status, 'open');
});

test('applyExtraFrontmatter: comma-string list-field is split into array', () => {
  const fm = {};
  applyExtraFrontmatter(fm, { aliases: 'Foo, Bar ,Baz' });
  assert.deepEqual(fm.aliases, ['Foo', 'Bar', 'Baz']);
});

test('applyExtraFrontmatter: array list-field is passed through unchanged', () => {
  const fm = {};
  applyExtraFrontmatter(fm, { aliases: ['Foo', 'Bar'] });
  assert.deepEqual(fm.aliases, ['Foo', 'Bar']);
});

test('applyExtraFrontmatter: false-valued field is skipped', () => {
  const fm = { status: 'preexisting' };
  applyExtraFrontmatter(fm, { status: false });
  assert.equal(fm.status, 'preexisting');
});

test('applyExtraFrontmatter: undefined-valued field is skipped', () => {
  const fm = { status: 'preexisting' };
  applyExtraFrontmatter(fm, { status: undefined });
  assert.equal(fm.status, 'preexisting');
});

test('applyExtraFrontmatter: unknown args do not leak onto fm', () => {
  const fm = {};
  applyExtraFrontmatter(fm, { totally_unknown_field: 'leak', _: ['positional'] });
  assert.equal(fm.totally_unknown_field, undefined);
  assert.equal(fm._, undefined);
});

test('applyExtraFrontmatter: list-field with empty/whitespace tokens filtered', () => {
  const fm = {};
  applyExtraFrontmatter(fm, { attendees: 'a, , b,  ,c' });
  assert.deepEqual(fm.attendees, ['a', 'b', 'c']);
});

test('applyExtraFrontmatter: multiple fields in one call', () => {
  const fm = {};
  applyExtraFrontmatter(fm, { status: 'done', due: '2026-06-01', priority: 'high' });
  assert.equal(fm.status, 'done');
  assert.equal(fm.due, '2026-06-01');
  assert.equal(fm.priority, 'high');
});
