'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inspectRepo } = require(path.resolve(__dirname, '..', '..', 'tools', 'dev-doctor.js'));

function makeRepo(t, { hook = true, pushHook = true, pii = 'private-pattern\n', vaults = '~/vault\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-dev-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'pre-commit'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'tools', 'scan-pii.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'tools', 'pre-push'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'tools', 'pii-list.local.txt'), pii);
  fs.writeFileSync(path.join(root, 'tools', 'pii-vaults.local.txt'), vaults);
  if (hook) {
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/usr/bin/env bash\nexec tools/pre-commit "$@"\n', { mode: 0o755 });
  }
  if (pushHook) {
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-push'), '#!/usr/bin/env bash\nexec tools/pre-push "$@"\n', { mode: 0o755 });
  }
  return root;
}

function failedNames(result) {
  return result.checks.filter((c) => !c.ok).map((c) => c.name);
}

test('dev-doctor passes when hook and local PII list are present', (t) => {
  const root = makeRepo(t);
  assert.deepEqual(failedNames(inspectRepo(root)), []);
});

test('dev-doctor fails when the git pre-commit hook is not installed', (t) => {
  const root = makeRepo(t, { hook: false });
  assert.deepEqual(failedNames(inspectRepo(root)), ['pre-commit-hook']);
});

test('dev-doctor fails when local PII list is empty', (t) => {
  const root = makeRepo(t, { pii: '\n' });
  assert.deepEqual(failedNames(inspectRepo(root)), ['pii-local-list']);
});

test('dev-doctor fails when the git pre-push hook is not installed', (t) => {
  const root = makeRepo(t, { pushHook: false });
  assert.deepEqual(failedNames(inspectRepo(root)), ['pre-push-hook']);
});

test('dev-doctor fails when no vault sources are configured for the PII list', (t) => {
  const root = makeRepo(t, { vaults: '' });
  assert.deepEqual(failedNames(inspectRepo(root)), ['pii-vault-sources']);
});
