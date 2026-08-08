// Integration test for the tamper-check hard-block (15A).
//
// Spins up a real git-backed temp vault and drives the actual `wiki` binary:
//   - a write through wiki auto-commits, leaving the tree clean;
//   - a raw (out-of-band) edit makes the tree dirty;
//   - the next write-class verb is REFUSED (exit 3);
//   - `--accept-tamper` and `wiki bless` both clear the block.
//
// This exercises the runtime-independent write-guard end to end (git layer),
// which the pure-unit suites can't reach.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WIKI = path.join(REPO, 'bin', 'wiki');
const TEMPLATE = path.join(REPO, 'tests', 'vault');

function cpDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpDir(s, d); else fs.copyFileSync(s, d);
  }
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r;
}

function wiki(cwd, args) {
  // Explicitly clear WIKI_NO_AUTO_COMMIT so the integrity layer is live.
  const env = { ...process.env, WIKI_ROOT: cwd };
  delete env.WIKI_NO_AUTO_COMMIT;
  return spawnSync('node', [WIKI, ...args], { cwd, env, encoding: 'utf-8' });
}

function freshVault() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-tamper-'));
  cpDir(TEMPLATE, tmp);
  git(tmp, ['init', '-q']);
  git(tmp, ['config', 'user.email', 'test@example.com']);
  git(tmp, ['config', 'user.name', 'Test']);
  git(tmp, ['add', '-A']);
  git(tmp, ['commit', '-q', '-m', 'initial']);
  return tmp;
}

test('tamper-check blocks a write after an out-of-band edit; escape hatches clear it', () => {
  const v = freshVault();
  try {
    // 1. A write through wiki succeeds and auto-commits (tree clean after).
    const w = wiki(v, ['write', 'tamper-host', '--title', 'Tamper host', '--type', 'concept',
      '--tags', 'meta', '--content', '- [fact] seed ^[t:1]', '--soft']);
    assert.equal(w.status, 0, `wiki write should succeed: ${w.stderr}`);
    assert.equal(git(v, ['status', '--porcelain']).stdout.trim(), '', 'tree clean after auto-commit');

    // 2. Raw edit bypassing wiki → tree dirty.
    fs.appendFileSync(path.join(v, 'wiki', 'tamper-host.md'), '\n- [fact] snuck in raw ^[t:1]\n');

    // 3. Next write-class verb is refused (exit 3) and says why.
    const blocked = wiki(v, ['patch', 'tamper-host', '--observation', '[fact] via cli ^[t:1]']);
    assert.equal(blocked.status, 3, 'write must be refused while tree is dirty');
    assert.match(blocked.stderr, /tamper-check/i);

    // 4. --accept-tamper proceeds (folds the raw edit in).
    const accepted = wiki(v, ['patch', 'tamper-host', '--observation', '[fact] via cli ^[t:1]', '--accept-tamper']);
    assert.equal(accepted.status, 0, `--accept-tamper should proceed: ${accepted.stderr}`);
    assert.equal(git(v, ['status', '--porcelain']).stdout.trim(), '', 'tree clean after accept+commit');

    // 5. bless path: dirty again, bless commits it, next write proceeds.
    fs.appendFileSync(path.join(v, 'wiki', 'tamper-host.md'), '\n- [fact] another raw ^[t:1]\n');
    const bless = wiki(v, ['bless']);
    assert.equal(bless.status, 0, `bless should succeed: ${bless.stderr}`);
    assert.equal(git(v, ['status', '--porcelain']).stdout.trim(), '', 'tree clean after bless');
    const after = wiki(v, ['patch', 'tamper-host', '--observation', '[fact] post-bless ^[t:1]']);
    assert.equal(after.status, 0, `write after bless should proceed: ${after.stderr}`);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('groom --mechanical commits cleanly — no leftover dirty index.md (V5)', () => {
  const v = freshVault();
  try {
    // A write through wiki leaves a clean tree.
    const w = wiki(v, ['write', 'groom-host', '--title', 'Groom host', '--type', 'concept',
      '--tags', 'meta', '--content', '- [fact] seed ^[t:1]', '--soft']);
    assert.equal(w.status, 0, `seed write should succeed: ${w.stderr}`);
    assert.equal(git(v, ['status', '--porcelain']).stdout.trim(), '', 'clean after seed write');
    // groom regenerates the index (+ maybe autolinks); it must commit its own
    // output, not leave index.md dirty for the next command to trip on.
    const g = wiki(v, ['groom', '--mechanical']);
    assert.equal(g.status, 0, `groom should succeed: ${g.stderr}`);
    assert.equal(git(v, ['status', '--porcelain']).stdout.trim(), '', 'tree clean after groom (V5)');
    // The next write-class verb must NOT be tamper-blocked.
    const after = wiki(v, ['patch', 'groom-host', '--observation', '[fact] post-groom ^[t:1]']);
    assert.equal(after.status, 0, `write after groom should proceed (not tamper-blocked): ${after.stderr}`);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('autolink command commits page edits and regenerated index together', () => {
  const v = freshVault();
  try {
    const target = wiki(v, ['write', 'banana-bread', '--title', 'Banana Bread', '--type', 'concept',
      '--tags', 'meta', '--content', '- [fact] target page ^[telegram:2026-06-03]', '--soft']);
    assert.equal(target.status, 0, `target write should succeed: ${target.stderr}`);
    const source = wiki(v, ['write', 'recipe-notes', '--title', 'Recipe Notes', '--type', 'concept',
      '--tags', 'meta', '--content', '- [fact] Banana Bread appears here ^[telegram:2026-06-03]', '--soft', '--no-autolink']);
    assert.equal(source.status, 0, `source write should succeed: ${source.stderr}`);
    assert.equal(git(v, ['status', '--porcelain']).stdout.trim(), '', 'clean after setup writes');
    const beforeCount = Number(git(v, ['rev-list', '--count', 'HEAD']).stdout.trim());

    const a = wiki(v, ['autolink', 'banana-bread', '--direction', 'in']);
    assert.equal(a.status, 0, `autolink should succeed: ${a.stderr}`);
    assert.match(fs.readFileSync(path.join(v, 'wiki', 'recipe-notes.md'), 'utf-8'), /\[\[banana-bread\]\]/);
    assert.equal(git(v, ['status', '--porcelain']).stdout.trim(), '', 'tree clean after autolink + index regen');
    const afterCount = Number(git(v, ['rev-list', '--count', 'HEAD']).stdout.trim());
    assert.equal(afterCount, beforeCount + 1, 'autolink command should make one final commit');
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('tamper-check is a no-op when the vault is not a git repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-nogit-'));
  cpDir(TEMPLATE, tmp);
  try {
    // No git init. A write should just work (integrity layer dormant).
    const w = wiki(tmp, ['write', 'nogit-host', '--title', 'No git', '--type', 'concept',
      '--tags', 'meta', '--content', '- [fact] seed ^[t:1]', '--soft']);
    assert.equal(w.status, 0, `write should succeed without git: ${w.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
