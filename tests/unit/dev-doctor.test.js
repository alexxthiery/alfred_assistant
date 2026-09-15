'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inspectRepo } = require(path.resolve(__dirname, '..', '..', 'tools', 'dev-doctor.js'));

function makeRepo(t, { hook = true, pii = 'private-pattern\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-dev-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'pre-commit'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'tools', 'scan-pii.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'tools', 'pii-list.local.txt'), pii);
  if (hook) {
    fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/usr/bin/env bash\nexec tools/pre-commit "$@"\n', { mode: 0o755 });
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
