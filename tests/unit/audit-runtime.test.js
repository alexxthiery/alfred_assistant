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

function captureStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = orig;
  }
  return lines.join('\n');
}

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

test('postWriteAudit: clean page stays silent', () => {
  page('gamma', '---\nid: gamma\ntitle: Gamma\ntype: note\ntags: []\n---\n- [fact] clean ^[memory:2026-05-25]\n');
  const stderr = captureStderr(() => postWriteAudit('gamma'));
  assert.equal(stderr, '');
});

test('postWriteAudit: issue without specific fix prints the generic wiki patch guidance', () => {
  page('delta', '---\nid: delta\ntitle: Delta\ntype: entity\ntags: [person]\n---\n- [fact] unsourced fact\n');
  const stderr = captureStderr(() => postWriteAudit('delta'));
  assert.match(stderr, /# audit delta:/);
  assert.match(stderr, /\[high\] missing-provenance:/);
  assert.match(stderr, /wiki patch delta \.\.\./);
});

test('postWriteAudit: cross-page strict errors surface their specific fix line', () => {
  page('beta', '---\nid: beta\ntitle: Beta\ntype: note\ntags: []\n---\n- [fact] seed ^[memory:2026-05-25]\n');
  page('alpha', '---\nid: alpha\ntitle: Alpha\ntype: note\ntags: []\naliases: [Beta]\n---\n- [fact] seed ^[memory:2026-05-25]\n');
  const stderr = captureStderr(() => postWriteAudit('alpha'));
  assert.match(stderr, /\[high\] non-functional-alias:/);
  assert.match(stderr, /wiki merge beta alpha --add-aliases "Beta"/);
});

test('auditSlug: reports concept cites that do not point to a source', () => {
  page('related-concept', '---\nid: related-concept\ntitle: Related Concept\ntype: concept\ntags: [idea]\n---\n- [hypothesis] related claim ^[web:example]\n');
  page('bad-idea', '---\nid: bad-idea\ntitle: Bad Idea\ntype: concept\ntags: [idea]\n---\n- [hypothesis] claim from capture ^[raw/transcripts/post_agi_transcripts/example.md]\n- cites [[related-concept]]\n');
  const r = auditSlug('bad-idea');
  const hit = r.issues.find((i) => i.rule === 'idea-source-attribution');
  assert.ok(hit, 'single-page audit wrapper must include cross-page source-attribution failures');
  assert.match(hit.detail, /\[\[related-concept\]\] is type=concept/);
});
