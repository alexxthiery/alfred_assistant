// Unit tests for bin/lib/write-validate.js — the pre-write validation cluster.
//
// validateForWrite/validateBody read SCHEMA.md via lib/vault.js's VAULT_ROOT,
// bound at require time. We point WIKI_ROOT (discovery step 1) at a temp vault
// seeded with the canonical docs/SCHEMA.md BEFORE requiring the module, so the
// closed-set checks run against the real taxonomy. node --test isolates each
// file in its own process, so the env override does not leak.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-'));
process.env.WIKI_ROOT = TMP;
fs.copyFileSync(path.join(REPO, 'docs', 'SCHEMA.md'), path.join(TMP, 'SCHEMA.md'));
fs.mkdirSync(path.join(TMP, 'wiki'), { recursive: true });

const { validateForWrite, validateBody, buildAllPagesSnapshot, warnHooks } =
  require('../../bin/lib/write-validate.js');

const create = (over = {}) => validateForWrite(
  { slug: 'foo-bar', type: 'note', tags: [], derivedFrom: null, ...over },
  { isAppend: false },
);

test('validateForWrite: clean create returns no errors', () => {
  assert.deepEqual(create(), []);
});

test('validateForWrite: invalid slug', () => {
  assert.ok(create({ slug: 'Bad Slug' }).some((e) => /Invalid slug/.test(e)));
});

test('validateForWrite: reserved slug', () => {
  assert.ok(create({ slug: 'index' }).some((e) => /reserved/.test(e)));
  assert.ok(create({ slug: 'log' }).some((e) => /reserved/.test(e)));
});

test('validateForWrite: forbidden aggregator slug is rejected on create', () => {
  const errs = create({ slug: 'family' });
  assert.ok(errs.some((e) => /forbidden aggregator slug/.test(e) && /Atomicity rule/.test(e)));
});

test('validateForWrite: unknown type', () => {
  assert.ok(create({ type: 'banana' }).some((e) => /Unknown type/.test(e)));
});

test('validateForWrite: unknown tag', () => {
  const errs = create({ type: 'entity', tags: ['zzznotatag', 'person'] });
  assert.ok(errs.some((e) => /Unknown tag/.test(e) && /zzznotatag/.test(e)));
});

test('validateForWrite: type=note tagged as entity-kind is rejected', () => {
  assert.ok(create({ type: 'note', tags: ['person'] }).some((e) => /use type=entity/.test(e)));
});

test('validateForWrite: synthesis needs >=2 derived_from', () => {
  assert.ok(create({ type: 'synthesis', derivedFrom: 'only-one' }).some((e) => /at least 2/.test(e)));
  assert.deepEqual(create({ type: 'synthesis', derivedFrom: 'a,b' }), []);
});

test('validateForWrite: append mode skips type/tag gates', () => {
  const errs = validateForWrite(
    { slug: 'foo-bar', type: 'banana', tags: ['zzznotatag'] },
    { isAppend: true },
  );
  assert.deepEqual(errs, []);
});

test('buildAllPagesSnapshot: returns normalized page records', () => {
  fs.writeFileSync(
    path.join(TMP, 'wiki', 'alpha.md'),
    '---\nid: alpha\ntitle: Alpha\ntype: entity\ntags: [person]\n---\n- [fact] seed ^[t:1]\n',
  );
  const snap = buildAllPagesSnapshot();
  const alpha = snap.find((p) => p.slug === 'alpha');
  assert.ok(alpha, 'alpha page present in snapshot');
  assert.equal(alpha.type, 'entity');
  assert.deepEqual(alpha.tags, ['person']);
  assert.equal(alpha.title, 'Alpha');
  assert.ok(typeof alpha.body === 'string');
});

test('validateBody: returns an array for a clean body (smoke)', () => {
  const errs = validateBody({
    slug: 'foo-bar', title: 'Foo', type: 'note', tags: [],
    body: '- [fact] a thing ^[memory:2026-05-25]\n', fm: { type: 'note' },
  });
  assert.ok(Array.isArray(errs));
});

test('warnHooks: no throw on empty / string / array inputs', () => {
  assert.doesNotThrow(() => warnHooks(''));
  assert.doesNotThrow(() => warnHooks('a, b'));
  assert.doesNotThrow(() => warnHooks(['a', 'b']));
});
