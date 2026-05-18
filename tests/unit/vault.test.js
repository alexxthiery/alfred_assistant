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

// ─── HR24: forEachPage({cache:true}) opt-in ────────────────────────────────

test('HR24 cache: default mode re-reads disk on every call (no cache)', () => {
  const root = mkTempVault();
  writePage(root, 'a', { id: 'a', title: 'A', type: 'entity' }, 'first-body');
  const { forEachPage } = loadVaultFresh(root);
  let firstBody;
  forEachPage(({ body }) => { firstBody = body; });
  assert.match(firstBody, /first-body/);
  // Mutate the file on disk.
  fs.writeFileSync(path.join(root, 'wiki', 'a.md'), '---\nid: a\n---\nMUTATED');
  let secondBody;
  forEachPage(({ body }) => { secondBody = body; });
  assert.match(secondBody, /MUTATED/, 'no-cache mode should see the disk update');
});

test('HR24 cache: cache:true snapshots on first call, hits memory on second', () => {
  const root = mkTempVault();
  writePage(root, 'a', { id: 'a', title: 'A', type: 'entity' }, 'cached-body');
  const { forEachPage } = loadVaultFresh(root);
  let firstBody;
  forEachPage(({ body }) => { firstBody = body; }, { cache: true });
  assert.match(firstBody, /cached-body/);
  // Mutate disk — cached subsequent call should NOT see it.
  fs.writeFileSync(path.join(root, 'wiki', 'a.md'), '---\nid: a\n---\nSTALE');
  let secondBody;
  forEachPage(({ body }) => { secondBody = body; }, { cache: true });
  assert.match(secondBody, /cached-body/, 'cached mode pins the first snapshot');
  assert.equal(secondBody.includes('STALE'), false);
});

test('HR24 cache: invalidatePageCache forces re-read on next cached call', () => {
  const root = mkTempVault();
  writePage(root, 'a', { id: 'a', title: 'A', type: 'entity' }, 'v1');
  const { forEachPage, invalidatePageCache } = loadVaultFresh(root);
  let b1;
  forEachPage(({ body }) => { b1 = body; }, { cache: true });
  fs.writeFileSync(path.join(root, 'wiki', 'a.md'), '---\nid: a\n---\nv2');
  invalidatePageCache();
  let b2;
  forEachPage(({ body }) => { b2 = body; }, { cache: true });
  assert.match(b2, /v2/, 'after invalidate, cached call rebuilds the snapshot');
});

test('HR24 cache: cached and uncached calls in the same process do not corrupt each other', () => {
  const root = mkTempVault();
  writePage(root, 'a', { id: 'a', title: 'A', type: 'entity' }, 'orig');
  const { forEachPage } = loadVaultFresh(root);
  // Prime the cache.
  let cachedBody;
  forEachPage(({ body }) => { cachedBody = body; }, { cache: true });
  assert.match(cachedBody, /orig/);
  // Mutate disk.
  fs.writeFileSync(path.join(root, 'wiki', 'a.md'), '---\nid: a\n---\nNEW');
  // Uncached call sees the update.
  let liveBody;
  forEachPage(({ body }) => { liveBody = body; });
  assert.match(liveBody, /NEW/);
  // Cached call still sees the original.
  let stillCached;
  forEachPage(({ body }) => { stillCached = body; }, { cache: true });
  assert.match(stillCached, /orig/);
});
