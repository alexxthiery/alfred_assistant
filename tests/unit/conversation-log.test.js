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

function claudeLine({ type = 'user', role = type, content, timestamp = '2026-09-15T01:00:00.000Z', extra = {} }) {
  return JSON.stringify({
    type,
    timestamp,
    sessionId: 'sess-1',
    message: { role, content },
    ...extra,
  });
}

test('importConversationFiles extracts compact Claude JSONL deltas and advances a cursor', () => {
  const vault = initVault({ ignored: true });
  const source = tmp('conversation-log-claude-source-');
  const transcript = path.join(source, 'session.jsonl');
  fs.mkdirSync(path.join(source, 'old-session', 'subagents'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'old-session', 'subagents', 'agent-noise.jsonl'),
    claudeLine({ role: 'user', content: [{ type: 'text', text: 'Subagent text should not appear.' }] }) + '\n',
  );
  fs.writeFileSync(transcript, [
    claudeLine({ role: 'user', content: [{ type: 'text', text: 'The user likes chess.' }] }),
    claudeLine({ role: 'assistant', content: [{ type: 'text', text: 'Nice, I will remember chess.' }] }),
    claudeLine({
      role: 'user',
      content: [{ type: 'tool_result', content: 'huge command output that should not be ingested' }],
      extra: { toolUseResult: { stdout: 'huge command output that should not be ingested' } },
    }),
    claudeLine({ role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning should not be ingested' }] }),
    claudeLine({ role: 'user', content: [{ type: 'text', text: 'TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc' }] }),
    '',
  ].join('\n'));

  const first = importConversationFiles({
    vaultRoot: vault,
    sourceDir: source,
    provider: 'nanoclaw',
    sourceName: 'dm-with-test',
    extensions: ['.jsonl'],
    excludeDirs: ['subagents'],
    extract: 'claude-jsonl',
    timeZone: 'Asia/Singapore',
    now: () => '2026-09-15T02:00:00.000Z',
  });

  assert.equal(first.files, 1);
  assert.deepEqual(first.skippedDirs, ['old-session/subagents']);
  assert.equal(first.extraction.deltaRecords, 3);
  assert.deepEqual(first.extraction.deltaFiles, [
    '.alfred/private/conversations/nanoclaw/dm-with-test/deltas/2026-09-15.jsonl',
  ]);

  const deltaPath = path.join(vault, first.extraction.deltaFiles[0]);
  const records = fs.readFileSync(deltaPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((r) => r.role), ['user', 'assistant', 'user']);
  assert.match(records[0].text, /The user likes chess/);
  assert.match(records[1].text, /remember chess/);
  assert.match(records[2].text, /TELEGRAM_BOT_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(records.map((r) => r.text).join('\n'), /huge command output|private reasoning|123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc/);
  assert.equal(records[0].source_line, 1);
  assert.equal(records[2].redactions, 1);

  const second = importConversationFiles({
    vaultRoot: vault,
    sourceDir: source,
    provider: 'nanoclaw',
    sourceName: 'dm-with-test',
    extensions: ['.jsonl'],
    excludeDirs: ['subagents'],
    extract: 'claude-jsonl',
    timeZone: 'Asia/Singapore',
  });
  assert.equal(second.extraction.deltaRecords, 0);
  assert.equal(fs.readFileSync(deltaPath, 'utf8').trim().split('\n').length, 3);

  fs.appendFileSync(transcript, claudeLine({ role: 'user', content: [{ type: 'text', text: 'The user also likes climbing.' }] }) + '\n');
  const third = importConversationFiles({
    vaultRoot: vault,
    sourceDir: source,
    provider: 'nanoclaw',
    sourceName: 'dm-with-test',
    extensions: ['.jsonl'],
    excludeDirs: ['subagents'],
    extract: 'claude-jsonl',
    timeZone: 'Asia/Singapore',
  });
  assert.equal(third.extraction.deltaRecords, 1);
  const updated = fs.readFileSync(deltaPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(updated.length, 4);
  assert.match(updated[3].text, /climbing/);
});

test('importConversationFiles extract-only mode writes deltas without full transcript copy', () => {
  const vault = initVault({ ignored: true });
  const source = tmp('conversation-log-extract-only-source-');
  const transcript = path.join(source, 'session.jsonl');
  fs.writeFileSync(transcript, [
    claudeLine({ role: 'user', content: [{ type: 'text', text: 'The user likes piano.' }] }),
    '',
  ].join('\n'));

  const result = importConversationFiles({
    vaultRoot: vault,
    sourceDir: source,
    provider: 'nanoclaw',
    sourceName: 'dm-with-test',
    extensions: ['.jsonl'],
    extract: 'claude-jsonl',
    extractOnly: true,
    timeZone: 'Asia/Singapore',
  });

  assert.equal(result.extractOnly, true);
  assert.equal(result.files, 1);
  assert.equal(result.copied, 0);
  assert.equal(fs.existsSync(path.join(vault, '.alfred/private/conversations/nanoclaw/dm-with-test/session.jsonl')), false);

  const deltaPath = path.join(vault, result.extraction.deltaFiles[0]);
  const records = fs.readFileSync(deltaPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.match(records[0].text, /likes piano/);

  const manifest = fs.readFileSync(path.join(vault, result.manifestRel), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(manifest[0].extract_only, true);
  assert.equal(manifest[0].vault_rel, '');
  assert.equal(manifest[0].stored_bytes, 0);
});

test('importConversationFiles refuses extract-only without an extractor', () => {
  const vault = initVault({ ignored: true });
  const source = tmp('conversation-log-extract-only-no-extractor-');
  fs.writeFileSync(path.join(source, 'conversation.md'), 'User: hello\n');

  assert.throws(
    () => importConversationFiles({ vaultRoot: vault, sourceDir: source, extractOnly: true }),
    /--extract-only requires --extract/,
  );
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
