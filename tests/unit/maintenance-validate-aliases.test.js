// Unit tests for HR07 alias validators in bin/lib/maintenance.js.
//
// The frontmatter round-trip is lossy for aliases containing `,` or `]` (see
// tests/unit/frontmatter-roundtrip.test.js boundary comment). HR07 closes the
// hazard by refusing such aliases at write time. The validator lives in
// bin/lib/maintenance.js so any caller (cmdWrite, cmdPatch --alias, cmdPatch
// --title rename, cmdMerge promote source title/aliases) can share one
// canonical check.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { validateAliasArg, aliasValueError } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'maintenance.js')
);

// ─── aliasValueError ───────────────────────────────────────────────────────

test('aliasValueError: safe string returns null', () => {
  assert.equal(aliasValueError('Alice'), null);
  assert.equal(aliasValueError('Dr. Bob Jones'), null);
  assert.equal(aliasValueError(''), null);
});

test('aliasValueError: comma in value is flagged', () => {
  const err = aliasValueError('Doe, John');
  assert.match(err, /forbidden character ","/);
  assert.match(err, /Doe, John/);
});

test('aliasValueError: right bracket in value is flagged', () => {
  const err = aliasValueError('Foo]bar');
  assert.match(err, /forbidden character "\]"/);
});

test('aliasValueError: non-string input returns null (defensive)', () => {
  assert.equal(aliasValueError(undefined), null);
  assert.equal(aliasValueError(null), null);
  assert.equal(aliasValueError(42), null);
});

// ─── validateAliasArg ──────────────────────────────────────────────────────

test('validateAliasArg: undefined/false/null returns empty', () => {
  assert.deepEqual(validateAliasArg(undefined), []);
  assert.deepEqual(validateAliasArg(null), []);
  assert.deepEqual(validateAliasArg(false), []);
});

test('validateAliasArg: array of safe aliases returns empty', () => {
  assert.deepEqual(validateAliasArg(['Alice', 'Smith']), []);
});

test('validateAliasArg: comma-string is split first, then validated — passes', () => {
  // "Foo, Bar" → ["Foo", "Bar"] via the comma-split. Each is safe.
  assert.deepEqual(validateAliasArg('Foo, Bar'), []);
});

test('validateAliasArg: array containing a `,`-bearing alias returns error', () => {
  const errs = validateAliasArg(['Alice', 'Doe, John']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Doe, John/);
});

test('validateAliasArg: array containing a `]`-bearing alias returns error', () => {
  const errs = validateAliasArg(['Foo]bar']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /forbidden character "\]"/);
});

test('validateAliasArg: multiple bad aliases each produce an error', () => {
  const errs = validateAliasArg(['Doe, John', 'Foo]bar', 'Safe']);
  assert.equal(errs.length, 2);
});
