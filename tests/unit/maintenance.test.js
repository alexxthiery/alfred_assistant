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

const { formatIndex, formatLogLine, applyExtraFrontmatter, validateExtraFieldValue } = require(
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

test('formatIndex: omits done todos and past events (keeps open todos + future/undated)', () => {
  const pages = [
    { slug: 'open-t',  fm: { title: 'Open',  type: 'todo',  status: 'open' }, body: '' },
    { slug: 'done-t',  fm: { title: 'Done',  type: 'todo',  status: 'done' }, body: '' },
    { slug: 'past-ev', fm: { title: 'Past',  type: 'event', when: '2026-05-01' }, body: '' },
    { slug: 'soon-ev', fm: { title: 'Soon',  type: 'event', when: '2026-12-01' }, body: '' },
  ];
  const out = formatIndex(pages, { now: '2026-05-20T00:00:00Z' });
  assert.ok(out.includes('[[open-t]]'), 'open todo kept');
  assert.equal(out.includes('[[done-t]]'), false, 'done todo omitted');
  assert.equal(out.includes('[[past-ev]]'), false, 'past event omitted');
  assert.ok(out.includes('[[soon-ev]]'), 'future event kept');
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

test('validateExtraFieldValue: todo status/due/priority are typed', () => {
  assert.equal(validateExtraFieldValue('status', 'doing').value, 'doing');
  assert.equal(validateExtraFieldValue('due', '2026-06-01').value, '2026-06-01');
  assert.equal(validateExtraFieldValue('priority', 'medium').value, 'med');
  assert.ok(validateExtraFieldValue('status', 'blocked').error);
  assert.ok(validateExtraFieldValue('due', 'next friday').error);
  assert.ok(validateExtraFieldValue('priority', 'urgent').error);
});

// ─── reminder fields: remind_at / reminded_at validation, notify list ────────

test('validateExtraFieldValue: remind_at accepts ISO8601 datetime with offset', () => {
  assert.equal(validateExtraFieldValue('remind_at', '2026-05-23T14:00+08:00').value, '2026-05-23T14:00+08:00');
  assert.equal(validateExtraFieldValue('remind_at', '2026-05-23T06:00:00Z').value, '2026-05-23T06:00:00Z');
  assert.equal(validateExtraFieldValue('remind_at', '2026-05-23T14:00').value, '2026-05-23T14:00');
});

test('validateExtraFieldValue: remind_at rejects date-only and garbage', () => {
  assert.ok(validateExtraFieldValue('remind_at', '2026-05-23').error);
  assert.ok(validateExtraFieldValue('remind_at', 'next tuesday').error);
  // millis are rejected (Date#toISOString form must be trimmed before stamping)
  assert.ok(validateExtraFieldValue('remind_at', '2026-05-23T06:00:00.123Z').error);
});

test('validateExtraFieldValue: reminded_at uses the same datetime rule', () => {
  assert.equal(validateExtraFieldValue('reminded_at', '2026-05-23T07:00:00Z').value, '2026-05-23T07:00:00Z');
  assert.ok(validateExtraFieldValue('reminded_at', 'whenever').error);
});

test('applyExtraFrontmatter: notify comma-string splits into a list', () => {
  const fm = {};
  applyExtraFrontmatter(fm, { notify: 'telegram, email' });
  assert.deepEqual(fm.notify, ['telegram', 'email']);
});

// ─── origin / bibliographic attribution fields ───────────────────────────────

test('validateExtraFieldValue: origin accepts a source slug and the control words', () => {
  assert.equal(validateExtraFieldValue('origin', 'kahneman-tversky-1971').value, 'kahneman-tversky-1971');
  assert.equal(validateExtraFieldValue('origin', 'original').value, 'original');
  assert.equal(validateExtraFieldValue('origin', 'unattributed').value, 'unattributed');
});

test('validateExtraFieldValue: origin rejects blanks, uppercase, and free text (no phantom attributions)', () => {
  // Behavioral claim: only slug-shaped values pass, so a typo or a sentence
  // cannot land as a bogus source pointer.
  assert.ok(validateExtraFieldValue('origin', '').error);
  assert.ok(validateExtraFieldValue('origin', '   ').error);
  assert.ok(validateExtraFieldValue('origin', 'Kahneman & Tversky 1971').error);
  assert.ok(validateExtraFieldValue('origin', 'Original').error);
});

test('validateExtraFieldValue: year accepts 3-4 digit years and coerces to number', () => {
  assert.equal(validateExtraFieldValue('year', '2019').value, 2019);
  assert.equal(validateExtraFieldValue('year', '850').value, 850);
  assert.equal(typeof validateExtraFieldValue('year', '2019').value, 'number');
});

test('validateExtraFieldValue: year rejects non-year input', () => {
  assert.ok(validateExtraFieldValue('year', '19').error);
  assert.ok(validateExtraFieldValue('year', '20195').error);
  assert.ok(validateExtraFieldValue('year', 'MMXIX').error);
});

test('applyExtraFrontmatter: author comma-string splits into a list; kind/origin/url/doi pass through', () => {
  // kind was previously ingest-only; a bibliographic `wiki write --type source`
  // needs it settable, so it must round-trip like the other passthrough fields.
  const fm = {};
  applyExtraFrontmatter(fm, { author: 'Naesseth, Lindsten, Schon', origin: 'elements-of-smc', kind: 'paper', url: 'https://arxiv.org/abs/1903.04797', doi: '10.1561/2200000074' });
  assert.deepEqual(fm.author, ['Naesseth', 'Lindsten', 'Schon']);
  assert.equal(fm.origin, 'elements-of-smc');
  assert.equal(fm.kind, 'paper');
  assert.equal(fm.url, 'https://arxiv.org/abs/1903.04797');
  assert.equal(fm.doi, '10.1561/2200000074');
});

test('applyExtraFrontmatter: invalid origin throws (surfaces as exit-3 at the write layer)', () => {
  assert.throws(() => applyExtraFrontmatter({}, { origin: 'Not A Slug' }), /origin/);
});
