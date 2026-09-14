// Unit tests for tools/nanoclaw-disposable-smoke.js.
//
// These cover the cheap pure helper contract. The expensive deploy/write checks
// are intentionally exercised by the smoke command itself, not by every unit run.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseArgv, redact } = require('../../tools/nanoclaw-disposable-smoke.js');

test('parseArgv accepts a staging NanoClaw path and keep flag', () => {
  assert.deepEqual(parseArgv(['--nanoclaw', '/tmp/nanoclaw', '--keep']), {
    keep: true,
    skipNanoclaw: false,
    nanoclaw: '/tmp/nanoclaw',
  });
});

test('parseArgv rejects conflicting NanoClaw options', () => {
  assert.throws(
    () => parseArgv(['--nanoclaw', '/tmp/nanoclaw', '--skip-nanoclaw']),
    /either --nanoclaw or --skip-nanoclaw/,
  );
});

test('parseArgv rejects missing option values', () => {
  assert.throws(() => parseArgv(['--nanoclaw']), /--nanoclaw requires a value/);
});

test('redact removes bot-token-shaped values and smoke secrets', () => {
  const text = 'token=123456:SMOKE_ALPHA_SECRET_TOKEN and pw=SMOKE_BETA_SECRET_TOKEN';
  const out = redact(text);
  assert.doesNotMatch(out, /SMOKE_ALPHA_SECRET_TOKEN/);
  assert.doesNotMatch(out, /SMOKE_BETA_SECRET_TOKEN/);
  assert.match(out, /<REDACTED>/);
});
