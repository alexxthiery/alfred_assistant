// Unit tests for bin/lib/config.js.
//
// Config loading is a startup gate — a bug here breaks every CLI invocation.
// Tests focus on the pure parseFlatYaml + the DEFAULTS shape; loadConfig path
// resolution is integration-tested by the CLI fixtures.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseFlatYaml, DEFAULTS } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'config.js'));

test('parseFlatYaml: parses a 2-level section with scalar children', () => {
  const out = parseFlatYaml('user:\n  slug: alice\n  name: Alice Smith\n');
  assert.deepEqual(out, { user: { slug: 'alice', name: 'Alice Smith' } });
});

test('parseFlatYaml: parses a top-level scalar', () => {
  const out = parseFlatYaml('greeting: hello\n');
  assert.deepEqual(out, { greeting: 'hello' });
});

test('parseFlatYaml: strips end-of-line comments', () => {
  const out = parseFlatYaml('user:\n  slug: alice  # the user slug\n');
  assert.equal(out.user.slug, 'alice');
});

test('parseFlatYaml: coerces booleans and integers', () => {
  const out = parseFlatYaml('weekly_review:\n  enabled: true\n  retries: 3\n  disabled: false\n');
  assert.equal(out.weekly_review.enabled, true);
  assert.equal(out.weekly_review.disabled, false);
  assert.equal(out.weekly_review.retries, 3);
});

test('parseFlatYaml: preserves quoted strings verbatim (no coercion)', () => {
  // Without quotes "true" coerces to boolean; quotes preserve as string.
  const out = parseFlatYaml('flag:\n  literal: "true"\n  apostrophe: \'42\'\n');
  assert.equal(out.flag.literal, 'true');
  assert.equal(out.flag.apostrophe, '42');
});

test('parseFlatYaml: empty value at top level becomes empty string (not section)', () => {
  // Section discriminator is whether the value-after-colon is empty AND we're
  // at indent 0 AND children are indented. Standalone empty value at indent 0
  // creates a section that just stays empty if no children follow.
  const out = parseFlatYaml('empty_section:\n');
  assert.deepEqual(out, { empty_section: {} });
});

test('parseFlatYaml: ignores blank lines and pure-comment lines', () => {
  const out = parseFlatYaml('# header comment\n\nuser:\n\n  slug: alice\n# trailing\n');
  assert.deepEqual(out, { user: { slug: 'alice' } });
});

test('parseFlatYaml: rejects unexpected indent', () => {
  // The parser only supports 0 or 2 spaces. 4-space indent should error.
  assert.throws(
    () => parseFlatYaml('user:\n    slug: alice\n'),
    /unexpected indent/,
  );
});

test('parseFlatYaml: rejects indented key with no parent section', () => {
  assert.throws(
    () => parseFlatYaml('  slug: alice\n'),
    /no parent section/,
  );
});

test('parseFlatYaml: rejects line missing a colon', () => {
  assert.throws(
    () => parseFlatYaml('not a valid line\n'),
    /expected 'key: value'/,
  );
});

test('DEFAULTS: has all expected top-level sections (regression on dropped keys)', () => {
  // If someone removes a section from DEFAULTS, downstream code that expects
  // it (e.g., `cfg.email.from`) will crash with "Cannot read property of
  // undefined". Pin the shape.
  assert.ok(DEFAULTS.user, 'user section exists');
  assert.ok(DEFAULTS.assistant, 'assistant section exists');
  assert.ok(DEFAULTS.email, 'email section exists');
  assert.ok(DEFAULTS.weekly_review, 'weekly_review section exists');
  assert.ok(DEFAULTS.paths, 'paths section exists');
  assert.equal(typeof DEFAULTS.user.slug, 'string');
  assert.equal(typeof DEFAULTS.user.name, 'string');
  assert.equal(typeof DEFAULTS.weekly_review.enabled, 'boolean');
});

test('DEFAULTS: is frozen (mutation guard)', () => {
  // Object.freeze prevents accidental mutation at startup; surface it.
  assert.ok(Object.isFrozen(DEFAULTS));
});
