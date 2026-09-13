'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isPathInside,
  privateEnvPathErrors,
  vaultBindingErrors,
  assertVaultBinding,
} = require('../../bin/lib/vault-binding.js');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test('vaultBindingErrors is a no-op when no expected vault is configured', () => {
  const vault = tempDir('vault-binding-');
  assert.deepEqual(vaultBindingErrors({ detectedVault: vault, env: {} }), []);
});

test('vaultBindingErrors accepts the same vault after realpath resolution', () => {
  const vault = tempDir('vault-binding-');
  const nested = path.join(vault, '.');
  assert.deepEqual(vaultBindingErrors({
    detectedVault: nested,
    env: { ALFRED_EXPECTED_VAULT: vault },
  }), []);
});

test('vaultBindingErrors reports a wrong expected vault', () => {
  const active = tempDir('vault-binding-active-');
  const expected = tempDir('vault-binding-expected-');
  const errors = vaultBindingErrors({
    detectedVault: active,
    env: { ALFRED_EXPECTED_VAULT: expected },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ALFRED_EXPECTED_VAULT mismatch/);
});

test('assertVaultBinding throws a tagged error on mismatch', () => {
  const active = tempDir('vault-binding-active-');
  const expected = tempDir('vault-binding-expected-');
  assert.throws(
    () => assertVaultBinding({ detectedVault: active, env: { ALFRED_EXPECTED_VAULT: expected } }),
    (err) => err.code === 'ALFRED_VAULT_BINDING' && /mismatch/.test(err.message),
  );
});

test('privateEnvPathErrors accepts env files under vault .alfred/private', () => {
  const vault = tempDir('vault-binding-');
  const privateDir = path.join(vault, '.alfred', 'private');
  fs.mkdirSync(privateDir, { recursive: true });
  const envFile = path.join(privateDir, 'env');
  fs.writeFileSync(envFile, 'KEY=value\n');
  assert.deepEqual(privateEnvPathErrors({ vault, envFile }), []);
});

test('privateEnvPathErrors rejects env files outside the owning vault', () => {
  const vault = tempDir('vault-binding-');
  const other = tempDir('vault-binding-other-');
  const envFile = path.join(other, 'env');
  fs.writeFileSync(envFile, 'KEY=value\n');
  const errors = privateEnvPathErrors({ vault, envFile });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /env file must live under/);
});

test('isPathInside rejects sibling-prefix paths', () => {
  assert.equal(isPathInside('/tmp/vault/.alfred/private', '/tmp/vault/.alfred/private/env'), true);
  assert.equal(isPathInside('/tmp/vault/.alfred/private', '/tmp/vault/.alfred/private-bad/env'), false);
});
