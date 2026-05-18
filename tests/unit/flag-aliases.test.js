// Unit tests for bin/lib/flag-aliases.js.
// Run with: node --test tests/unit/

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { applyFlagAliases } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'flag-aliases.js'));

test('empty aliases: no warnings, no errors, args unchanged', () => {
  const args = { foo: 'bar', _: ['x'] };
  const r = applyFlagAliases('write', args, {});
  assert.deepEqual(r, { warnings: [], errors: [] });
  assert.deepEqual(args, { foo: 'bar', _: ['x'] });
});

test('null aliases arg: no-op', () => {
  const args = { soft: true };
  const r = applyFlagAliases('write', args, null);
  assert.deepEqual(r, { warnings: [], errors: [] });
  assert.deepEqual(args, { soft: true });
});

test('unrelated verb: no rewrite even if alias exists for another verb', () => {
  const args = { soft: true };
  const aliases = { write: { soft: 'lenient' } };
  const r = applyFlagAliases('audit', args, aliases);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.errors, []);
  assert.equal(args.soft, true);
});

test('rename: old flag rewrites to new name + emits warning', () => {
  const args = { soft: true, _: [] };
  const aliases = { write: { soft: 'lenient' } };
  const r = applyFlagAliases('write', args, aliases);
  assert.deepEqual(r.warnings, ['--soft is deprecated; use --lenient instead']);
  assert.deepEqual(r.errors, []);
  assert.equal(args.lenient, true);
  assert.equal('soft' in args, false);
});

test('rename: value is preserved through rewrite', () => {
  const args = { level: 'low' };
  const aliases = { audit: { level: 'severity' } };
  applyFlagAliases('audit', args, aliases);
  assert.equal(args.severity, 'low');
  assert.equal('level' in args, false);
});

test('rename: when user passes both old and new, new wins, old still warns', () => {
  const args = { soft: true, lenient: 'yes' };
  const aliases = { write: { soft: 'lenient' } };
  const r = applyFlagAliases('write', args, aliases);
  assert.deepEqual(r.warnings, ['--soft is deprecated; use --lenient instead']);
  assert.equal(args.lenient, 'yes'); // not clobbered
  assert.equal('soft' in args, false);
});

test('removal: null target records error, leaves arg in place (caller decides exit)', () => {
  const args = { obsolete: true };
  const aliases = { write: { obsolete: null } };
  const r = applyFlagAliases('write', args, aliases);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.errors, ['--obsolete has been removed (no replacement)']);
});

test('removal: absent flag does nothing', () => {
  const args = { other: true };
  const aliases = { write: { obsolete: null } };
  const r = applyFlagAliases('write', args, aliases);
  assert.deepEqual(r, { warnings: [], errors: [] });
});

test('multiple renames in one call: all process', () => {
  const args = { a: 1, b: 2, c: 3 };
  const aliases = { foo: { a: 'aaa', b: 'bbb' } };
  const r = applyFlagAliases('foo', args, aliases);
  assert.equal(r.warnings.length, 2);
  assert.equal(args.aaa, 1);
  assert.equal(args.bbb, 2);
  assert.equal(args.c, 3);
  assert.equal('a' in args, false);
  assert.equal('b' in args, false);
});

test('mixed rename + removal: both reported', () => {
  const args = { old1: true, gone: true };
  const aliases = { v: { old1: 'new1', gone: null } };
  const r = applyFlagAliases('v', args, aliases);
  assert.deepEqual(r.warnings, ['--old1 is deprecated; use --new1 instead']);
  assert.deepEqual(r.errors, ['--gone has been removed (no replacement)']);
  assert.equal(args.new1, true);
});

test('uses hasOwnProperty: prototype keys do not trigger', () => {
  // Defensive: aliases is plain JSON; ensure inherited keys are ignored.
  const args = Object.create({ inherited: true });
  args.real = true;
  const aliases = { v: { inherited: 'new-inherited', real: 'new-real' } };
  const r = applyFlagAliases('v', args, aliases);
  assert.equal(r.warnings.length, 1); // only `real` rewritten
  assert.equal(args['new-real'], true);
});
