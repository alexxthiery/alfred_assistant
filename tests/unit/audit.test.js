// Unit tests for bin/lib/audit.js. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { AUDIT_RULES, auditPage, strictRuleErrors, severityScore } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'audit.js'));

function makeSchema(overrides = {}) {
  return {
    tags: new Set(['person', 'org', 'tool', 'paper', 'family', 'friend', 'event', 'work', 'travel', 'meta']),
    forbidden: new Set(),
    symmetric: new Set(['spouse_of', 'sibling_of']),
    inverses: new Map([['parent_of', 'child_of']]),
    oneWay: new Set(['located_in']),
    eventKeywords: new Set(['lunch', 'meeting', 'review']),
    ...overrides,
  };
}

function makeKnownVerbs(schema) {
  const out = new Set();
  for (const v of schema.symmetric) out.add(v);
  for (const v of schema.oneWay) out.add(v);
  for (const [a, b] of schema.inverses) { out.add(a); out.add(b); }
  return out;
}

function deps(overrides = {}) {
  const schema = overrides.schema || makeSchema();
  return { schema, knownVerbs: overrides.knownVerbs || makeKnownVerbs(schema) };
}

// ─── table shape ───────────────────────────────────────────────────────────

test('AUDIT_RULES: every entry has the expected shape', () => {
  for (const rule of AUDIT_RULES) {
    assert.equal(typeof rule.name, 'string', 'name must be string');
    assert.ok(['high', 'medium', 'low'].includes(rule.severity), `bad severity for ${rule.name}`);
    assert.equal(typeof rule.strict, 'boolean', `strict must be boolean for ${rule.name}`);
    assert.equal(typeof rule.check, 'function', `check must be function for ${rule.name}`);
  }
});

test('AUDIT_RULES: rule names are unique', () => {
  const seen = new Set();
  for (const rule of AUDIT_RULES) {
    assert.ok(!seen.has(rule.name), `duplicate rule name: ${rule.name}`);
    seen.add(rule.name);
  }
});

test('severityScore: high=3, medium=2, low=1', () => {
  assert.equal(severityScore('high'), 3);
  assert.equal(severityScore('medium'), 2);
  assert.equal(severityScore('low'), 1);
});

// ─── per-rule firing ───────────────────────────────────────────────────────

function findRule(name) {
  const r = AUDIT_RULES.find((x) => x.name === name);
  if (!r) throw new Error(`rule ${name} not in AUDIT_RULES`);
  return r;
}

test('mislabeled-event: fires on event keyword in non-event title', () => {
  const r = findRule('mislabeled-event');
  const out = r.check({ title: 'Monday lunch prep', type: 'entity' }, deps());
  assert.ok(out);
  assert.match(out.detail, /lunch/);
});

test('mislabeled-event: silent when type=event', () => {
  const r = findRule('mislabeled-event');
  const out = r.check({ title: 'Monday lunch', type: 'event' }, deps());
  assert.equal(out, null);
});

test('mislabeled-event: silent when no eventKeywords in schema', () => {
  const r = findRule('mislabeled-event');
  const out = r.check({ title: 'Monday lunch', type: 'entity' }, { schema: { eventKeywords: new Set() }, knownVerbs: new Set() });
  assert.equal(out, null);
});

test('mislabeled-entity: fires on type=note with entity-kind tag', () => {
  const r = findRule('mislabeled-entity');
  const out = r.check({ type: 'note', tags: ['person'] }, deps());
  assert.ok(out);
  assert.match(out.detail, /person/);
});

test('mislabeled-entity: silent on type=entity (correct labeling)', () => {
  const r = findRule('mislabeled-entity');
  const out = r.check({ type: 'entity', tags: ['person'] }, deps());
  assert.equal(out, null);
});

test('uncategorized-bullets: fires on bare bullets', () => {
  const r = findRule('uncategorized-bullets');
  const out = r.check({ body: '- bare bullet\n- [fact] real ^[t:1]\n- works_at [[example-corp]]' }, deps());
  assert.ok(out);
  assert.ok(out.examples && out.examples.length === 1);
});

test('uncategorized-bullets: silent when all bullets are categorized or relation', () => {
  const r = findRule('uncategorized-bullets');
  const body = '- [fact] one\n- spouse_of [[bob]]\n- "is a kind of" [[mammal]]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

test('missing-provenance: fires on entity with obs but no ^[...] marker', () => {
  const r = findRule('missing-provenance');
  const out = r.check({ type: 'entity', body: '- [fact] something', fm: {} }, deps());
  assert.ok(out);
  assert.match(out.detail, /1 observation/);
});

test('missing-provenance: silent when raw_path is set', () => {
  const r = findRule('missing-provenance');
  const out = r.check({ type: 'source', body: '- [fact] x', fm: { raw_path: 'raw/x.md' } }, deps());
  assert.equal(out, null);
});

test('missing-provenance: silent on non-strict types', () => {
  const r = findRule('missing-provenance');
  const out = r.check({ type: 'note', body: '- [fact] bare claim', fm: {} }, deps());
  assert.equal(out, null);
});

test('invented-verb: fires on relation verbs not in knownVerbs', () => {
  const r = findRule('invented-verb');
  const out = r.check({ body: '- frobnicates [[bob]]' }, deps());
  assert.ok(out);
  assert.match(out.detail, /frobnicates/);
});

test('invented-verb: silent when all verbs are in schema', () => {
  const r = findRule('invented-verb');
  const out = r.check({ body: '- spouse_of [[bob]]\n- located_in [[springfield]]' }, deps());
  assert.equal(out, null);
});

test('long-observation: fires on >120-char observation body', () => {
  const r = findRule('long-observation');
  const longText = 'x'.repeat(130);
  const out = r.check({ body: `- [fact] ${longText}` }, deps());
  assert.ok(out);
});

test('long-observation: silent on short observations', () => {
  const r = findRule('long-observation');
  const out = r.check({ body: '- [fact] short' }, deps());
  assert.equal(out, null);
});

test('empty-page: fires on substantive type with no obs or relations', () => {
  const r = findRule('empty-page');
  const out = r.check({ type: 'entity', body: 'just prose, no bullets' }, deps());
  assert.ok(out);
});

test('empty-page: silent on stub template', () => {
  const r = findRule('empty-page');
  const out = r.check({ type: 'entity', body: 'Stub. ^[telegram:2026-05-17]' }, deps());
  assert.equal(out, null);
});

test('empty-page: silent on non-substantive types', () => {
  const r = findRule('empty-page');
  const out = r.check({ type: 'note', body: 'prose only' }, deps());
  assert.equal(out, null);
});

test('event-when: fires on type=event missing fm.when', () => {
  const r = findRule('event-when');
  const out = r.check({ type: 'event', fm: {} }, deps());
  assert.ok(out);
});

test('event-when: silent on non-event types', () => {
  const r = findRule('event-when');
  const out = r.check({ type: 'entity', fm: {} }, deps());
  assert.equal(out, null);
});

test('event-tag: fires on type=event missing "event" tag', () => {
  const r = findRule('event-tag');
  const out = r.check({ type: 'event', tags: ['family'] }, deps());
  assert.ok(out);
});

test('event-tag: silent when event tag present', () => {
  const r = findRule('event-tag');
  const out = r.check({ type: 'event', tags: ['event', 'family'] }, deps());
  assert.equal(out, null);
});

// ─── auditPage integration ─────────────────────────────────────────────────

test('auditPage: clean entity returns score 0, no issues', () => {
  const out = auditPage({
    slug: 'alice', title: 'Alice', type: 'entity', tags: ['person'],
    body: '- [fact] Smart person ^[telegram:1]\n- spouse_of [[bob]]', fm: {},
  }, deps());
  assert.equal(out.score, 0);
  assert.equal(out.issues.length, 0);
});

test('auditPage: page that violates 3 rules accumulates score correctly', () => {
  // Mislabeled-event (high=3) + uncat-bullets (medium=2) + missing-prov (high=3) = 8
  const out = auditPage({
    slug: 'monday-meeting',
    title: 'Monday meeting prep',  // event keyword "meeting" → mislabeled-event
    type: 'entity',
    tags: ['person'],
    body: '- bare bullet\n- [fact] no provenance',  // uncat + missing-prov
    fm: {},
  }, deps());
  const ruleNames = out.issues.map((i) => i.rule).sort();
  assert.deepEqual(ruleNames, ['missing-provenance', 'mislabeled-event', 'uncategorized-bullets'].sort());
  assert.equal(out.score, 3 + 2 + 3);
});

test('auditPage: examples are preserved on uncategorized-bullets', () => {
  const out = auditPage({
    slug: 'x', title: 'X', type: 'note', tags: ['meta'],
    body: '- first bare\n- second bare\n- third bare\n- fourth bare',
    fm: {},
  }, deps());
  const uncat = out.issues.find((i) => i.rule === 'uncategorized-bullets');
  assert.ok(uncat);
  assert.ok(Array.isArray(uncat.examples));
  assert.equal(uncat.examples.length, 3);
});

// ─── strictRuleErrors ──────────────────────────────────────────────────────

test('strictRuleErrors: only emits rules with strict=true', () => {
  // long-observation is strict:false, so a single long-obs page should yield 0 strict errors.
  const longText = 'x'.repeat(130);
  const out = strictRuleErrors({
    slug: 'x', title: 'X', type: 'note', tags: ['meta'],
    body: `- [fact] ${longText} ^[telegram:1]`,  // long-obs ✓ but provenance present so missing-prov doesn't fire (and type is non-strict anyway)
    fm: {},
  }, deps());
  assert.equal(out.length, 0);
});

test('strictRuleErrors: emits message-shape, not detail-shape', () => {
  const out = strictRuleErrors({
    slug: 'x', title: 'Monday meeting prep', type: 'entity', tags: ['person'],
    body: '- [fact] x ^[t:1]', fm: {},
  }, deps());
  const mislabeled = out.find((e) => e.rule === 'mislabeled-event');
  assert.ok(mislabeled);
  assert.ok(typeof mislabeled.message === 'string');
  // validateBody-shape uses `message`, not `severity` or `detail`:
  assert.equal(mislabeled.severity, undefined);
  assert.equal(mislabeled.detail, undefined);
});

test('strictRuleErrors: covers both event-when and event-tag separately', () => {
  // type=event with no "event" tag AND no when → both event-tag and event-when fire.
  const out = strictRuleErrors({
    slug: 'x', title: 'X', type: 'event', tags: ['family'], body: '', fm: {},
  }, deps());
  const ruleNames = out.map((e) => e.rule).sort();
  assert.ok(ruleNames.includes('event-tag'));
  assert.ok(ruleNames.includes('event-when'));
});
