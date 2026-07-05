// Unit tests for bin/inbox command behavior. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INBOX_BIN = path.resolve(__dirname, '..', '..', 'bin', 'inbox');

function tempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-inbox-'));
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  return root;
}

function runInbox(root, args) {
  return spawnSync(process.execPath, [INBOX_BIN, ...args], {
    cwd: root,
    env: { ...process.env, WIKI_ROOT: root },
    encoding: 'utf8',
  });
}

test('inbox triage refuses nested active files', () => {
  const root = tempVault();
  fs.mkdirSync(path.join(root, 'inbox', 'batch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', 'batch', 'source.md'), 'nested source\n');

  const result = runInbox(root, ['triage', '--dry-run']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /nested active file/);
  assert.match(result.stderr, /inbox\/batch\/source\.md/);
  assert.match(result.stderr, /raw\/<kind>/);
});

test('inbox triage dry-run still processes root-level files', () => {
  const root = tempVault();
  fs.writeFileSync(path.join(root, 'inbox', 'source.txt'), 'root source\n');

  const result = runInbox(root, ['triage', '--dry-run']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /DRY\s+source\.txt/);
  assert.match(result.stdout, /notes\//);
});
