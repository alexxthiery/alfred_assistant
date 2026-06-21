// Smoke tests for the `output/` convention (docs/CONVENTIONS.md § Output directory).
//
// `output/` is untracked free-form space for Alfred-authored deliverables. The
// safety guarantee documented in CONVENTIONS.md is git-mechanical, not a bespoke
// code path: because `output/` is gitignored, neither auto-commit nor the
// `git add -A` that `wiki bless` / `--accept-tamper` run can sweep a deliverable
// into a vault commit, and a dirty `output/` never trips tamper-check.
//
// These tests pin that guarantee against (a) the actual shipped
// examples/example-vault/.gitignore and (b) the real autoCommit / tamperCheck
// code paths in bin/lib/page-io.js. They fail loudly if the ignore pattern is
// dropped/typo'd, if bless's stage-all path starts committing output/, or if
// tamper-check starts blocking on it.
//
// Like page-io.test.js, page-io binds VAULT_ROOT at require time from WIKI_ROOT,
// so we set that to a throwaway git repo BEFORE requiring the module. node --test
// gives each file its own process, so the env override does not leak.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIPPED_GITIGNORE = path.join(REPO_ROOT, 'examples', 'example-vault', '.gitignore');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'outputdir-'));
process.env.WIKI_ROOT = TMP;
delete process.env.WIKI_NO_AUTO_COMMIT;
delete process.env.WIKI_AUTOCOMMIT_STAGE_ALL;

const git = (...args) => execFileSync('git', args, { cwd: TMP, encoding: 'utf-8' });
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');

// Use the REAL shipped ignore file as the repo's root .gitignore. If someone
// drops `output/` from the published example, these tests break — which is the
// point: the convention is only portable if the shipped artifact carries it.
fs.copyFileSync(SHIPPED_GITIGNORE, path.join(TMP, '.gitignore'));
git('add', '.gitignore');
git('commit', '-q', '-m', 'root: gitignore');

const { autoCommit, tamperCheck } = require('../../bin/lib/page-io.js');

const tracked = () => git('ls-files').split('\n').filter(Boolean);
const writeWikiPage = (slug) => {
  fs.mkdirSync(path.join(TMP, 'wiki'), { recursive: true });
  fs.writeFileSync(
    path.join(TMP, 'wiki', `${slug}.md`),
    `---\nid: ${slug}\ntitle: ${slug}\ntype: note\ntags: []\n---\n- [fact] seed ^[t:1]\n`,
  );
};
const writeOutputFile = (name) => {
  fs.mkdirSync(path.join(TMP, 'output'), { recursive: true });
  const p = path.join(TMP, 'output', name);
  fs.writeFileSync(p, '# deliverable\n\none-off summary\n');
  return p;
};

test('shipped example-vault .gitignore actually ignores output/ (git is the oracle)', () => {
  // check-ignore exits 0 (and echoes the path) when ignored, non-zero otherwise.
  // execFileSync throws on non-zero exit, so a throw means "not ignored".
  let ignored = true;
  try {
    git('check-ignore', 'output/report.md');
  } catch {
    ignored = false;
  }
  assert.ok(
    ignored,
    'examples/example-vault/.gitignore must match output/ — the convention is not portable otherwise',
  );
  // Substring presence is necessary but not sufficient; the check-ignore oracle
  // above also catches a pattern that is present but mis-anchored (e.g. `/output`
  // vs `output/`). Keep the cheap presence assertion as a readable second signal.
  assert.match(fs.readFileSync(SHIPPED_GITIGNORE, 'utf-8'), /^output\/$/m);
});

test('bless stage-all (git add -A) commits wiki/ but cannot sweep a gitignored output/ deliverable', () => {
  writeWikiPage('alpha');
  const deliverable = writeOutputFile('report.md');

  process.env.WIKI_AUTOCOMMIT_STAGE_ALL = '1';
  try {
    // This is the path `wiki bless` / `--accept-tamper` take: stage everything.
    autoCommit('bless', 'accept-state');
  } finally {
    delete process.env.WIKI_AUTOCOMMIT_STAGE_ALL;
  }

  const files = tracked();
  assert.ok(files.includes('wiki/alpha.md'), `wiki page should be committed; tracked:\n${files.join('\n')}`);
  assert.ok(
    !files.some((f) => f.startsWith('output/')),
    `output/ deliverable must NOT be tracked even under stage-all; tracked:\n${files.join('\n')}`,
  );
  assert.ok(fs.existsSync(deliverable), 'the deliverable must remain on disk (committing it elsewhere is not the concern)');
});

test('tamper-check does not block (exit 3) when only output/ is dirty', () => {
  // Tree is clean from git's view (prior test committed wiki/alpha.md; output/
  // is ignored). Add a fresh deliverable: git status --porcelain omits ignored
  // paths, so tamperCheck must see a clean tree and return without exiting.
  writeOutputFile('another.md');
  assert.equal(git('status', '--porcelain').trim(), '', 'sanity: output/ must be invisible to git status');

  const origExit = process.exit;
  let exited = null;
  process.exit = (code) => {
    exited = code;
    throw new Error(`unexpected process.exit(${code})`);
  };
  try {
    tamperCheck({ accept: false }); // must return normally
  } finally {
    process.exit = origExit;
  }
  assert.equal(exited, null, 'tamper-check must not block a write just because output/ has unsaved deliverables');
});
