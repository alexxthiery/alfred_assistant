// Unit tests for bin/lib/vault.js — focused on forEachPage. The constants
// (VAULT_ROOT etc.) are tested implicitly via fixture suite; this file covers
// the iteration helper that consolidates 30+ call sites in bin/wiki.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function mkTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vault-test-'));
  fs.mkdirSync(path.join(root, 'wiki'));
  return root;
}

function writePage(root, slug, fm, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(root, 'wiki', `${slug}.md`), lines.join('\n') + body);
}

function loadVaultFresh(root) {
  // Force a fresh require so VAULT_ROOT is recomputed under the test env.
  process.env.WIKI_ROOT = root;
  const vaultPath = path.resolve(__dirname, '..', '..', 'bin', 'lib', 'vault.js');
  delete require.cache[require.resolve(vaultPath)];
  return require(vaultPath);
}

test('forEachPage: visits every .md page once, skips index/log', () => {
  const root = mkTempVault();
  writePage(root, 'alice', { id: 'alice', title: 'Alice', type: 'entity' }, 'body-alice');
  writePage(root, 'bob',   { id: 'bob',   title: 'Bob',   type: 'entity' }, 'body-bob');
  fs.writeFileSync(path.join(root, 'wiki', 'index.md'), '# Index');
  fs.writeFileSync(path.join(root, 'wiki', 'log.md'), '# Log');

  const { forEachPage } = loadVaultFresh(root);
  const visited = [];
  forEachPage(({ slug }) => visited.push(slug));
  assert.deepEqual(visited.sort(), ['alice', 'bob']);
});

test('forEachPage: cb receives slug, file, absPath, fm, body, raw', () => {
  const root = mkTempVault();
  writePage(root, 'alice', { id: 'alice', title: 'Alice', type: 'entity' }, 'hello');

  const { forEachPage, WIKI_DIR } = loadVaultFresh(root);
  let captured = null;
  forEachPage((entry) => { captured = entry; });
  assert.equal(captured.slug, 'alice');
  assert.equal(captured.file, 'alice.md');
  assert.equal(captured.absPath, path.join(WIKI_DIR, 'alice.md'));
  assert.equal(captured.fm.id, 'alice');
  assert.equal(captured.fm.title, 'Alice');
  assert.equal(captured.body.trim(), 'hello');
  assert.ok(captured.raw.includes('title: Alice'));
});

test('forEachPage: returning false breaks the loop', () => {
  const root = mkTempVault();
  for (const slug of ['a', 'b', 'c', 'd']) writePage(root, slug, { id: slug, title: slug, type: 'entity' }, '');

  const { forEachPage } = loadVaultFresh(root);
  const visited = [];
  forEachPage(({ slug }) => {
    visited.push(slug);
    if (slug === 'b') return false;
  });
  // Pages sort alphabetically; iteration should stop after 'b'.
  assert.deepEqual(visited, ['a', 'b']);
});

test('forEachPage: non-false return values are ignored (iteration continues)', () => {
  const root = mkTempVault();
  for (const slug of ['x', 'y', 'z']) writePage(root, slug, { id: slug, title: slug, type: 'entity' }, '');

  const { forEachPage } = loadVaultFresh(root);
  const visited = [];
  forEachPage(({ slug }) => {
    visited.push(slug);
    return slug; // truthy, not false — should not break
  });
  assert.deepEqual(visited.sort(), ['x', 'y', 'z']);
});

test('forEachPage: empty vault is a no-op', () => {
  const root = mkTempVault();
  const { forEachPage } = loadVaultFresh(root);
  let calls = 0;
  forEachPage(() => calls++);
  assert.equal(calls, 0);
});

test('forEachPage: missing wiki/ dir is a no-op', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vault-test-')); // no wiki/ subdir
  const { forEachPage } = loadVaultFresh(root);
  let calls = 0;
  forEachPage(() => calls++);
  assert.equal(calls, 0);
});
