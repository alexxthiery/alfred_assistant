// Unit tests for bin/lib/audit-runtime.js — the fs-touching audit wrappers.
//
// Bind VAULT_ROOT (via lib/vault.js) at a temp vault seeded with the canonical
// SCHEMA.md by setting WIKI_ROOT before require. node --test isolates each file
// in its own process. The pure scoring rules are tested in audit.test.js; here
// we cover the wrapper's disk read, reserved/missing handling, and that the
// post-write hook never throws.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auditrt-'));
process.env.WIKI_ROOT = TMP;
fs.copyFileSync(path.join(REPO, 'docs', 'SCHEMA.md'), path.join(TMP, 'SCHEMA.md'));
fs.mkdirSync(path.join(TMP, 'wiki'), { recursive: true });

const { auditSlug, postWriteAudit } = require('../../bin/lib/audit-runtime.js');

const page = (slug, fmBody) => fs.writeFileSync(path.join(TMP, 'wiki', `${slug}.md`), fmBody);

test('auditSlug: reserved slugs short-circuit to a clean result', () => {
  assert.deepEqual(auditSlug('index'), { score: 0, issues: [] });
  assert.deepEqual(auditSlug('log'), { score: 0, issues: [] });
});

test('auditSlug: missing page is a clean result (no throw)', () => {
  assert.deepEqual(auditSlug('does-not-exist'), { score: 0, issues: [] });
});

test('auditSlug: real page returns a {score, issues} shape', () => {
  page('alpha', '---\nid: alpha\ntitle: Alpha\ntype: note\ntags: []\n---\n- [fact] a seed ^[memory:2026-05-25]\n');
  const r = auditSlug('alpha');
  assert.equal(typeof r.score, 'number');
  assert.ok(Array.isArray(r.issues));
});

test('postWriteAudit: never throws on a real page; returns undefined', () => {
  page('beta', '---\nid: beta\ntitle: Beta\ntype: note\ntags: []\n---\n- [fact] b seed ^[memory:2026-05-25]\n');
  let ret;
  assert.doesNotThrow(() => { ret = postWriteAudit('beta'); });
  assert.equal(ret, undefined);
});

test('postWriteAudit: never throws on a missing page', () => {
  assert.doesNotThrow(() => postWriteAudit('nope'));
});
