// Unit tests for bin/lib/autolink-runtime.js — the fs autolink wrappers.
//
// WIKI_ROOT points lib/vault.js at a temp vault before require. The pure
// matching (autolinkBody/buildTitleEntries) is tested in autolink.test.js; here
// we cover the disk read/write wrapper: title-map construction, the
// nonexistent-slug guard, inbound injection, and dry-run (no write).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autolinkrt-'));
process.env.WIKI_ROOT = TMP;
fs.copyFileSync(path.join(REPO, 'docs', 'SCHEMA.md'), path.join(TMP, 'SCHEMA.md'));
const WIKI = path.join(TMP, 'wiki');
fs.mkdirSync(WIKI, { recursive: true });

const page = (slug, title, body) =>
  fs.writeFileSync(path.join(WIKI, `${slug}.md`),
    `---\nid: ${slug}\ntitle: ${title}\ntype: note\ntags: []\n---\n${body}\n`);
const read = (slug) => fs.readFileSync(path.join(WIKI, `${slug}.md`), 'utf-8');

const { buildTitleMap, autolinkSlug } = require('../../bin/lib/autolink-runtime.js');

test('buildTitleMap: includes created pages as title entries', () => {
  page('banana-bread', 'Banana Bread', '- [fact] a recipe ^[memory:2026-05-25]');
  const map = buildTitleMap();
  assert.ok(Array.isArray(map));
  assert.ok(map.some((e) => e.slug === 'banana-bread'), 'banana-bread in title map');
});

test('autolinkSlug: nonexistent slug returns a zero result (no throw)', () => {
  assert.deepEqual(autolinkSlug('no-such-page', { verbose: false }), { out: 0, in: 0, total: 0 });
});

test('autolinkSlug: inbound injection links a plain-text mention', () => {
  page('banana-bread', 'Banana Bread', '- [fact] a recipe ^[memory:2026-05-25]');
  page('recipe-notes', 'Recipe Notes', '- [fact] I baked Banana Bread today ^[memory:2026-05-25]');
  const r = autolinkSlug('banana-bread', { direction: 'in', verbose: false });
  assert.ok(r.in >= 1, `expected an inbound injection, got ${JSON.stringify(r)}`);
  assert.match(read('recipe-notes'), /\[\[banana-bread\]\]/);
});

test('autolinkSlug: dry-run does not write', () => {
  page('banana-bread', 'Banana Bread', '- [fact] a recipe ^[memory:2026-05-25]');
  page('dry-mention', 'Dry Mention', '- [fact] more Banana Bread here ^[memory:2026-05-25]');
  const before = read('dry-mention');
  const r = autolinkSlug('banana-bread', { direction: 'in', verbose: false, dryRun: true });
  assert.ok(r.in >= 1, 'dry-run still reports the would-be injection');
  assert.equal(read('dry-mention'), before, 'dry-run must not modify the file');
});
