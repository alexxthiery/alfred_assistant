// vault-binding.js — fail-closed checks for per-assistant env/vault routing.
//
// A multi-assistant host can have several vaults plus several credential env
// files. When ALFRED_EXPECTED_VAULT is present, it is a contract: the active
// vault must be that vault. This module keeps the check pure-ish and testable.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveExistingPath(p) {
  if (!p) return null;
  return fs.realpathSync(path.resolve(p));
}

function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function privateEnvPathErrors({ vault, envFile } = {}) {
  if (!vault) return ['vault path is required'];
  if (!envFile) return ['env file path is required'];

  let vaultReal;
  let envReal;
  try {
    vaultReal = resolveExistingPath(vault);
  } catch {
    return [`vault path does not resolve to an existing path: ${vault}`];
  }
  try {
    envReal = resolveExistingPath(envFile);
  } catch {
    return [`env file does not resolve to an existing path: ${envFile}`];
  }

  const privateRoot = path.join(vaultReal, '.alfred', 'private');
  if (!isPathInside(privateRoot, envReal)) {
    return [`env file must live under ${privateRoot}; got ${envReal}`];
  }
  return [];
}

function vaultBindingErrors({ detectedVault, env = process.env } = {}) {
  const expected = env.ALFRED_EXPECTED_VAULT;
  if (!expected) return [];
  if (!detectedVault) return ['ALFRED_EXPECTED_VAULT is set but no active vault was detected'];

  let expectedReal;
  let detectedReal;
  try {
    expectedReal = resolveExistingPath(expected);
  } catch {
    return [`ALFRED_EXPECTED_VAULT does not resolve to an existing path: ${expected}`];
  }
  try {
    detectedReal = resolveExistingPath(detectedVault);
  } catch {
    return [`active vault does not resolve to an existing path: ${detectedVault}`];
  }
  if (expectedReal !== detectedReal) {
    return [`ALFRED_EXPECTED_VAULT mismatch: expected ${expectedReal}, active ${detectedReal}`];
  }
  return [];
}

function assertVaultBinding({ detectedVault, env = process.env } = {}) {
  const errors = vaultBindingErrors({ detectedVault, env });
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.code = 'ALFRED_VAULT_BINDING';
    throw err;
  }
}

module.exports = {
  resolveExistingPath,
  isPathInside,
  privateEnvPathErrors,
  vaultBindingErrors,
  assertVaultBinding,
};
