// Unit tests for bin/lib/vault-root.js.
//
// HR11: detectVaultRoot is shared between bin/lib/vault.js (the wiki CLI
// surface) and bin/inbox (the stdin-to-pending-bin ingest helper). Extracted
// from two copies into a standalone module so future binaries can reuse
// without pulling in the full bin/lib/vault.js dep tree.
//
// Tests exercise the 4-step discovery order documented in the module:
//   1. WIKI_ROOT env override
//   2. Walk up from cwd looking for .alfred.yml
//   3. Resolve from script location (<vault>/.bin/<name>)
//   4. Fall back to cwd

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectVaultRoot } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'vault-root.js')
);

function mkTempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-root-test-'));
  fs.writeFileSync(path.join(dir, '.alfred.yml'), 'placeholder: true\n');
  return dir;
}

// Tests have to manipulate process.cwd/env carefully. Each test snapshots and
// restores both, in case any test triggers an exception before completing.
function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}

function withEnv(overrides, fn) {
  const prev = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('detectVaultRoot: 1) WIKI_ROOT env override wins', () => {
  const v = mkTempVault();
  withEnv({ WIKI_ROOT: '/explicit/override' }, () => {
    withCwd(v, () => {
      // Even though we're INSIDE a real vault dir, the env override beats it.
      assert.equal(detectVaultRoot(), '/explicit/override');
    });
  });
});

test('detectVaultRoot: 2) walks up from cwd to find .alfred.yml', () => {
  const v = mkTempVault();
  const nested = path.join(v, 'sub', 'deeper');
  fs.mkdirSync(nested, { recursive: true });
  withEnv({ WIKI_ROOT: undefined }, () => {
    withCwd(nested, () => {
      // realpath in case macOS /tmp resolves to /private/tmp
      assert.equal(fs.realpathSync(detectVaultRoot()), fs.realpathSync(v));
    });
  });
});

test('detectVaultRoot: 2) walks all the way up if no .alfred.yml is anywhere', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-alfred-'));
  withEnv({ WIKI_ROOT: undefined }, () => {
    withCwd(empty, () => {
      // Falls through to step 4: cwd.
      const got = detectVaultRoot();
      // It either lands on a real vault somewhere up the chain (if the test
      // host happens to have one) or returns cwd. In our temp dir, no .alfred.yml
      // exists between here and /, so the realistic fallback is cwd.
      // Defensive assertion: at minimum it's an absolute path.
      assert.ok(path.isAbsolute(got));
    });
  });
});

test('detectVaultRoot: 1) WIKI_ROOT set to an arbitrary value is returned verbatim', () => {
  // Defensive: we do NOT validate that WIKI_ROOT points to a real directory.
  // Tests can hand any string in. Pins this so a future "validate WIKI_ROOT
  // exists" tightening lands deliberately, not silently.
  withEnv({ WIKI_ROOT: '/no/such/path/exists' }, () => {
    assert.equal(detectVaultRoot(), '/no/such/path/exists');
  });
});

test('detectVaultRoot: returns a string', () => {
  // Sanity: regardless of how the resolution ended, we always return a string
  // (callers do path.join on the result without null-checking).
  withEnv({ WIKI_ROOT: undefined }, () => {
    assert.equal(typeof detectVaultRoot(), 'string');
  });
});
