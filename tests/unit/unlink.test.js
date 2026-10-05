// Unit tests for bin/lib/unlink.js.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { applyUnlinks } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'unlink.js'));

const LINE = '- [fact] Award from the Clay [[mathematics]] Institute. <!--obs:aaaaaa-->';
const entry = (over = {}) => ({ line: LINE, offset: LINE.indexOf('[[mathematics]]'), target: 'mathematics', original: 'Mathematics', ...over });

test('applyUnlinks: swaps the exact link back to its original words', () => {
  const out = applyUnlinks(`intro\n${LINE}\n`, [entry()]);
  assert.equal(out.applied, 1);
  assert.ok(out.body.includes('the Clay Mathematics Institute.'));
  assert.deepEqual(out.skipped, []);
});

test('applyUnlinks: leaves other links on the same line intact', () => {
  const line = '- [fact] Met [[tobin-varga]] at the Clay [[mathematics]] Institute.';
  const out = applyUnlinks(line, [{ line, offset: line.indexOf('[[mathematics]]'), target: 'mathematics', original: 'Mathematics' }]);
  assert.equal(out.body, '- [fact] Met [[tobin-varga]] at the Clay Mathematics Institute.');
});

test('applyUnlinks: two links on one line both revert using original offsets', () => {
  const line = 'Dept of Applied [[mathematics]] & [[statistics]], Example U';
  const out = applyUnlinks(line, [
    { line, offset: line.indexOf('[[mathematics]]'), target: 'mathematics', original: 'Mathematics' },
    { line, offset: line.indexOf('[[statistics]]'), target: 'statistics', original: 'Statistics' },
  ]);
  assert.equal(out.body, 'Dept of Applied Mathematics & Statistics, Example U');
  assert.equal(out.applied, 2);
});

test('applyUnlinks: a duplicated spec entry is applied once', () => {
  const out = applyUnlinks(LINE, [entry(), entry()]);
  assert.equal(out.applied, 1);
  assert.ok(out.body.includes('the Clay Mathematics Institute.'));
});

test('applyUnlinks: identical duplicate lines are all repaired', () => {
  const out = applyUnlinks(`${LINE}\n${LINE}`, [entry()]);
  assert.equal(out.applied, 2);
  assert.equal(out.body.includes('[[mathematics]]'), false);
});

test('applyUnlinks: a line edited since the spec was made is skipped, not guessed', () => {
  const out = applyUnlinks(LINE.replace('Award', 'Prize'), [entry()]);
  assert.equal(out.applied, 0);
  assert.equal(out.skipped[0].reason, 'line-not-found');
});

test('applyUnlinks: wrong offset or target is skipped', () => {
  const out = applyUnlinks(LINE, [entry({ offset: 3 }), entry({ target: 'physics' })]);
  assert.equal(out.applied, 0);
  assert.deepEqual(out.skipped.map((s) => s.reason), ['link-mismatch', 'link-mismatch']);
  assert.equal(out.body, LINE);
});

// ─── CLI: wiki fix-links --unlink ──────────────────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');

function cliVault(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-unlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(REPO, 'tests', 'vault'), root, { recursive: true });
  return root;
}

function wiki(root, args) {
  return spawnSync(process.execPath, [path.join(REPO, 'bin', 'wiki'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, WIKI_ROOT: root, WIKI_NO_AUTO_COMMIT: '1' },
  });
}

test('fix-links --unlink: dry-run reports, --apply reverts only listed links, stale entry skipped', (t) => {
  const root = cliVault(t);
  const page = path.join(root, 'wiki', 'unlink-target.md');
  const line = 'Award from the Clay [[mathematics]] Institute. Also [[mathematics]] here.';
  fs.writeFileSync(page, `---\ntitle: Unlink target\ntype: note\ntags: [meta]\n---\n${line}\n`);
  const spec = path.join(root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify([
    { slug: 'unlink-target', line, offset: line.indexOf('[[mathematics]]'), target: 'mathematics', original: 'Mathematics' },
    { slug: 'unlink-target', line: 'gone line [[x]]', offset: 10, target: 'x', original: 'X' },
  ]));

  const dry = wiki(root, ['fix-links', '--unlink', spec]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run; 1 link\(s\) in 1 page\(s\), 1 skipped/);
  assert.ok(fs.readFileSync(page, 'utf8').includes('Clay [[mathematics]] Institute'), 'dry-run must not write');

  const run = wiki(root, ['fix-links', '--unlink', spec, '--apply']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /SKIP\s+unlink-target: \[\[x\]\] \(line-not-found\)/);
  const after = fs.readFileSync(page, 'utf8');
  assert.ok(after.includes('Clay Mathematics Institute. Also [[mathematics]] here.'));
});

test('fix-links --unlink: malformed spec exits non-zero without writing', (t) => {
  const root = cliVault(t);
  const spec = path.join(root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify([{ slug: 'x' }]));
  const r = wiki(root, ['fix-links', '--unlink', spec, '--apply']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /bad --unlink entry/);
});
