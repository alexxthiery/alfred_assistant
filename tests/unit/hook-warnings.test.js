// hookWarnings — soft guardrail nudging hooks toward short, standard concept
// names. A hook only links if a future card lands on the same string, so
// sentence-like hooks (a whole claim crammed into a slug) bridge nothing. This
// flags them (>32 chars or >3 hyphens) without blocking the write.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hookWarnings } = require('../../bin/lib/maintenance.js');

test('hookWarnings: short standard-name hooks pass clean', () => {
  assert.deepEqual(
    hookWarnings(['advantage-baseline', 'control-variate', 'two-timescale', 'logmeanexp', 'importance-sampling']),
    []
  );
});

test('hookWarnings: sentence-like hooks (too many hyphens) are flagged', () => {
  const w = hookWarnings(['reference-subtraction-exposes-relative-value']);
  assert.equal(w.length, 1);
  assert.match(w[0], /sentence-like/);
});

test('hookWarnings: over-long hooks are flagged', () => {
  // 33 chars, only 1 hyphen — caught by the length rule, not the hyphen rule.
  const long = 'a'.repeat(20) + '-' + 'b'.repeat(12);
  assert.ok(long.length > 32);
  assert.equal(hookWarnings([long]).length, 1);
});

test('hookWarnings: a 3-hyphen / short hook is allowed (boundary)', () => {
  // exactly 3 hyphens and <=32 chars: not flagged.
  assert.deepEqual(hookWarnings(['local-vs-global-credit']), []);
});

test('hookWarnings: non-strings and empties are ignored', () => {
  assert.deepEqual(hookWarnings(['ok-hook', '', null, 42, undefined]), []);
});
