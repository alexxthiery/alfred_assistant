'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  importConversationFiles,
  redactSecrets,
} = require('../../bin/lib/conversation-log.js');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initVault({ ignored = true } = {}) {
  const vault = tmp('conversation-log-vault-');
  git(vault, 'init', '-q');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.alfred.yml'), 'user:\n  slug: test\n  name: Test\n');
  if (ignored) fs.writeFileSync(path.join(vault, '.gitignore'), '.alfred/private/\n');
  return vault;
}

test('redactSecrets redacts common credential shapes without deleting context', () => {
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc';
  const input = [
    'before',
    `TELEGRAM_BOT_TOKEN=${token}`,
    'Authorization: Bearer sk-testabcdefghijklmnopqrstuvwxyz123456',
    'after',
  ].join('\n');
  const out = redactSecrets(input);
  assert.equal(out.redactions, 2);
  assert.match(out.text, /TELEGRAM_BOT_TOKEN=\[REDACTED\]/);
  assert.match(out.text, /Authorization: Bearer \[REDACTED\]/);
  assert.doesNotMatch(out.text, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out.text, /before/);
  assert.match(out.text, /after/);
});

test('importConversationFiles mirrors transcripts only under gitignored vault-private storage', () => {
  const vault = initVault({ ignored: true });
  const source = tmp('conversation-log-source-');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'nested', '2026-09-14-conversation.md'),
    'User: hello\nTELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc\nAssistant: hi\n',
  );

  const r = importConversationFiles({
    vaultRoot: vault,
    sourceDir: source,
    provider: 'nanoclaw',
    sourceName: 'dm-with-test',
    now: () => '2026-09-14T00:00:00.000Z',
  });

  assert.equal(r.files, 1);
  assert.equal(r.copied, 1);
  assert.equal(r.redactions, 1);

  const copiedRel = '.alfred/private/conversations/nanoclaw/dm-with-test/nested/2026-09-14-conversation.md';
  const copied = fs.readFileSync(path.join(vault, copiedRel), 'utf8');
  assert.match(copied, /User: hello/);
  assert.match(copied, /TELEGRAM_BOT_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(copied, /123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc/);

  const manifest = fs.readFileSync(path.join(vault, r.manifestRel), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].vault_rel, copiedRel);
  assert.equal(manifest[0].redactions, 1);
  assert.equal(manifest[0].kind, 'conversation_file');

  assert.equal(git(vault, 'check-ignore', copiedRel).trim(), copiedRel);
  assert.deepEqual(git(vault, 'status', '--short').trim().split('\n').filter(Boolean), [
    '?? .alfred.yml',
    '?? .gitignore',
  ]);
});

test('importConversationFiles refuses a git worktree where private conversations are trackable', () => {
  const vault = initVault({ ignored: false });
  const source = tmp('conversation-log-source-');
  fs.writeFileSync(path.join(source, 'conversation.md'), 'User: hello\n');

  assert.throws(
    () => importConversationFiles({ vaultRoot: vault, sourceDir: source }),
    /not gitignored/,
  );
  assert.equal(fs.existsSync(path.join(vault, '.alfred', 'private', 'conversations', 'nanoclaw')), false);
});
