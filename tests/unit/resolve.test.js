// Unit tests for bin/lib/resolve.js — fuzzy slug resolution over the vault.
// WIKI_ROOT points lib/vault.js at a temp vault before require. The scoring
// itself (scoreSlugCandidates) is tested in graph.test.js; here we cover the
// disk-read wrapper end to end.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-'));
process.env.WIKI_ROOT = TMP;
fs.copyFileSync(path.join(REPO, 'docs', 'SCHEMA.md'), path.join(TMP, 'SCHEMA.md'));
const WIKI = path.join(TMP, 'wiki');
fs.mkdirSync(WIKI, { recursive: true });
fs.writeFileSync(path.join(WIKI, 'ada-lovelace.md'),
  '---\nid: ada-lovelace\ntitle: Ada Lovelace\ntype: entity\ntags: [person]\naliases: [Countess Lovelace]\n---\n- [fact] mathematician ^[memory:2026-05-25]\n');

const { resolveSlugCandidates } = require('../../bin/lib/resolve.js');

test('resolveSlugCandidates: exact title match surfaces the slug', () => {
  const out = resolveSlugCandidates('Ada Lovelace');
  assert.ok(Array.isArray(out));
  assert.ok(out.length >= 1);
  assert.equal(out[0].slug, 'ada-lovelace');
});

test('resolveSlugCandidates: alias match resolves to the page', () => {
  const out = resolveSlugCandidates('Countess Lovelace');
  assert.ok(out.some((c) => c.slug === 'ada-lovelace'), `expected ada-lovelace among ${JSON.stringify(out)}`);
});

test('resolveSlugCandidates: gibberish yields no strong candidate', () => {
  const out = resolveSlugCandidates('zzzzqqq-nonsense');
  assert.ok(Array.isArray(out));
  assert.ok(!out.some((c) => c.slug === 'ada-lovelace'));
});
