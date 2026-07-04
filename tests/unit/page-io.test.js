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

const { appendLog, autoCommit, autoCommitDisabled, regenerateIndex, readPageForWrite } =
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

test('readPageForWrite: malformed frontmatter refuses with exit 2 instead of silently dropping metadata', () => {
  const p = path.join(TMP, 'malformed.md');
  fs.writeFileSync(p, '---\nid: x\ntitle: Broken\nbody without closing marker\n');
  const seen = [];
  const origExit = process.exit;
  const origError = console.error;
  process.exit = (code) => {
    const err = new Error(`exit ${code}`);
    err.code = code;
    throw err;
  };
  console.error = (line) => seen.push(String(line));
  try {
    assert.throws(
      () => readPageForWrite(p),
      (err) => err instanceof Error && err.code === 2,
    );
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  assert.ok(seen.some((line) => line.includes('malformed frontmatter')));
  assert.ok(seen.some((line) => line.includes('silently drop all original metadata')));
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

test('autoCommit: git failure is loud but non-throwing, and leaves the write uncommitted', () => {
  const beforePath = process.env.PATH;
  const seen = [];
  const origError = console.error;
  console.error = (line) => seen.push(String(line));
  process.env.PATH = path.join(TMP, 'definitely-no-git-here');
  try {
    writePage('theta', 'Theta');
    assert.doesNotThrow(() => autoCommit('test', 'broken-git'));
  } finally {
    process.env.PATH = beforePath;
    console.error = origError;
  }
  assert.ok(seen.some((line) => line.includes('!!! auto-commit failed !!!')));
  assert.ok(seen.some((line) => line.includes('The write succeeded but is uncommitted.')));
  assert.ok(/wiki\/theta\.md/.test(porcelain()), 'failed auto-commit should leave the page dirty for recovery');
});

test('appendLog: redacts secrets in both wiki/log.md and the commit subject', () => {
  writePage('epsilon', 'Epsilon');
  appendLog('patch', 'Bearer aBcDeFgHiJkLmNoP1234567890');
  const log = fs.readFileSync(path.join(TMP, 'wiki', 'log.md'), 'utf-8');
  assert.match(log, /<REDACTED:bearer-token>/);
  assert.equal(log.includes('aBcDeFgHiJkLmNoP1234567890'), false);
  const subject = git('log', '-1', '--pretty=%s').trim();
  assert.match(subject, /<REDACTED:bearer-token>/);
  assert.equal(subject.includes('aBcDeFgHiJkLmNoP1234567890'), false);
});

test('regenerateIndex: writes wiki/index.md listing existing pages', () => {
  writePage('delta', 'Delta');
  regenerateIndex();
  const idx = fs.readFileSync(path.join(TMP, 'wiki', 'index.md'), 'utf-8');
  assert.match(idx, /delta/);
});
