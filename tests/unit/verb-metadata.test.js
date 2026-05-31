'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SECTIONS, VERBS, DISPATCH_VERBS, WRITE_VERBS } = require('../../bin/lib/verb-metadata.js');

test('verb metadata: names are unique and dispatchable names exclude pseudo entries', () => {
  const names = VERBS.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, 'duplicate verb metadata names');
  assert.ok(names.includes('__global'), 'global help pseudo-entry should remain in metadata');
  assert.ok(!DISPATCH_VERBS.some((v) => v.name.startsWith('__')), 'pseudo entries must not be dispatch verbs');
});

test('verb metadata: every entry has a known section and nonempty help lines', () => {
  const validSections = new Set(SECTIONS);
  for (const v of VERBS) {
    assert.ok(validSections.has(v.section), `${v.name} uses unknown section ${v.section}`);
    assert.ok(Array.isArray(v.lines), `${v.name} lines must be an array`);
    assert.ok(v.lines.length > 0, `${v.name} must have at least one help line`);
    assert.ok(v.lines.every((l) => typeof l === 'string' && l.trim()), `${v.name} has an empty help line`);
  }
});

test('verb metadata: section ordering covers scheduling and keeps global flags last', () => {
  assert.ok(SECTIONS.includes('SCHEDULING'), 'jobs section should be printed by global help');
  assert.equal(SECTIONS.at(-1), 'GLOBAL FLAGS');
});

test('verb metadata: writeClass flags and WRITE_VERBS stay aligned', () => {
  const fromEntries = new Set(VERBS.filter((v) => v.writeClass).map((v) => v.name));
  assert.deepEqual([...WRITE_VERBS].sort(), [...fromEntries].sort());
});

test('verb metadata: epistemic sugar verbs are write-class', () => {
  for (const name of ['predict', 'hypothesize', 'capture']) {
    assert.ok(WRITE_VERBS.has(name), `${name} routes through patch and must tamper-check`);
  }
});

test('verb metadata: every WRITE_VERBS member is a real dispatch verb', () => {
  const dispatch = new Set(DISPATCH_VERBS.map((v) => v.name));
  for (const name of WRITE_VERBS) {
    assert.ok(dispatch.has(name), `${name} in WRITE_VERBS but not dispatch metadata`);
  }
});
