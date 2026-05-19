// Unit tests for bin/lib/audit.js. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { AUDIT_RULES, auditPage, auditVault, strictRuleErrors, strictCrossPageErrors, ironcladRuleErrors, STRICT_CROSS_PAGE_RULES, severityScore } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'audit.js'));

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

test('view-needs-query: fires on type=view with no sql fenced block', () => {
  const r = findRule('view-needs-query');
  const out = r.check({ type: 'view', body: 'just some prose, no fence' }, deps());
  assert.ok(out);
  assert.match(out.message, /sql/);
});

test('view-needs-query: silent on type=view with a ```sql ... ``` block', () => {
  const r = findRule('view-needs-query');
  const body = 'preamble\n```sql\nSELECT slug FROM vault LIMIT 3\n```\nepilogue';
  const out = r.check({ type: 'view', body }, deps());
  assert.equal(out, null);
});

test('view-needs-query: silent on non-view pages even without sql', () => {
  const r = findRule('view-needs-query');
  const out = r.check({ type: 'entity', body: 'no sql here' }, deps());
  assert.equal(out, null);
});

test('exact-duplicate-observation: fires when two non-superseded obs have the same canonical body and category', () => {
  const r = findRule('exact-duplicate-observation');
  const body = '- [fact] test subject likes prototypes ^[t:1]\n- [fact] test subject likes prototypes ^[t:2]';
  const out = r.check({ body }, deps());
  assert.ok(out, 'rule must fire on byte-equal observation duplicates');
  assert.match(out.message, /duplicate/i);
});

test('exact-duplicate-observation: silent on near-duplicates with a one-char difference', () => {
  // The rule is strict: only canonical-equal lines collide. Near-duplicates
  // are tolerated by design (catching them is the dedup-fuzzy work, not this).
  const r = findRule('exact-duplicate-observation');
  const body = '- [fact] test subject likes prototypes ^[t:1]\n- [fact] test subject likes prototype ^[t:2]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

test('exact-duplicate-observation: silent across different categories with same body', () => {
  // A fact and a hypothesis with identical body capture different epistemic
  // commitments — not a duplicate.
  const r = findRule('exact-duplicate-observation');
  const body = '- [fact] test subject likes prototypes ^[t:1]\n- [hypothesis] test subject likes prototypes ^[t:2]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

test('exact-duplicate-observation: silent when an existing obs is superseded and a fresh one repeats it', () => {
  // Updating an old fact via ~~strikethrough~~ followed by the replacement
  // line is exactly the supersession workflow — not a duplicate.
  const r = findRule('exact-duplicate-observation');
  const body = '- ~~[fact] test subject likes prototypes~~ [until 2026-05-19] ^[t:1]\n- [fact] test subject likes prototypes ^[t:2]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

test('exact-duplicate-observation: ignores inline date/provenance/confidence tags when comparing canonical form', () => {
  // Same body content, different provenance + date markers → still duplicate.
  const r = findRule('exact-duplicate-observation');
  const body = '- [fact] X happened [since 2024-01] ^[t:1]\n- [fact] X happened [on 2025-06] ^[t:2]';
  const out = r.check({ body }, deps());
  assert.ok(out);
});

test('speculative-shape-fact: fires on future-tense [fact] (will) → suggests [prediction]', () => {
  const r = findRule('speculative-shape-fact');
  const body = '- [fact] X will happen by 2027 ^[t:1]';
  const out = r.check({ body }, deps());
  assert.ok(out);
  assert.match(out.message, /prediction/i);
});

test('speculative-shape-fact: fires on epistemic-uncertainty [fact] (might) → suggests [hypothesis]', () => {
  const r = findRule('speculative-shape-fact');
  const body = '- [fact] Y might be true ^[t:1]';
  const out = r.check({ body }, deps());
  assert.ok(out);
  assert.match(out.message, /hypothesis/i);
});

test('speculative-shape-fact: fires on "I think Z is going to work"', () => {
  // Mixed trigger words: "i think" pulls toward hypothesis, "going to" toward
  // prediction. Either suggestion is fine; main thing is the rule fires.
  const r = findRule('speculative-shape-fact');
  const body = '- [fact] I think Z is going to work ^[t:1]';
  const out = r.check({ body }, deps());
  assert.ok(out);
});

test('speculative-shape-fact: silent on assertion-shaped [fact] ("X is the case")', () => {
  const r = findRule('speculative-shape-fact');
  const body = '- [fact] X is the case ^[t:1]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

test('speculative-shape-fact: silent on [hypothesis] (already correctly categorised)', () => {
  const r = findRule('speculative-shape-fact');
  const body = '- [hypothesis] X might be true ^[t:1]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

test('speculative-shape-fact: silent on [opinion] containing speculative phrasing', () => {
  // Opinions ARE stances ("I think"); the category already signals the
  // epistemic mode, so the rule must not nag.
  const r = findRule('speculative-shape-fact');
  const body = '- [opinion] I think X is the best approach ^[t:1]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

test('speculative-shape-fact: detail string identifies the trigger word', () => {
  const r = findRule('speculative-shape-fact');
  const body = '- [fact] Y might happen ^[t:1]';
  const out = r.check({ body }, deps());
  assert.match(out.detail, /might/i);
});

// ─── ironclad rules ────────────────────────────────────────────────────────
// Ironclad rules protect closed-set schema vocabulary (unknown observation
// categories, unknown relation verbs). They are NOT bypassable by --soft,
// because they catch syntax errors against the schema rather than
// discretionary quality concerns (lonely, long-observation, etc.).

test('AUDIT_RULES: uncategorized-bullets is marked ironclad', () => {
  const r = findRule('uncategorized-bullets');
  assert.equal(r.ironclad, true, 'uncategorized-bullets must be ironclad (closed-set categories)');
});

test('AUDIT_RULES: invented-verb is marked ironclad', () => {
  const r = findRule('invented-verb');
  assert.equal(r.ironclad, true, 'invented-verb must be ironclad (closed-set relation verbs)');
});

test('ironcladRuleErrors: returns the uncategorized-bullets error for an [issue] line', () => {
  const errors = ironcladRuleErrors({ body: '- [issue] unknown category' }, deps());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'uncategorized-bullets');
});

test('ironcladRuleErrors: returns the invented-verb error for an unknown relation verb', () => {
  const errors = ironcladRuleErrors({ body: '- fakeverb [[some-slug]]' }, deps());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'invented-verb');
});

test('ironcladRuleErrors: empty for clean body', () => {
  const errors = ironcladRuleErrors({ body: '- [fact] valid line ^[t:1]\n- spouse_of [[bob]]' }, deps());
  assert.deepEqual(errors, []);
});

test('ironcladRuleErrors: silent on advisory-only issues (lonely, long-observation, etc.)', () => {
  // A page with no categories or relations would trip uncategorized-bullets if
  // it had bullets; here we exercise the "no relevant ironclad violation" path.
  const errors = ironcladRuleErrors({
    body: '- [fact] a fact line that is intentionally extremely long, over one hundred and twenty characters, to trigger long-observation advisory ^[t:1]',
  }, deps());
  assert.deepEqual(errors, []);
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

// ─── HR05: auditVault (cross-page rules) ───────────────────────────────────

function mkPage(slug, body = '', extra = {}) {
  return {
    slug,
    title: extra.title || slug,
    type: extra.type || 'note',
    tags: extra.tags || ['meta'],
    body,
    fm: extra.fm || {},
  };
}

test('auditVault: returns {perPage, hotMentions} with one entry per page', () => {
  const pages = [mkPage('a', 'body a'), mkPage('b', 'body b')];
  const out = auditVault({ pages, ...deps() });
  assert.equal(out.perPage.length, 2);
  assert.equal(out.perPage[0].slug, 'a');
  assert.equal(out.perPage[1].slug, 'b');
  assert.deepEqual(out.hotMentions, []);
});

test('auditVault: hot-text-mention surfaces phrases in 2+ pages with no canonical stub', () => {
  // "Alice Smith" appears in two pages, no `alice-smith` slug exists → hot mention.
  const pages = [
    mkPage('a', 'I met Alice Smith yesterday.'),
    mkPage('b', 'And then Alice Smith called.'),
  ];
  const out = auditVault({ pages, ...deps() });
  const phrases = out.hotMentions.map((h) => h.phrase);
  assert.ok(phrases.includes('Alice Smith'));
});

test('auditVault: hot-text-mention skips phrase that already has a slug stub', () => {
  // "Alice Smith" appears across pages but there IS an alice-smith slug → not hot.
  const pages = [
    mkPage('a', 'I met Alice Smith yesterday.'),
    mkPage('b', 'And then Alice Smith called.'),
    mkPage('alice-smith', '', { title: 'Alice Smith' }),
  ];
  const out = auditVault({ pages, ...deps() });
  const phrases = out.hotMentions.map((h) => h.phrase);
  assert.equal(phrases.includes('Alice Smith'), false);
});

test('auditVault: hot-text-mention strips wikilinks before scanning', () => {
  // Wikilinks like [[Alice Smith]] should NOT be counted as a hot mention.
  const pages = [
    mkPage('a', 'I met [[Alice Smith]] yesterday.'),
    mkPage('b', 'And then [[Alice Smith]] called.'),
  ];
  const out = auditVault({ pages, ...deps() });
  const phrases = out.hotMentions.map((h) => h.phrase);
  assert.equal(phrases.includes('Alice Smith'), false);
});

test('auditVault: lonely rule fires on pages with <2 graph connections', () => {
  // "lone" has zero in/out wikilinks → flagged. "hub" links to many → not flagged.
  const pages = [
    mkPage('lone', 'no links here at all.'),
    mkPage('hub',  'see [[a]] and [[b]]'),
    mkPage('a', '[[hub]]'),
    mkPage('b', '[[hub]]'),
  ];
  const out = auditVault({ pages, ...deps() });
  const loneRule = out.perPage.find((r) => r.slug === 'lone').issues.find((i) => i.rule === 'lonely');
  assert.ok(loneRule, 'lonely should fire on a page with no graph connections');
  const hubRule = out.perPage.find((r) => r.slug === 'hub').issues.find((i) => i.rule === 'lonely');
  assert.equal(hubRule, undefined, 'hub has 4+ connections, should not be lonely');
});

test('auditVault: lonely rule exempts type=todo and type=source', () => {
  const pages = [
    mkPage('orphan-todo',   'no links',   { type: 'todo' }),
    mkPage('orphan-source', 'no links',   { type: 'source' }),
    mkPage('orphan-entity', 'no links',   { type: 'entity', tags: ['person'] }),
  ];
  const out = auditVault({ pages, ...deps() });
  const todoLonely   = out.perPage.find((r) => r.slug === 'orphan-todo').issues.find((i) => i.rule === 'lonely');
  const sourceLonely = out.perPage.find((r) => r.slug === 'orphan-source').issues.find((i) => i.rule === 'lonely');
  const entityLonely = out.perPage.find((r) => r.slug === 'orphan-entity').issues.find((i) => i.rule === 'lonely');
  assert.equal(todoLonely, undefined);
  assert.equal(sourceLonely, undefined);
  assert.ok(entityLonely, 'entity with no connections should still be flagged');
});

test('auditVault: empty pages list returns empty perPage + empty hotMentions', () => {
  const out = auditVault({ pages: [], ...deps() });
  assert.deepEqual(out.perPage, []);
  assert.deepEqual(out.hotMentions, []);
});

// ─── HR-OOB-B: cross-page strict-rule pipeline ────────────────────────────

test('strictCrossPageErrors: returns [] when allPages absent (deps missing snapshot)', () => {
  const thisPage = { slug: 'a', title: 'A', type: 'entity', tags: ['person'], body: '', fm: {} };
  const errors = strictCrossPageErrors(thisPage, { ...deps() });
  assert.deepEqual(errors, []);
});

test('strictCrossPageErrors: returns [] when table is empty even with allPages', () => {
  const thisPage = { slug: 'a', title: 'A', type: 'entity', tags: ['person'], body: '', fm: {} };
  const allPages = [{ slug: 'b', title: 'B', type: 'entity', tags: ['person'], body: '', fm: {} }];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  assert.deepEqual(errors, []);
});

// ─── HR-OOB-C: non-functional-alias ───────────────────────────────────────

function mkAllPage(slug, body, fmExtras = {}) {
  const fm = { type: 'entity', tags: ['person'], title: slug, ...fmExtras };
  return { slug, title: fm.title, type: fm.type, tags: fm.tags, body, fm };
}

test('non-functional-alias: fires when alias slug matches another page slug', () => {
  const thisPage = mkAllPage('alpha', '- [fact] son ^[telegram:2026-05-17]', { aliases: ['beta'], title: 'Alpha' });
  const allPages = [thisPage, mkAllPage('beta', '- [fact] nickname for alpha')];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  const hit = errors.find((e) => e.rule === 'non-functional-alias');
  assert.ok(hit, 'should fire when beta.md exists and alpha has alias beta');
  assert.match(hit.fix, /^wiki merge beta alpha --add-aliases "beta"$/);
});

test('non-functional-alias: silent when alias has no matching slug', () => {
  const thisPage = mkAllPage('alpha', 'body', { aliases: ['beta'], title: 'Alpha' });
  const allPages = [thisPage, mkAllPage('gamma', 'body')];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  const hit = errors.find((e) => e.rule === 'non-functional-alias');
  assert.equal(hit, undefined);
});

test('non-functional-alias: case-insensitive (Beta alias triggers vs beta.md)', () => {
  const thisPage = mkAllPage('alpha', 'body', { aliases: ['Beta'], title: 'Alpha' });
  const allPages = [thisPage, mkAllPage('beta', 'body')];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  const hit = errors.find((e) => e.rule === 'non-functional-alias');
  assert.ok(hit);
  assert.match(hit.fix, /Beta/);
});

test('non-functional-alias: does NOT fire when alias slug equals thisPage slug', () => {
  const thisPage = mkAllPage('alpha', 'body', { aliases: ['alpha'] });
  const allPages = [thisPage];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  const hit = errors.find((e) => e.rule === 'non-functional-alias');
  assert.equal(hit, undefined, 'self-aliases should be ignored');
});

// ─── HR-OOB-C: alias-collision ────────────────────────────────────────────

test('alias-collision: fires when alias matches another page\'s alias (different slug)', () => {
  const thisPage = mkAllPage('alpha', 'body', { aliases: ['Big M'], title: 'Alpha' });
  const allPages = [thisPage, mkAllPage('mom', 'body', { aliases: ['Big M'], title: 'Mom' })];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  const hit = errors.find((e) => e.rule === 'alias-collision');
  assert.ok(hit, 'should fire when "Big M" is also an alias of another page');
  assert.match(hit.fix, /^wiki merge /);
});

test('alias-collision: fires when alias matches another page title (case-insensitive)', () => {
  const thisPage = mkAllPage('foo', 'body', { aliases: ['mom'], title: 'Foo' });
  const allPages = [thisPage, mkAllPage('mom', 'body', { title: 'Mom' })];
  // 'mom' slugifies to 'mom' which is the other slug → non-functional-alias fires,
  // alias-collision SKIPS (slug-match case is owned by non-functional-alias).
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  assert.ok(errors.find((e) => e.rule === 'non-functional-alias'));
  assert.equal(errors.find((e) => e.rule === 'alias-collision'), undefined);
});

test('alias-collision: silent on legitimate non-overlapping aliases', () => {
  const thisPage = mkAllPage('alpha', 'body', { aliases: ['Big M'], title: 'Alpha' });
  const allPages = [thisPage, mkAllPage('mom', 'body', { aliases: ['Mama'], title: 'Mom' })];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  assert.equal(errors.find((e) => e.rule === 'alias-collision'), undefined);
});

// ─── HR-OOB-C: duplicate-fact (advisory via auditVault) ───────────────────

test('duplicate-fact: fires when ≥40-char fact appears on two different pages', () => {
  const longFact = '- [fact] Alpha started kindergarten in autumn 2026 in the local school.';
  const pages = [
    mkAllPage('alpha', longFact),
    mkAllPage('beta',   longFact),
  ];
  const out = auditVault({ pages, ...deps() });
  const r = out.perPage.find((p) => p.slug === 'alpha');
  const dup = r.issues.find((i) => i.rule === 'duplicate-fact');
  assert.ok(dup, 'duplicate-fact should fire on long facts shared across pages');
  assert.match(dup.fix, /wiki/);
});

test('duplicate-fact: silent on short facts (<40 chars normalized)', () => {
  const shortFact = '- [fact] son ^[telegram:2026-05-17]';
  const pages = [
    mkAllPage('alpha', shortFact),
    mkAllPage('beta',   shortFact),
  ];
  const out = auditVault({ pages, ...deps() });
  const r = out.perPage.find((p) => p.slug === 'alpha');
  assert.equal(r.issues.find((i) => i.rule === 'duplicate-fact'), undefined);
});

test('duplicate-fact: ≥3 shared facts → fix suggests merge instead of supersede', () => {
  const facts = [
    '- [fact] Alpha started kindergarten in autumn 2026 in the local school.',
    '- [fact] Alpha loves dinosaurs and can name a dozen of them already.',
    '- [fact] Alpha has been learning to ride a bicycle without training wheels.',
  ].join('\n');
  const pages = [
    mkAllPage('alpha', facts),
    mkAllPage('beta',   facts),
  ];
  const out = auditVault({ pages, ...deps() });
  const r = out.perPage.find((p) => p.slug === 'alpha');
  const dup = r.issues.find((i) => i.rule === 'duplicate-fact');
  assert.ok(dup);
  assert.match(dup.fix, /^wiki merge /);
});

test('strictCrossPageErrors: fires registered rule and propagates fix?', () => {
  // Temporarily register a probe rule that always fires, with a fix string.
  const probe = {
    name: 'probe-cross-page',
    severity: 'high',
    strict: true,
    check: ({ thisPage, allPages }) => ({
      detail: `probe saw ${allPages.length} page(s)`,
      fix: `wiki probe ${thisPage.slug}`,
    }),
  };
  STRICT_CROSS_PAGE_RULES.push(probe);
  try {
    const thisPage = { slug: 'x', title: 'X', type: 'entity', tags: ['person'], body: '', fm: {} };
    const allPages = [{ slug: 'y', title: 'Y', type: 'entity', tags: ['person'], body: '', fm: {} }];
    const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].rule, 'probe-cross-page');
    assert.match(errors[0].message, /probe saw 1 page/);
    assert.equal(errors[0].fix, 'wiki probe x');
  } finally {
    STRICT_CROSS_PAGE_RULES.pop();
  }
});
