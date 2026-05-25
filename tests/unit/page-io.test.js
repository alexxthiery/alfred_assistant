// Unit tests for bin/lib/page-io.js — the side-effecting write-path helpers.
//
// page-io binds VAULT_ROOT at require time (via lib/vault.js → detectVaultRoot),
// whose first discovery step is the WIKI_ROOT env override. We set it to a
// throwaway git repo BEFORE requiring the module, so every helper operates on
// our temp vault. node --test runs each test file in its own process, so this
// env override does not leak into other suites.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pageio-'));
process.env.WIKI_ROOT = TMP;
delete process.env.WIKI_NO_AUTO_COMMIT;
delete process.env.WIKI_AUTOCOMMIT_STAGE_ALL;

const git = (...args) => execFileSync('git', args, { cwd: TMP, encoding: 'utf-8' });
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
git('commit', '--allow-empty', '-q', '-m', 'root');

const { autoCommit, autoCommitDisabled, regenerateIndex, readPageForWrite } =
  require('../../bin/lib/page-io.js');

const writePage = (slug, title) => {
  fs.mkdirSync(path.join(TMP, 'wiki'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, 'wiki', `${slug}.md`),
    `---\nid: ${slug}\ntitle: ${title}\ntype: note\ntags: []\n---\n- [fact] seed ^[t:1]\n`,
  );
};
const porcelain = () => git('status', '--porcelain').trim();

test('autoCommitDisabled: honors WIKI_NO_AUTO_COMMIT truthiness', () => {
  delete process.env.WIKI_NO_AUTO_COMMIT;
  assert.equal(autoCommitDisabled(), false);
  for (const v of ['1', 'true', 'yes']) {
    process.env.WIKI_NO_AUTO_COMMIT = v;
    assert.equal(autoCommitDisabled(), true, `"${v}" should disable`);
  }
  for (const v of ['0', 'false']) {
    process.env.WIKI_NO_AUTO_COMMIT = v;
    assert.equal(autoCommitDisabled(), false, `"${v}" should not disable`);
  }
  delete process.env.WIKI_NO_AUTO_COMMIT;
});

test('readPageForWrite: parses a well-formed page into fm + body', () => {
  const p = path.join(TMP, 'sample.md');
  fs.writeFileSync(p, '---\nid: x\ntitle: X\ntype: note\n---\nhello body\n');
  const { fm, body } = readPageForWrite(p);
  assert.equal(fm.id, 'x');
  assert.equal(fm.title, 'X');
  assert.match(body, /hello body/);
});

test('autoCommit: scoped staging commits wiki/ but leaves a stray root file dirty', () => {
  writePage('alpha', 'Alpha');
  fs.writeFileSync(path.join(TMP, 'stray.md'), 'out-of-band\n');
  autoCommit('test', 'scoped');
  const status = porcelain();
  // wiki/alpha.md was committed → not in status; stray.md untracked → present.
  assert.ok(!status.includes('wiki/alpha.md'), `wiki page should be committed; status:\n${status}`);
  assert.ok(/stray\.md/.test(status), `stray root file should remain dirty; status:\n${status}`);
  assert.match(git('log', '-1', '--pretty=%s'), /^test \| scoped/);
});

test('autoCommit: stage-all (WIKI_AUTOCOMMIT_STAGE_ALL) sweeps the stray root file too', () => {
  process.env.WIKI_AUTOCOMMIT_STAGE_ALL = '1';
  try {
    writePage('beta', 'Beta');
    fs.writeFileSync(path.join(TMP, 'stray2.md'), 'accepted\n');
    autoCommit('bless', 'stage-all');
    const status = porcelain();
    assert.equal(status, '', `stage-all should leave a clean tree; status:\n${status}`);
  } finally {
    delete process.env.WIKI_AUTOCOMMIT_STAGE_ALL;
  }
});

test('autoCommit: disabled → no commit, working tree untouched', () => {
  process.env.WIKI_NO_AUTO_COMMIT = '1';
  try {
    const before = git('rev-parse', 'HEAD').trim();
    writePage('gamma', 'Gamma');
    autoCommit('test', 'disabled');
    assert.equal(git('rev-parse', 'HEAD').trim(), before, 'HEAD must not advance');
    assert.ok(/wiki\/gamma\.md/.test(porcelain()), 'page stays uncommitted');
  } finally {
    delete process.env.WIKI_NO_AUTO_COMMIT;
  }
});

test('regenerateIndex: writes wiki/index.md listing existing pages', () => {
  writePage('delta', 'Delta');
  regenerateIndex();
  const idx = fs.readFileSync(path.join(TMP, 'wiki', 'index.md'), 'utf-8');
  assert.match(idx, /delta/);
});
