// Unit tests for the mtime-keyed memoization in bin/lib/schema.js::loadSchema.
// Per HR22 / audit/14-perf-efficiency.md § schema-load-redundancy.
//
// Catches: a broken cache that always returns the first value (no invalidation
// on file change) or one that never caches (re-parses on every call).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schemaModulePath = path.resolve(__dirname, '..', '..', 'bin', 'lib', 'schema.js');
const { loadSchema, _schemaCache } = require(schemaModulePath);

function mkTempSchema(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-schema-memo-'));
  const p = path.join(dir, 'SCHEMA.md');
  fs.writeFileSync(p, content);
  return p;
}

const MIN_SCHEMA_V1 = `## Tag taxonomy (closed set, CLI-enforced)
\`\`\`
person
\`\`\`
`;

const MIN_SCHEMA_V2 = `## Tag taxonomy (closed set, CLI-enforced)
\`\`\`
person
org
\`\`\`
`;

test('loadSchema: second call with unchanged file returns SAME object reference (cached)', () => {
  const p = mkTempSchema(MIN_SCHEMA_V1);
  _schemaCache.clear();
  const a = loadSchema(p);
  const b = loadSchema(p);
  // Reference equality proves the second call returned the cached value;
  // an unmemoized loadSchema would return a freshly-parsed object each time.
  assert.equal(a, b);
});

test('loadSchema: returns parsed shape on first call', () => {
  const p = mkTempSchema(MIN_SCHEMA_V1);
  _schemaCache.clear();
  const s = loadSchema(p);
  assert.ok(s.tags.has('person'));
  assert.equal(s.tags.size, 1);
});

test('loadSchema: cache invalidates when file mtime changes', () => {
  const p = mkTempSchema(MIN_SCHEMA_V1);
  _schemaCache.clear();
  const v1 = loadSchema(p);
  assert.equal(v1.tags.size, 1);

  // Rewrite the file AND bump mtime past the previous value (fs.writeFileSync
  // already touches mtime; we also call fs.utimes to guarantee a different
  // mtimeMs even on filesystems with coarse mtime resolution).
  fs.writeFileSync(p, MIN_SCHEMA_V2);
  const future = Date.now() / 1000 + 5;
  fs.utimesSync(p, future, future);

  const v2 = loadSchema(p);
  assert.notEqual(v1, v2);
  assert.equal(v2.tags.size, 2);
  assert.ok(v2.tags.has('org'));
});

test('loadSchema: missing file returns empty sentinel and is cached', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-schema-memo-'));
  const p = path.join(dir, 'does-not-exist.md');
  _schemaCache.clear();
  const a = loadSchema(p);
  const b = loadSchema(p);
  assert.equal(a, b); // both calls hit the cache (mtime: -1)
  assert.equal(a.tags, null); // empty sentinel — null distinguishes "no schema" from "schema declares no tags"
});

test('loadSchema: multi-path cache keeps entries independent', () => {
  const p1 = mkTempSchema(MIN_SCHEMA_V1);
  const p2 = mkTempSchema(MIN_SCHEMA_V2);
  _schemaCache.clear();
  const s1 = loadSchema(p1);
  const s2 = loadSchema(p2);
  assert.notEqual(s1, s2);
  assert.equal(s1.tags.size, 1);
  assert.equal(s2.tags.size, 2);

  // Re-calling each path returns its own cached value.
  assert.equal(loadSchema(p1), s1);
  assert.equal(loadSchema(p2), s2);
});

test('loadSchema: after rewrite-without-mtime-bump, returns CACHED value (mtime is the source of truth)', () => {
  // Documented behavior: invalidation is mtime-based, not content-based.
  // A pathological scenario where two writes land within the same coarse
  // mtime tick would observe the stale value. This is acceptable because
  // (a) the CLI is invoked once per real edit, and (b) mtime ticks at <1ms
  // on every supported filesystem so the race is theoretical.
  const p = mkTempSchema(MIN_SCHEMA_V1);
  _schemaCache.clear();
  const v1 = loadSchema(p);

  // Rewrite content but stamp the SAME mtime. The cache should NOT invalidate.
  const stat = fs.statSync(p);
  fs.writeFileSync(p, MIN_SCHEMA_V2);
  fs.utimesSync(p, stat.atimeMs / 1000, stat.mtimeMs / 1000);

  const v2 = loadSchema(p);
  assert.equal(v1, v2); // still cached
  assert.equal(v2.tags.size, 1); // still v1's content
});
