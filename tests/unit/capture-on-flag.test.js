// Unit tests for stampOnDate — pure helper that injects `[on YYYY-MM-DD]`
// into an already-built observation line. Consumed by cmdCapture's
// `--today` / `--on YYYY-MM-DD` flag.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { stampOnDate } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'epistemic-verbs.js'),
);

test('stamps a simple [fact] line before the provenance marker', () => {
  const before = '[fact] gym run ^[conv:2026-05-19]';
  const after  = '[fact] gym run [on 2026-05-19] ^[conv:2026-05-19]';
  assert.equal(stampOnDate(before, '2026-05-19'), after);
});

test('appends to end when no provenance marker is present', () => {
  const before = '[fact] gym run';
  const after  = '[fact] gym run [on 2026-05-19]';
  assert.equal(stampOnDate(before, '2026-05-19'), after);
});

test('preserves [by] and [confidence] tags (prediction-shaped line)', () => {
  const before = '[prediction] paper ships [by 2027-06] [confidence: 0.7] ^[t:1]';
  const after  = '[prediction] paper ships [by 2027-06] [confidence: 0.7] [on 2026-05-19] ^[t:1]';
  assert.equal(stampOnDate(before, '2026-05-19'), after);
});

test('idempotent: existing [on X] is left intact, new date is NOT added', () => {
  const before = '[fact] gym run [on 2026-05-15] ^[conv:1]';
  // No change — existing [on] wins so re-running capture --today on the same
  // input doesn't accumulate duplicate date tags.
  assert.equal(stampOnDate(before, '2026-05-19'), before);
});

test('rejects bad date shapes', () => {
  assert.throws(() => stampOnDate('[fact] x ^[t:1]', '2026-5-19'),   /YYYY-MM-DD/);
  assert.throws(() => stampOnDate('[fact] x ^[t:1]', 'tomorrow'),    /YYYY-MM-DD/);
  assert.throws(() => stampOnDate('[fact] x ^[t:1]', ''),            /YYYY-MM-DD/);
  assert.throws(() => stampOnDate('[fact] x ^[t:1]', '2026/05/19'),  /YYYY-MM-DD/);
});

test('handles multiple provenance markers (inserts before the first)', () => {
  const before = '[claim] X says Y ^[telegram:1] ^[email:2]';
  const after  = '[claim] X says Y [on 2026-05-19] ^[telegram:1] ^[email:2]';
  assert.equal(stampOnDate(before, '2026-05-19'), after);
});
