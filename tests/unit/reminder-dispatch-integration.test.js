// Integration test for bin/reminder-dispatch — the stamp-before-send contract.
//
// Regression guard for the duplicate-reminder bug: a reminder whose stamp write
// fails (e.g. an event-keyword title tripping mislabeled-event, or a dirty
// vault tamper-block) used to re-fire every cron tick. The fix: stamp first
// (with --soft), and only emit the ones that stamped — a failed stamp HOLDS the
// reminder instead of spamming.
//
// Drives the real binary against a git-backed temp vault (the pure-core unit
// tests in reminder-dispatch.test.js can't reach the stamp/spawn path).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WIKI = path.join(REPO, 'bin', 'wiki');
const DISPATCH = path.join(REPO, 'bin', 'reminder-dispatch');
const TEMPLATE = path.join(REPO, 'tests', 'vault');

function cpDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpDir(s, d); else fs.copyFileSync(s, d);
  }
}
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}
function run(bin, args, cwd) {
  return spawnSync('node', [bin, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, WIKI_ROOT: cwd, ALFRED_NO_RTK: '1' } });
}
function freshVault() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-reminder-'));
  cpDir(TEMPLATE, tmp);
  git(tmp, ['init', '-q']);
  git(tmp, ['config', 'user.email', 'test@example.com']);
  git(tmp, ['config', 'user.name', 'Test']);
  git(tmp, ['add', '-A']);
  git(tmp, ['commit', '-q', '-m', 'initial']);
  return tmp;
}

test('reminder-dispatch: event-keyword-title reminder fires once and stamps (no re-fire)', () => {
  const v = freshVault();
  try {
    // "meeting" in the title would trip mislabeled-event on a type:todo — the
    // exact case that blocked the stamp and caused duplicate sends.
    const add = run(WIKI, ['todo', 'add', 'Zoom meeting strategy', '--due', '2026-05-22',
      '--remind_at', '2026-05-22T10:00:00+08:00'], v);
    assert.equal(add.status, 0, `todo add should succeed: ${add.stderr}`);

    const d1 = run(DISPATCH, ['--now', '2026-05-22T03:00:00Z', '--no-log'], v);
    assert.equal(d1.status, 0, `dispatch should succeed: ${d1.stderr}`);
    assert.match(d1.stdout, /Reminder: Zoom meeting strategy/, 'fires once');

    // The reminder is now stamped → a second run emits nothing (idempotent).
    const d2 = run(DISPATCH, ['--now', '2026-05-22T03:30:00Z', '--no-log'], v);
    assert.equal(d2.status, 0);
    assert.equal(d2.stdout.trim(), '', 'must NOT re-fire after stamping');
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('reminder-dispatch: a stamp that cannot land HOLDS the reminder (no send) instead of spamming', () => {
  const v = freshVault();
  try {
    run(WIKI, ['todo', 'add', 'Plain reminder', '--due', '2026-05-22',
      '--remind_at', '2026-05-22T10:00:00+08:00'], v);
    // Dirty the vault out-of-band so the stamp patch is tamper-blocked.
    fs.appendFileSync(path.join(v, 'wiki', 'index.md'), '\nstray\n');

    const d = run(DISPATCH, ['--now', '2026-05-22T03:00:00Z', '--no-log'], v);
    assert.equal(d.status, 0, 'dispatch itself does not crash');
    assert.equal(d.stdout.trim(), '', 'held: nothing sent while the stamp cannot land');
    assert.match(d.stderr, /HELD/, 'logs that the reminder was held');
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});
