'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function wrongVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'email-cli-wrong-vault-'));
}

function run(script, args, env) {
  return spawnSync(path.join(ROOT, 'bin', script), args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('gmail refuses a credential env bound to another vault before IMAP auth', () => {
  const r = run('gmail', ['count', '--query', 'newer_than:1d'], {
    ALFRED_EXPECTED_VAULT: wrongVault(),
    EMAIL_FROM: 'user@example.com',
    GMAIL_IMAP_APP_PASSWORD: 'fake-password',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ALFRED_EXPECTED_VAULT mismatch/);
  assert.doesNotMatch(r.stderr, /IMAP login failed|Gmail unreachable/);
});

test('email-review refuses a credential env bound to another vault before IMAP auth', () => {
  const r = run('email-review', ['--days', '1'], {
    ALFRED_EXPECTED_VAULT: wrongVault(),
    EMAIL_FROM: 'user@example.com',
    GMAIL_IMAP_APP_PASSWORD: 'fake-password',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ALFRED_EXPECTED_VAULT mismatch/);
  assert.doesNotMatch(r.stderr, /IMAP login failed|Gmail unreachable/);
});
