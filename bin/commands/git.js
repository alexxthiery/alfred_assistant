// commands/git.js — `wiki diff` / `wiki revert`: inspect and undo vault
// auto-commits. Thin wrappers over git in the vault repo; revert regenerates
// the index afterward so derived files stay consistent.

'use strict';

const fs = require('fs');
const path = require('path');
const { VAULT_ROOT } = require('../lib/vault.js');
const { regenerateIndex } = require('../lib/page-io.js');

function cmdDiff(args) {
  const gitDir = path.join(VAULT_ROOT, '.git');
  if (!fs.existsSync(gitDir)) {
    console.error('not a git repo: run `git init` in vault first');
    process.exit(2);
  }
  // Array-form spawnSync — `since` (user input via --since) is passed as a
  // single argv entry, no shell parsing.
  const { spawnSync } = require('child_process');
  const since = args.since || '24 hours ago';
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const r = spawnSync('git',
    ['log', `--since=${since}`, '--stat', '--pretty=format:%h %ad | %s', '--date=short'],
    { cwd: VAULT_ROOT, env, encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    console.error('git log failed:', ((r.stderr || '').split('\n')[0]) || (r.error && r.error.message) || `exit ${r.status}`);
    process.exit(2);
  }
  if (!(r.stdout || '').trim()) {
    console.log(`(no commits since ${since})`);
    return;
  }
  console.log(r.stdout);
}

function cmdRevert(args) {
  const gitDir = path.join(VAULT_ROOT, '.git');
  if (!fs.existsSync(gitDir)) {
    console.error('not a git repo');
    process.exit(2);
  }
  const target = args._ && args._[0] ? args._[0] : 'HEAD';
  // Array-form spawnSync — `target` (user-supplied SHA or HEAD) is passed as
  // a separate argv entry, no shell interpolation.
  const { spawnSync } = require('child_process');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: VAULT_ROOT, env, encoding: 'utf-8' });
  if (status.error) { console.error('git status failed:', status.error.message); process.exit(2); }
  const dirty = (status.stdout || '').trim();
  if (dirty) {
    console.error('working tree is dirty — commit or stash first:');
    console.error(dirty);
    process.exit(2);
  }
  const r = spawnSync('git',
    ['-c', 'commit.gpgsign=false', 'revert', '--no-edit', target],
    { cwd: VAULT_ROOT, env, stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    console.error('revert failed:', (r.error && r.error.message) || `exit ${r.status}`);
    process.exit(2);
  }
  regenerateIndex();
  console.log(`reverted ${target}`);
  console.log('(auto-commit batches dirty files into one commit, so revert may undo more than expected)');
}

module.exports = { cmdDiff, cmdRevert };
