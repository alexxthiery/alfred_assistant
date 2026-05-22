// hookWarnings — soft guardrail nudging hooks toward short, standard concept
// names. A hook only links if a future card lands on the same string, so
// sentence-like hooks (a whole claim crammed into a slug) bridge nothing. This
// flags them (>32 chars or >3 hyphens) without blocking the write.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hookWarnings, aliasWarnings } = require('../../bin/lib/maintenance.js');

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

// ─── V6: aliasWarnings — generic aliases are unsafe autolink anchors ──────────

test('aliasWarnings: generic 1-2 word aliases are flagged (drive V1 over-linking)', () => {
  assert.equal(aliasWarnings('optimal policy').length, 1);
  assert.equal(aliasWarnings('successor measure').length, 1);
  assert.equal(aliasWarnings('entropy').length, 1);
});

test('aliasWarnings: distinctive aliases pass clean', () => {
  assert.deepEqual(aliasWarnings('gamma-model'), []);        // hyphenated
  assert.deepEqual(aliasWarnings('DPO'), []);                // acronym/caps
  assert.deepEqual(aliasWarnings('variational-bound'), []);  // hyphenated
  assert.deepEqual(aliasWarnings('Bellman optimality equation'), []); // >2 words
  assert.deepEqual(aliasWarnings('ddpm-snr-2'), []);         // digits/hyphen
});

test('aliasWarnings: accepts a string or array; empty/blank ignored', () => {
  assert.deepEqual(aliasWarnings([]), []);
  assert.deepEqual(aliasWarnings(['', '  ']), []);
  assert.equal(aliasWarnings(['optimal policy', 'gamma-model']).length, 1);
});
