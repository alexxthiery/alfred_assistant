// Unit tests for bin/lib/staged-writes.js.
//
// Pins the atomicity contract used by cmdIngest (M08), cmdMerge (HR03), and
// any future write-class verb that batches multiple page writes per logical
// operation. See audit/12 § concurrency-atomicity.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { flushStaged, STAGED_TMP_RE } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'staged-writes.js')
);

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-staged-'));
}

test('flushStaged: empty map is a no-op', () => {
  const dir = mkTempDir();
  flushStaged(new Map(), { tag: 'test' });
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('flushStaged: writes every staged entry to its absolute path', () => {
  const dir = mkTempDir();
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');
  const staged = new Map([[a, 'content-a'], [b, 'content-b']]);
  flushStaged(staged, { tag: 'test' });
  assert.equal(fs.readFileSync(a, 'utf-8'), 'content-a');
  assert.equal(fs.readFileSync(b, 'utf-8'), 'content-b');
});

test('flushStaged: leaves no temp files behind on success', () => {
  const dir = mkTempDir();
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');
  flushStaged(new Map([[a, 'x'], [b, 'y']]), { tag: 'unit', pid: 9999 });
  const entries = fs.readdirSync(dir);
  const tmpRe = STAGED_TMP_RE('unit');
  const orphans = entries.filter((e) => tmpRe.test(e));
  assert.deepEqual(orphans, [], `expected no .tmp-unit-* debris, got ${orphans.join(',')}`);
  assert.deepEqual(entries.sort(), ['a.md', 'b.md']);
});

test('flushStaged: temp filename includes the tag (for debug grep)', () => {
  // Sanity-check the tag flows into the temp-filename shape. We don't have
  // a hook to observe mid-flush, but we can verify STAGED_TMP_RE matches
  // the documented pattern.
  const re = STAGED_TMP_RE('myverb');
  assert.ok(re.test('/abs/path/page.md.tmp-myverb-12345'));
  assert.ok(re.test('page.md.tmp-myverb-1'));
  assert.equal(re.test('page.md.tmp-otherverb-1'), false);
  assert.equal(re.test('page.md.tmp-myverb-'), false); // requires a numeric pid
});

test('flushStaged: rename is atomic (target sees full content, never partial)', () => {
  // Filesystem atomicity of rename is guaranteed by POSIX; this test just
  // confirms we go through the rename path (not direct writeFileSync to
  // the target). We do that by intercepting fs.renameSync.
  const dir = mkTempDir();
  const target = path.join(dir, 'target.md');
  const observed = [];
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { observed.push({ from, to }); return realRename(from, to); };
  try {
    flushStaged(new Map([[target, 'final']]), { tag: 't', pid: 7 });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(observed.length, 1);
  assert.equal(observed[0].to, target);
  assert.match(observed[0].from, /\.tmp-t-7$/);
  assert.equal(fs.readFileSync(target, 'utf-8'), 'final');
});

test('flushStaged: a fs.writeFileSync throw aborts WITHOUT renaming partially-staged temps', () => {
  // Simulate disk-full / EACCES partway through the flush. The pattern is:
  // if the writeFileSync at entry N throws, entries 0..N-1 have ALREADY been
  // renamed into place (the contract is per-file atomic, not cross-file).
  // This test pins that documented behavior: target files for entries that
  // were processed already get the new content; entries past the throw site
  // do NOT.
  const dir = mkTempDir();
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');
  fs.writeFileSync(a, 'orig-a');
  fs.writeFileSync(b, 'orig-b');

  const real = fs.writeFileSync;
  fs.writeFileSync = (p, content) => {
    if (typeof p === 'string' && p.includes('b.md.tmp-')) {
      throw new Error('simulated disk full');
    }
    return real(p, content);
  };

  let thrown = null;
  try {
    flushStaged(new Map([[a, 'new-a'], [b, 'new-b']]), { tag: 'fail', pid: 1 });
  } catch (e) {
    thrown = e;
  } finally {
    fs.writeFileSync = real;
  }

  assert.equal(thrown.message, 'simulated disk full');
  assert.equal(fs.readFileSync(a, 'utf-8'), 'new-a', "a.md was processed before the throw — should be updated");
  assert.equal(fs.readFileSync(b, 'utf-8'), 'orig-b', "b.md throw happened during temp-write — original content survives");
});
