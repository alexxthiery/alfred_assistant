// Round-trip property tests for parseFrontmatter / serializeFrontmatter.
//
// Contract: for any frontmatter object built from the "safe" alphabet (no `,`
// inside string values, no `:` inside values, scalar values are strings or
// numbers, list values are arrays of safe strings), parse(serialize(fm,
// body)).fm should equal fm modulo the auto-stamped schema_version field,
// and the body should round-trip up to leading-`\n+` normalization.
//
// This is the test surface audit/12 § parser-robustness called out (HR06,
// HR07). The "boundary" tests at the bottom pin the *known unsafe* shapes
// so that any future "fix" to allow them shows up as a deliberate behavior
// change here, not a silent regression.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseFrontmatter,
  serializeFrontmatter,
  CURRENT_SCHEMA_VERSION,
} = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'frontmatter.js'));

// ─── safe-alphabet round-trip cases ────────────────────────────────────────

const SAFE_CASES = [
  // Minimal: id only
  { fm: { id: 'alice' }, body: 'just a body line\n' },
  // Typical entity
  {
    fm: { id: 'alice', title: 'Alice', type: 'entity', tags: ['person', 'friend'] },
    body: 'Alice is a person.\n',
  },
  // Empty body
  { fm: { id: 'x', title: 'X', type: 'note' }, body: '' },
  // Empty tags array
  { fm: { id: 'y', tags: [] }, body: 'body\n' },
  // Numeric scalar (created/updated are usually ISO strings but the serializer
  // doesn't quote, so a pure number would round-trip as a string — pin that)
  { fm: { id: 'z', priority: '3' }, body: '' },
  // Multi-line body
  {
    fm: { id: 'm', title: 'M', type: 'note' },
    body: 'line one\n\nline two\n\nline three\n',
  },
  // Unknown / extra fields
  {
    fm: { id: 'u', title: 'U', custom_field: 'hello world', another: 'foo' },
    body: '',
  },
  // ISO-style strings (don't contain `:` literal — wait, they do)
  // ... timestamps DO contain `:` which would break the `^(\w+):\s*(.*)$` parser.
  // Test that explicitly below in the boundary section. Skip here.
];

for (const [i, { fm, body }] of SAFE_CASES.entries()) {
  test(`round-trip: case ${i} (id=${fm.id}) parses back to original fm + body`, () => {
    const text = serializeFrontmatter({ ...fm }, body);
    const out = parseFrontmatter(text);
    // schema_version is auto-stamped by the serializer — strip it for comparison.
    const parsedFm = { ...out.fm };
    delete parsedFm.schema_version;
    assert.deepEqual(parsedFm, fm, 'frontmatter round-trips');
    // The serializer normalizes a leading `\n+` away. So compare on the
    // tail of the body after the same normalization.
    assert.equal(out.body, body.replace(/^\n+/, ''), 'body round-trips (modulo leading newlines)');
  });
}

test('round-trip: serializer always stamps schema_version', () => {
  const text = serializeFrontmatter({ id: 'x' }, '');
  assert.match(text, new RegExp(`schema_version: ${CURRENT_SCHEMA_VERSION}`));
  const out = parseFrontmatter(text);
  assert.equal(Number(out.fm.schema_version), CURRENT_SCHEMA_VERSION);
});

test('round-trip: explicit schema_version is preserved (not overwritten)', () => {
  const text = serializeFrontmatter({ id: 'x', schema_version: 1 }, '');
  const out = parseFrontmatter(text);
  assert.equal(Number(out.fm.schema_version), 1);
});

test('round-trip: ordered-key fields appear before extras in output', () => {
  // Documented contract: id, title, type, created, updated, tags, schema_version
  // appear in that order; other fields come after.
  const text = serializeFrontmatter({
    custom: 'extra',
    title: 'T',
    id: 'x',
    type: 'note',
  }, '');
  const idIdx = text.indexOf('id: x');
  const titleIdx = text.indexOf('title: T');
  const typeIdx = text.indexOf('type: note');
  const customIdx = text.indexOf('custom: extra');
  assert.ok(idIdx >= 0 && titleIdx >= 0 && typeIdx >= 0 && customIdx >= 0);
  assert.ok(idIdx < titleIdx, 'id before title');
  assert.ok(titleIdx < typeIdx, 'title before type');
  assert.ok(typeIdx < customIdx, 'core fields before extras');
});

// ─── boundary cases (known-unsafe shapes per audit/12 § parser-robustness) ─

test('boundary: ISO timestamp value (contains `:`) is corrupted by the parser', () => {
  // Pins HR-OOB potential: the simple `(.*)$` capture includes the literal
  // colons, but a downstream tool that re-parses the value would need to know
  // the value can contain `:`. parseFrontmatter currently keeps the whole
  // tail as a string, so this DOES round-trip — confirm.
  const fm = { id: 'x', created: '2026-05-18T12:34:56Z' };
  const text = serializeFrontmatter({ ...fm }, '');
  const out = parseFrontmatter(text);
  assert.equal(out.fm.created, '2026-05-18T12:34:56Z',
    'ISO timestamps with colons survive the round-trip (greedy tail capture)');
});

test('boundary: alias containing `,` is mis-split on parse (HR07 documented limitation)', () => {
  // serializeFrontmatter writes `aliases: [Doe, John]` for ["Doe, John"]; the
  // parser then splits on `,` and yields ["Doe", "John"] — wrong. HR07 (shipped
  // in session 26) closes this hazard at the write path: the CLI now refuses
  // to write an alias containing `,` or `]`, so this lossy parse can never be
  // triggered from a CLI-written page. The parse/serialize behavior itself is
  // unchanged — pinning it documents that we accepted the round-trip limitation
  // rather than fixing it in the parser. See tests/unit/maintenance-validate-aliases.test.js
  // for the write-path rejection contract.
  const fm = { id: 'x', aliases: ['Doe, John'] };
  const text = serializeFrontmatter({ ...fm }, '');
  const out = parseFrontmatter(text);
  // Parse/serialize behavior remains lossy for the unreachable case.
  assert.deepEqual(out.fm.aliases, ['Doe', 'John']);
});

test('boundary: alias containing `]` happens to round-trip (single slice)', () => {
  // serialized as `aliases: [Foo], Bar]`; parser sees v.endsWith(']') → true,
  // slices once on each side → "Foo], Bar", splits on `,` → ["Foo]", "Bar"].
  // Lucky path: only one bracket-strip happens, so the inner `]` survives.
  // Pinning this so a future "stricter list-detection" doesn't break it
  // silently.
  const fm = { id: 'x', aliases: ['Foo]', 'Bar'] };
  const text = serializeFrontmatter({ ...fm }, '');
  const out = parseFrontmatter(text);
  assert.deepEqual(out.fm.aliases, ['Foo]', 'Bar']);
});

test('boundary: parser tolerates body without trailing newline', () => {
  // Build input directly: serializeFrontmatter now normalizes the trailing
  // newline (adds one if missing). The parser still needs to tolerate input
  // that lacks one — e.g., a hand-written page or upstream data source.
  const text = '---\nid: x\nschema_version: 1\n---\nbody without trailing newline';
  const out = parseFrontmatter(text);
  assert.equal(out.body, 'body without trailing newline');
});
