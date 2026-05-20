// Strict flag validation — behavior tests.
//
// Two layers:
//   1. Pure module tests of flag-spec.js (fast, no spawn): the unknown-flag
//      computation, write-core inheritance, free-form exemption, globals.
//   2. End-to-end spawn tests of the real `wiki` binary: an unsupported flag is
//      rejected (exit 2, "unknown flag"); a valid flag is not; a write-core
//      flag inherited by a write verb is not.
//
// This is the test class that was missing when `wiki list --limit` was silently
// ignored: nothing asserted that an unrecognized flag produces a signal.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { unknownFlags, knownFlags, valuelessFlags } = require('../../bin/lib/flag-spec.js');

const REPO = path.resolve(__dirname, '..', '..');
const WIKI = path.join(REPO, 'bin', 'wiki');
const TEMPLATE = path.join(REPO, 'tests', 'vault');

// Representative help text (mirrors the real VERBS table closely enough for the
// pure-logic tests; the parity test guarantees the real table stays in sync).
const LIST_HELP = '  list [--tag t] [--type t] [--limit N] [--slugs-only]';
const RECENT_HELP = '  recent [--days N] [--type T]';
const CAPTURE_HELP = '  capture <slug> "[type] body"';

// ─── pure module logic ──────────────────────────────────────────────────────

test('unknownFlags: valid flag on a read verb is accepted', () => {
  assert.deepEqual(unknownFlags('list', { _: [], limit: 3 }, LIST_HELP), []);
});

test('unknownFlags: bogus flag is reported', () => {
  assert.deepEqual(unknownFlags('list', { _: [], bogus: true }, LIST_HELP), ['bogus']);
});

test('unknownFlags: --limit on `recent` is reported (the sibling-bug case)', () => {
  // recent does not support --limit; passing it should be flagged, not silently
  // ignored as it was before strict validation.
  assert.deepEqual(unknownFlags('recent', { _: [], limit: 3 }, RECENT_HELP), ['limit']);
});

test('unknownFlags: positionals (_) are never flags', () => {
  assert.deepEqual(unknownFlags('list', { _: ['foo', 'bar'] }, LIST_HELP), []);
});

test('knownFlags: write-class verb inherits the shared write-core surface', () => {
  const k = knownFlags('capture', CAPTURE_HELP);
  for (const f of ['provenance', 'soft', 'observation', 'today', 'on', 'born', 'confidence']) {
    assert.ok(k.has(f), `capture should accept --${f} (write-core inheritance)`);
  }
});

test('unknownFlags: free-form verb (measure) accepts arbitrary flags', () => {
  assert.deepEqual(unknownFlags('measure', { _: [], weight: '70', bodyfat: '12' }, ''), []);
});

test('unknownFlags: global flags are always accepted', () => {
  assert.deepEqual(
    unknownFlags('list', { _: [], help: true, 'accept-tamper': true, 'no-auto-commit': true }, LIST_HELP),
    []
  );
});

// ─── value-required guard (value-less flag => boolean true) ─────────────────

test('valuelessFlags: a value-required flag passed bare is reported', () => {
  assert.deepEqual(valuelessFlags({ _: [], title: true, type: 'entity' }), ['title']);
});

test('valuelessFlags: a value-required flag WITH a value is fine', () => {
  assert.deepEqual(valuelessFlags({ _: [], title: 'Real Title' }), []);
});

test('valuelessFlags: --hooks requires a value (intellectual-pipeline field)', () => {
  assert.deepEqual(valuelessFlags({ _: [], hooks: true }), ['hooks']);
  assert.deepEqual(valuelessFlags({ _: [], hooks: 'a,b' }), []);
});

test('valuelessFlags: boolean flags are never reported (no false positive)', () => {
  // --soft/--append/--dry-run/--sensitive are legitimately value-less.
  assert.deepEqual(
    valuelessFlags({ _: [], soft: true, append: true, 'dry-run': true, sensitive: true }),
    []
  );
});

// ─── end-to-end through the real binary ─────────────────────────────────────

function cpDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpDir(s, d); else fs.copyFileSync(s, d);
  }
}

function wiki(cwd, args) {
  const env = { ...process.env, WIKI_ROOT: cwd, WIKI_NO_AUTO_COMMIT: '1' };
  return spawnSync('node', [WIKI, ...args], { cwd, env, encoding: 'utf-8' });
}

test('e2e: unsupported flag is rejected with exit 2 and a clear message', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-flag-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['recent', '--limit', '3']);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stderr, /unknown flag --limit/);
    assert.match(r.stderr, /known flags:/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('e2e: a valid flag does not trip the validator', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-flag-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['list', '--limit', '1']);
    assert.doesNotMatch(r.stderr || '', /unknown flag/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('e2e: a value-less --title is rejected, not persisted as "true"', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-flag-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['write', 'boolflag', '--title', '--type', 'entity', '--content', 'hi']);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stderr, /--title requires a value/);
    assert.equal(fs.existsSync(path.join(v, 'wiki', 'boolflag.md')), false,
      'no page should be written when the flag is rejected');
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('e2e: write-core flag inherited by a write verb is not rejected', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-flag-'));
  try {
    cpDir(TEMPLATE, v);
    // --soft / --observation are write-core flags patch reads; the command may
    // still fail for other reasons, but never with "unknown flag".
    const r = wiki(v, ['patch', 'no-such-page', '--soft', '--observation', '[fact] x']);
    assert.doesNotMatch(r.stderr || '', /unknown flag/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});
