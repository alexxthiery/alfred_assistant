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

test('uncategorized-bullets: fires on bare bullets and reports the offending example', () => {
  // Behavioral claim: any `- ` bullet that is neither a `[category]` observation
  // nor a `verb [[target]]` relation is uncategorized; the rule surfaces ONE
  // example so the agent can fix it.
  // Plausible bugs:
  //   - rule miscounts (treats categorized lines as bare, fires falsely)
  //   - rule fires but examples is empty (agent can't locate the bad line)
  //   - the bare line "- bare bullet" is not in examples (rule found a different
  //     line — silent miscategorisation)
  const r = findRule('uncategorized-bullets');
  const out = r.check({ body: '- bare bullet\n- [fact] real ^[t:1]\n- works_at [[example-corp]]' }, deps());
  assert.ok(out, 'must fire when a bare bullet sits among valid lines');
  assert.equal(out.examples.length, 1, 'exactly one bare line in the input, exactly one example');
  // Independent oracle: the example must point at the actual bare line, not at
  // the [fact] or relation line. A bug that flagged the wrong line would slip
  // through a `length === 1` check alone.
  assert.match(String(out.examples[0]), /bare bullet/,
    'example must surface the actual offending line text');
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
  // Behavioral claim: canonicalisation strips date markers + provenance + confidence
  // before comparing, so two facts with same prose but different metadata duplicate.
  // Plausible bugs:
  //   - strips only some markers (e.g., dates but not provenance) → duplicates leak through
  //   - off-by-N detail count (rule fires but reports the wrong number of dups)
  //   - the rule wrongly fires on a non-duplicate pair after the canonicaliser drops
  //     a distinguishing token
  // Independent oracle: the canonical body "X happened" appears twice in the body,
  //   so the rule's detail should report exactly 1 duplicate group.
  const r = findRule('exact-duplicate-observation');
  const body = '- [fact] X happened [since 2024-01] ^[t:1]\n- [fact] X happened [on 2025-06] ^[t:2]';
  const out = r.check({ body }, deps());
  assert.ok(out, 'two facts with same prose body must be flagged regardless of date/prov differences');
  // Oracle 1: the rule names the category of the duplicate so the agent knows
  //   which categorisation tier matters (a [fact] dup vs a [hypothesis] dup
  //   has different remediation).
  assert.match(out.detail, /\[fact\]/,
    'detail must name the category of the duplicated observation');
  // Oracle 2: the duplicated body text appears in detail/message so the agent
  //   can locate the right line for supersede. Pins behavioural contract,
  //   independent of internal layout.
  assert.match(out.detail + ' ' + out.message, /X happened/,
    'detail/message should surface the duplicated body text');
  // Oracle 3: the fix hint suggests the supersede path (not just --force-duplicate),
  //   so the agent's default reflex is to revise rather than bypass.
  assert.match(out.fix, /supersede/,
    'fix hint should mention --supersede as the proper revision path');
});

test('shell-expanded-currency-artifact: fires on ~00M produced by Bash dollar expansion', () => {
  const r = findRule('shell-expanded-currency-artifact');
  const body = '- [claim] (Source) AUM ~00M confirmed; planning to request additional ~00M from P72. ^[telegram:1]';
  const out = r.check({ body }, deps());
  assert.ok(out, 'must reject the corrupted ~00M token');
  assert.match(out.detail, /~00M/);
  assert.match(out.message, /\\\$400M/);
});

test('shell-expanded-currency-artifact: fires on 00M without tilde', () => {
  const r = findRule('shell-expanded-currency-artifact');
  const body = '- [fact] Budget 00M this year. ^[t:1]';
  const out = r.check({ body }, deps());
  assert.ok(out, '00M is the same shell-expansion artifact family');
  assert.match(out.detail, /00M/);
});

test('shell-expanded-currency-artifact: silent on legitimate ~$400M amount', () => {
  const r = findRule('shell-expanded-currency-artifact');
  const body = '- [claim] AUM ~$400M confirmed. ^[t:1]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
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
  // Behavioral claim: mixed-signal trigger ("i think" + "going to") fires the
  // rule; the suggested category should be either [hypothesis] (for "i think")
  // or [prediction] (for "going to") — either is a valid recommendation.
  // Plausible bug: rule fires but suggests a category that's neither
  // hypothesis nor prediction (e.g., generic "rethink"). Test pins that the
  // recommendation surface lands on one of the documented epistemic categories.
  const r = findRule('speculative-shape-fact');
  const body = '- [fact] I think Z is going to work ^[t:1]';
  const out = r.check({ body }, deps());
  assert.ok(out, 'mixed-signal speculative fact must fire');
  assert.match(out.message, /hypothesis|prediction/i,
    'message must recommend one of the documented epistemic alternatives');
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

test('speculative-shape-fact: ignores superseded fact lines', () => {
  const r = findRule('speculative-shape-fact');
  const body = '- ~~[fact] Y might happen ^[t:1]~~ [until 2026-06-06]';
  const out = r.check({ body }, deps());
  assert.equal(out, null);
});

// ─── ironclad rules ────────────────────────────────────────────────────────
// Ironclad rules protect invariants that --soft must never bypass: closed-set
// schema vocabulary and destructive writes that would erase substantive pages.

test('AUDIT_RULES: uncategorized-bullets is marked ironclad', () => {
  const r = findRule('uncategorized-bullets');
  assert.equal(r.ironclad, true, 'uncategorized-bullets must be ironclad (closed-set categories)');
});

test('AUDIT_RULES: invented-verb is marked ironclad', () => {
  const r = findRule('invented-verb');
  assert.equal(r.ironclad, true, 'invented-verb must be ironclad (closed-set relation verbs)');
});

test('AUDIT_RULES: empty-page is strict and ironclad', () => {
  const r = findRule('empty-page');
  assert.equal(r.strict, true, 'empty-page must block writes for substantive pages');
  assert.equal(r.ironclad, true, 'empty-page must not be bypassable by --soft');
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

test('ironcladRuleErrors: returns empty-page for substantive pages with empty body', () => {
  const errors = ironcladRuleErrors({ type: 'entity', body: '' }, deps());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].rule, 'empty-page');
});

test('ironcladRuleErrors: empty for clean body', () => {
  const errors = ironcladRuleErrors({ body: '- [fact] valid line ^[t:1]\n- spouse_of [[bob]]' }, deps());
  assert.deepEqual(errors, []);
});

test('ironcladRuleErrors: silent on advisory-only issues (lonely, multi-fact-observation, etc.)', () => {
  // A page with no categories or relations would trip uncategorized-bullets if
  // it had bullets; here we exercise the "no relevant ironclad violation" path.
  const errors = ironcladRuleErrors({
    body: '- [fact] a single self-contained fact line with no ironclad violation ^[t:1]',
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

test('transient-inbox-provenance: is strict and high severity', () => {
  const r = findRule('transient-inbox-provenance');
  assert.equal(r.strict, true);
  assert.equal(r.severity, 'high');
});

test('transient-inbox-provenance: fires on inbox body provenance marker', () => {
  const r = findRule('transient-inbox-provenance');
  const out = r.check({ body: '- [fact] something ^[inbox/batch/source.md]', fm: {} }, deps());
  assert.ok(out);
  assert.match(out.detail, /inbox\/batch\/source\.md/);
});

test('transient-inbox-provenance: fires on inbox raw_path frontmatter', () => {
  const r = findRule('transient-inbox-provenance');
  const out = r.check({ body: '', fm: { raw_path: 'inbox/batch/source.md' } }, deps());
  assert.ok(out);
  assert.match(out.message, /raw\/<kind>/);
});

test('transient-inbox-provenance: silent on raw provenance', () => {
  const r = findRule('transient-inbox-provenance');
  const out = r.check({
    body: '- [fact] something ^[raw/transcripts/batch/source.md]',
    fm: { raw_path: 'raw/transcripts/batch/source.md' },
  }, deps());
  assert.equal(out, null);
});

// ─── unattributed-idea (strict attribution gate for distilled ideas) ─────────
// Behavioral claim: a concept page tagged idea/opinion/principle that carries
// observations must record which work it came from (origin field, derived_from,
// or a cites relation), else the write is blocked. Plausible bugs the tests
// guard: gate fires on non-idea concepts (false block), gate misses an
// unattributed idea (silent gap — the whole point), origin/derived/cites escape
// hatches not honored (blocks legitimate work), tags only read from one call
// path (write.js top-level array vs on-disk fm.tags).

test('unattributed-idea: is strict (blocks writes)', () => {
  const r = findRule('unattributed-idea');
  assert.equal(r.strict, true);
  assert.equal(r.severity, 'high');
});

test('unattributed-idea: fires on idea concept with obs and no attribution', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['finance', 'idea'], body: '- [hypothesis] leverage converts diversification to return', fm: {} }, deps());
  assert.ok(out, 'must block an unattributed idea card');
  assert.match(out.detail, /idea/);
  assert.ok(out.fix, 'offers a fix invocation');
});

test('unattributed-idea: fires for opinion and principle tags too', () => {
  const r = findRule('unattributed-idea');
  for (const tag of ['opinion', 'principle']) {
    const out = r.check({ type: 'concept', tags: [tag], body: '- [hypothesis] a claim', fm: {} }, deps());
    assert.ok(out, `must fire for ${tag}`);
  }
});

test('unattributed-idea: reads tags from fm.tags when top-level tags absent (on-disk audit path)', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', body: '- [hypothesis] a claim', fm: { tags: ['idea'] } }, deps());
  assert.ok(out, 'audit-from-disk path passes tags via fm, rule must still fire');
});

test('unattributed-idea: silent when origin is set to a source slug', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['idea'], body: '- [hypothesis] a claim', fm: { origin: 'kahneman-tversky-1971' } }, deps());
  assert.equal(out, null);
});

test('unattributed-idea: silent when origin=original (genuinely own thought)', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['idea'], body: '- [hypothesis] a claim', fm: { origin: 'original' } }, deps());
  assert.equal(out, null);
});

test('unattributed-idea: silent when origin=unattributed (escape valve — not blocked)', () => {
  // Critical: strict-block with no valve would force fabrication when the
  // source is unknown at capture. `unattributed` must NOT block here; it is
  // surfaced instead by idea-attribution-pending.
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['idea'], body: '- [hypothesis] a claim', fm: { origin: 'unattributed' } }, deps());
  assert.equal(out, null);
});

test('unattributed-idea: empty/whitespace origin does NOT satisfy the gate', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['idea'], body: '- [hypothesis] a claim', fm: { origin: '   ' } }, deps());
  assert.ok(out, 'a blank origin is not an attribution');
});

test('unattributed-idea: silent when derived_from present (instance/principle trail)', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['principle'], body: '- [hypothesis] a generalisation', fm: { derived_from: ['some-instance'] } }, deps());
  assert.equal(out, null);
});

test('unattributed-idea: silent when a cites relation attributes the idea', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['idea'], body: '- [hypothesis] a claim\n- cites [[risk-parity-aqr-2010]]', fm: {} }, deps());
  assert.equal(out, null);
});

test('unattributed-idea: silent on concept without an idea-class tag', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['research'], body: '- [hypothesis] a claim', fm: {} }, deps());
  assert.equal(out, null, 'research-only literature notes stay advisory, not blocked');
});

test('unattributed-idea: silent on non-concept types even if idea-tagged', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'note', tags: ['idea'], body: '- [hypothesis] a claim', fm: {} }, deps());
  assert.equal(out, null);
});

test('unattributed-idea: silent when the page has no observations', () => {
  const r = findRule('unattributed-idea');
  const out = r.check({ type: 'concept', tags: ['idea'], body: '- about [[something]]', fm: {} }, deps());
  assert.equal(out, null, 'a relation-only stub has nothing to attribute yet');
});

test('unattributed-idea: silent when a marker NAMES the work (arxiv/doi/author-year)', () => {
  // Behavioral claim: a provenance marker that names an external work is
  // attribution; the page recorded where the idea came from.
  const r = findRule('unattributed-idea');
  for (const marker of ['arxiv:2412.05265', 'doi:10.1561/2200000074', 'web:blog+site:2026-05-19', 'frazzini-pedersen-2014']) {
    const out = r.check({ type: 'concept', tags: ['idea'], body: `- [hypothesis] a claim ^[${marker}]`, fm: {} }, deps());
    assert.equal(out, null, `marker ${marker} names a work and should satisfy the gate`);
  }
});

test('unattributed-idea: still FIRES on pure-capture markers (raw/telegram/vault-synthesis)', () => {
  // Behavioral claim (the crux): a capture marker records where a fact was
  // saved, not which work the idea came from — it must NOT satisfy the gate.
  const r = findRule('unattributed-idea');
  for (const marker of ['raw/clippings/2026-05-21-adjoint.md', 'telegram:2026-05-17', 'vault-synthesis:2026-05-21', 'lab:LAB-2026-02-24']) {
    const out = r.check({ type: 'concept', tags: ['idea'], body: `- [hypothesis] a claim ^[${marker}]`, fm: {} }, deps());
    assert.ok(out, `capture marker ${marker} must not count as attribution`);
  }
});

// ─── idea-attribution-pending (backlog surface for the unattributed valve) ───

test('idea-attribution-pending: advisory only (does not block)', () => {
  const r = findRule('idea-attribution-pending');
  assert.equal(r.strict, false);
  assert.equal(r.severity, 'medium');
});

test('idea-attribution-pending: fires on origin=unattributed idea page', () => {
  const r = findRule('idea-attribution-pending');
  const out = r.check({ type: 'concept', tags: ['idea'], fm: { origin: 'unattributed' } }, deps());
  assert.ok(out, 'unattributed ideas belong on the backfill worklist');
  assert.match(out.detail, /unattributed/);
});

test('idea-attribution-pending: silent on attributed and original ideas', () => {
  const r = findRule('idea-attribution-pending');
  assert.equal(r.check({ type: 'concept', tags: ['idea'], fm: { origin: 'some-source' } }, deps()), null);
  assert.equal(r.check({ type: 'concept', tags: ['idea'], fm: { origin: 'original' } }, deps()), null);
});

test('idea-attribution-pending: silent on non-idea concepts', () => {
  const r = findRule('idea-attribution-pending');
  assert.equal(r.check({ type: 'concept', tags: ['research'], fm: { origin: 'unattributed' } }, deps()), null);
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

test('multi-fact-observation: fires on a crammed >=4-clause observation', () => {
  // Behavioral claim: an observation packing ≥4 independent assertions is
  // flagged for splitting; the rule's detail should report the assertion count
  // so the agent knows how much there is to factor.
  // Plausible bugs:
  //   - rule fires but reports count <4 (off-by-N, agent thinks it's fine)
  //   - rule reports the wrong threshold (>=3 or >=5 — silent contract drift)
  const r = findRule('multi-fact-observation');
  const crammed = '- [fact] the system uses a critic for value. the actor is the proposal. weights stay exact. parameters move slowly ^[t:1]';
  const out = r.check({ type: 'entity', body: crammed }, deps());
  assert.ok(out, 'four distinct clauses should be flagged as multi-fact');
  // Oracle: detail reports a number >=4 (the assertion count). A bug that
  // reports 0 or 2 would slip past assert.ok alone.
  assert.match(out.detail, /\b([4-9]|\d{2,})\b/,
    'detail must report a count of ≥4 independent assertions');
});

test('multi-fact-observation: ignores superseded observations', () => {
  const r = findRule('multi-fact-observation');
  const superseded = '- ~~[fact] the system uses a critic for value. the actor is the proposal. weights stay exact. parameters move slowly~~ [until 2026-06-08] ^[t:1]';
  assert.equal(r.check({ type: 'entity', body: superseded }, deps()), null);
});

test('multi-fact-observation: skips dense concept cards', () => {
  const r = findRule('multi-fact-observation');
  const denseConcept = '- [claim] The estimator defines a twist. The first term is the likelihood ratio. The second term normalizes the proposal. The resulting weight is unbiased. This is one atomic concept card, not biographical cramming ^[t:1]';
  assert.equal(r.check({ type: 'concept', body: denseConcept }, deps()), null);
});

test('multi-fact-observation: silent on a long but self-contained single idea', () => {
  const r = findRule('multi-fact-observation');
  // One long, precise sentence with notation (>120 chars, but ONE idea) — must NOT flag.
  const longSingle = '- [fact] ACT-SMC defines its twist as the prior-reference log-density-ratio u_t(x_t)=log p(x_t|y_{t+1:T}) minus log p(x_t), the smoothing marginal relative to the prior marginal at time t ^[t:1]';
  assert.ok(longSingle.length > 130);
  assert.equal(r.check({ type: 'entity', body: longSingle }, deps()), null);
});

test('multi-fact-observation: silent on short observations', () => {
  const r = findRule('multi-fact-observation');
  assert.equal(r.check({ type: 'entity', body: '- [fact] short' }, deps()), null);
});

test('bloated-card: fires at the threshold (>= OBSERVATION_BLOAT_THRESHOLD active observations)', () => {
  const { OBSERVATION_BLOAT_THRESHOLD } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'audit.js'));
  const r = findRule('bloated-card');
  const body = Array.from({ length: OBSERVATION_BLOAT_THRESHOLD }, (_, i) => `- [fact] obs ${i} ^[t:1]`).join('\n');
  const out = r.check({ body }, deps());
  assert.ok(out, 'should fire at exactly threshold observations');
  assert.match(out.detail, new RegExp(`${OBSERVATION_BLOAT_THRESHOLD} active observations`));
  assert.match(out.message, /bloat remediation playbook/);
});

test('bloated-card: silent just below the threshold', () => {
  const { OBSERVATION_BLOAT_THRESHOLD } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'audit.js'));
  const r = findRule('bloated-card');
  const body = Array.from({ length: OBSERVATION_BLOAT_THRESHOLD - 1 }, (_, i) => `- [fact] obs ${i} ^[t:1]`).join('\n');
  assert.equal(r.check({ body }, deps()), null);
});

test('bloated-card: ignores superseded observations (only active counts)', () => {
  const { OBSERVATION_BLOAT_THRESHOLD } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'audit.js'));
  const r = findRule('bloated-card');
  // Same total observations as threshold, but all but one are superseded → should be silent.
  const lines = [];
  for (let i = 0; i < OBSERVATION_BLOAT_THRESHOLD - 1; i++) lines.push(`- ~~[fact] old ${i} [until 2024-01-01]~~ ^[t:1]`);
  lines.push(`- [fact] still active ^[t:1]`);
  assert.equal(r.check({ body: lines.join('\n') }, deps()), null);
});

test('bloated-card: silent on empty body', () => {
  const r = findRule('bloated-card');
  assert.equal(r.check({ body: '' }, deps()), null);
  assert.equal(r.check({ body: null }, deps()), null);
});

test('bloated-card: counts mixed categories, not just facts', () => {
  // The rule sums all categorized observations regardless of category.
  // This guards against a refactor that accidentally restricts to one category.
  const { OBSERVATION_BLOAT_THRESHOLD } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'audit.js'));
  const r = findRule('bloated-card');
  const cats = ['fact', 'hypothesis', 'opinion', 'claim', 'decision', 'idea', 'todo'];
  const lines = [];
  for (let i = 0; i < OBSERVATION_BLOAT_THRESHOLD; i++) {
    lines.push(`- [${cats[i % cats.length]}] obs ${i} ^[t:1]`);
  }
  const out = r.check({ body: lines.join('\n') }, deps());
  assert.ok(out, 'mixed-category obs at threshold should fire');
  // Pin the count, not just the firing — a bug that fires with the wrong
  // count (e.g., only counts facts) would otherwise pass.
  assert.match(out.detail, new RegExp(`^${OBSERVATION_BLOAT_THRESHOLD} active observations`));
});

test('bloated-card: recognises canonical real-world strikethrough format', () => {
  // The real-world form is `- ~~[fact] body ^[prov] <!--obs:XXX-->~~ [until YYYY-MM-DD]`
  // with [until ...] OUTSIDE the strikethrough markers. Earlier tests use a
  // different form; this one pins parser-rule compatibility against the
  // canonical syntax the CLI actually emits.
  const { OBSERVATION_BLOAT_THRESHOLD } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'audit.js'));
  const r = findRule('bloated-card');
  const lines = [];
  for (let i = 0; i < OBSERVATION_BLOAT_THRESHOLD; i++) {
    lines.push(`- ~~[fact] obs ${i} ^[telegram:2026-05-01] <!--obs:a${i.toString().padStart(5, '0')}-->~~ [until 2026-06-16]`);
  }
  lines.push(`- [fact] one active ^[t:1]`);
  // 20 superseded + 1 active = only 1 active, below threshold — rule must NOT fire.
  assert.equal(r.check({ body: lines.join('\n') }, deps()), null,
    'canonical strikethrough must be detected as superseded; otherwise rule wrongly fires');
});

test('sectioned-idea-page: fires on a concept page with ## sub-headers (fat page)', () => {
  const r = findRule('sectioned-idea-page');
  const fat = '## Static\n- [claim] a ^[t:1]\n## Dynamic\n- [claim] b ^[t:1]';
  const out = r.check({ type: 'concept', body: fat }, deps());
  assert.ok(out, 'a sectioned concept page should be flagged for decomposition');
  assert.match(out.message, /atomic instance cards/);
});

test('sectioned-idea-page: is strict (blocks writes)', () => {
  assert.equal(findRule('sectioned-idea-page').strict, true);
});

test('sectioned-idea-page: exempts type=synthesis (overviews may have sections)', () => {
  const r = findRule('sectioned-idea-page');
  const overview = '## Part one\n- [claim] a ^[t:1]\n## Part two\n- [claim] b ^[t:1]';
  assert.equal(r.check({ type: 'synthesis', body: overview }, deps()), null);
});

test('sectioned-idea-page: silent on a flat atomic concept card', () => {
  const r = findRule('sectioned-idea-page');
  const flat = '- about [[x]]\n- [claim] one self-contained idea ^[t:1]';
  assert.equal(r.check({ type: 'concept', body: flat }, deps()), null);
});

test('empty-page: fires on substantive type with no obs or relations', () => {
  // Behavioral claim: substantive pages (entity/concept/synthesis) must have
  // either observations or typed relations — pure prose is insufficient.
  // Plausible bug: rule fires on a clearly-non-empty body (e.g., the prose
  // alone counts as "content"), or rule emits message that doesn't tell the
  // agent what shape is missing.
  const r = findRule('empty-page');
  const out = r.check({ type: 'entity', body: 'just prose, no bullets' }, deps());
  assert.ok(out, 'entity with no observations and no relations must fire');
  // Oracle: message names what the rule expects (observations or relations).
  // Without this, a regression that emits a generic "page too thin" message
  // leaves the agent unable to act.
  assert.match(out.message, /observation|relation/i,
    'message must name what is missing (observations or relations)');
});

test('empty-page: silent on frontmatter-only event records', () => {
  const r = findRule('empty-page');
  const out = r.check({ type: 'event', body: '', fm: { when: '2026-06-06' } }, deps());
  assert.equal(out, null);
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

test('event-when: fires on type=event missing fm.when and names the missing field', () => {
  // Behavioral claim: an event page must have a fm.when (the canonical date);
  //   without it, agenda queries can't place the event.
  // Plausible bugs:
  //   - rule fires but message is generic ("frontmatter incomplete"), agent
  //     can't tell what to add
  //   - rule fires on non-event types
  //   - rule misses when=null or when=""
  // Oracle: the contract is "type=event requires when:YYYY-MM-DD"; the rule's
  //   message should name the missing field explicitly.
  const r = findRule('event-when');
  const out = r.check({ type: 'event', fm: {} }, deps());
  assert.ok(out, 'type=event + no fm.when must fire');
  // Oracle: message names the missing field "when" so the agent's fix is obvious
  // (vs a generic "frontmatter incomplete" which would not be actionable).
  assert.match(out.message, /when/i, 'message must name the missing "when" field');
  // Boundary: explicit null and empty string must also fire (otherwise the
  // rule could be bypassed by `wiki write --when ""`).
  assert.ok(r.check({ type: 'event', fm: { when: null } }, deps()),
    'when=null must fire — empty value defeats agenda placement');
  assert.ok(r.check({ type: 'event', fm: { when: '' } }, deps()),
    'when="" must fire — empty value defeats agenda placement');
});

test('event-when: silent on non-event types', () => {
  const r = findRule('event-when');
  const out = r.check({ type: 'entity', fm: {} }, deps());
  assert.equal(out, null);
});

test('event-tag: fires on type=event missing "event" tag', () => {
  // Behavioral claim: every type=event page must carry the "event" tag (so
  // tag-filter views surface it). The rule names "event" in its message.
  // Plausible bug: rule fires but generic message doesn't tell the agent
  // which tag to add.
  const r = findRule('event-tag');
  const out = r.check({ type: 'event', tags: ['family'] }, deps());
  assert.ok(out, 'type=event with non-event tags must fire');
  // Oracle: message names the missing tag explicitly.
  assert.match(out.message, /event/i, 'message must name the missing "event" tag');
});

test('event-tag: silent when event tag present', () => {
  const r = findRule('event-tag');
  const out = r.check({ type: 'event', tags: ['event', 'family'] }, deps());
  assert.equal(out, null);
});

// ─── todo-* rules ──────────────────────────────────────────────────────────
// Eight todo audit rules previously had zero direct unit tests. Each check
// function is small; the tests assert fire-and-silent on the right inputs.

test('todo-status-required: fires when type=todo and fm.status absent', () => {
  // Behavioral claim: a type=todo page must declare a status; the rule emits a
  // strict-high alert when status is missing, with a remediation fix.
  // Plausible bugs:
  //   - inverted predicate (fires on entity, not todo)
  //   - returns silently with no detail (alert exists but is useless)
  //   - drops the `fix` hint (user / agent left without a remediation path)
  //   - severity demoted to low (alert becomes ignorable)
  const r = findRule('todo-status-required');
  // Oracle: behavior is fire-and-silent across type × status_present combinations.
  const fired = r.check({ type: 'todo', fm: {} }, deps());
  assert.ok(fired, 'must fire on type=todo + no status');
  // Oracle: the contract carries a status-specific message AND a wiki-todo fix.
  // Independent of the rule's internal regex / string layout.
  assert.match(fired.message, /status/i, 'message must name what is missing');
  assert.match(fired.fix, /wiki\s+todo/, 'fix must be a wiki-todo CLI command');
  // Negative: type=todo with status is silent.
  assert.equal(r.check({ type: 'todo', fm: { status: 'open' } }, deps()), null,
    'type=todo + status=open must be silent (rule scope is missing status only)');
  // Negative: non-todo never fires (rule scope is type=todo).
  assert.equal(r.check({ type: 'entity', fm: {} }, deps()), null,
    'type=entity (no status) must be silent — rule does not apply');
  // Boundary: severity contract — todo-status-required is strict + high.
  assert.equal(r.severity, 'high', 'todo-status-required is high-severity (writes blocked)');
  assert.equal(r.strict, true, 'todo-status-required blocks writes (strict mode)');
});

test('todo-status-value: rejects values outside the documented set, reports the bad value', () => {
  // Behavioral claim: status must be one of the documented values; an invalid
  // value is reported with the bad value echoed back so the agent can fix it.
  // Plausible bugs:
  //   - rule accepts arbitrary strings (predicate inverted)
  //   - rule fires but doesn't echo the offending value in detail
  //   - rule expands the valid set silently (e.g., accepts "pending")
  // Independent oracle: the documented valid set is "open|doing|done|abandoned"
  //   per the rule's own error message — testing that the rule's message
  //   reveals what it considers valid (which is testable WITHOUT importing the
  //   set from the implementation).
  const r = findRule('todo-status-value');
  const fired = r.check({ type: 'todo', fm: { status: 'pending' } }, deps());
  assert.ok(fired, 'must fire on unrecognised status');
  // Oracle 1: the rule echoes back the value that triggered it (so the agent
  //   knows what to change). Pins behavioral contract, not internal layout.
  assert.match(fired.detail, /pending/, 'detail must echo the offending value');
  // Oracle 2: the message names the documented valid set so callers know what
  //   IS allowed. Independent of any internal valid-list constant.
  assert.match(fired.message, /open\|doing\|done\|abandoned/,
    'message must enumerate the valid options (open|doing|done|abandoned)');
  // Boundary: each documented value is accepted.
  for (const v of ['open', 'doing', 'done', 'abandoned']) {
    assert.equal(r.check({ type: 'todo', fm: { status: v } }, deps()), null,
      `documented status "${v}" must be accepted`);
  }
  // Scope: rule doesn't fire when status is absent — that's status-required's job.
  assert.equal(r.check({ type: 'todo', fm: {} }, deps()), null,
    'no status falls under todo-status-required, not todo-status-value');
  // Scope: rule doesn't fire on non-todo types.
  assert.equal(r.check({ type: 'entity', fm: { status: 'whatever' } }, deps()), null,
    'rule scope is type=todo only');
});

test('todo-due-date: fires on malformed due, silent on ISO date', () => {
  const r = findRule('todo-due-date');
  assert.ok(r.check({ type: 'todo', fm: { due: '2026/06/17' } }, deps()));
  assert.ok(r.check({ type: 'todo', fm: { due: 'tomorrow' } }, deps()));
  assert.equal(r.check({ type: 'todo', fm: { due: '2026-06-17' } }, deps()), null);
  assert.equal(r.check({ type: 'todo', fm: {} }, deps()), null, 'no due → silent');
});

test('todo-priority-value: fires on invalid priority, silent on valid', () => {
  const r = findRule('todo-priority-value');
  assert.ok(r.check({ type: 'todo', fm: { priority: 'urgent' } }, deps()));
  for (const v of ['high', 'med', 'low']) {
    assert.equal(r.check({ type: 'todo', fm: { priority: v } }, deps()), null, `valid: ${v}`);
  }
});

test('todo-reminder-datetime: fires on non-ISO8601, silent on valid datetimes', () => {
  const r = findRule('todo-reminder-datetime');
  assert.ok(r.check({ type: 'todo', fm: { remind_at: '2026-06-17' } }, deps()),
    'date without time → invalid');
  assert.ok(r.check({ type: 'todo', fm: { reminded_at: 'noon' } }, deps()));
  assert.equal(r.check({ type: 'todo', fm: { remind_at: '2026-06-17T14:00+08:00' } }, deps()), null);
});

test('todo-date-in-title-without-due: fires on date-bearing title with no due', () => {
  const r = findRule('todo-date-in-title-without-due');
  // Open + dated title + no fm.due → fires
  assert.ok(r.check({
    type: 'todo', title: 'Review by 2026-08-01', fm: { status: 'open' }, tags: ['x'],
  }, deps()));
  assert.ok(r.check({
    type: 'todo', title: 'Plan for Q3 2026', fm: { status: 'open' }, tags: ['x'],
  }, deps()));
  // Same dated title but has due → silent
  assert.equal(r.check({
    type: 'todo', title: 'Review by 2026-08-01', fm: { status: 'open', due: '2026-08-01' }, tags: ['x'],
  }, deps()), null);
  // Closed status → silent (rule only nudges open todos)
  assert.equal(r.check({
    type: 'todo', title: 'Review by 2026-08-01', fm: { status: 'done' }, tags: ['x'],
  }, deps()), null);
});

test('todo-open-untagged: fires on open todo with no tags', () => {
  const r = findRule('todo-open-untagged');
  assert.ok(r.check({ type: 'todo', fm: { status: 'open' }, tags: [] }, deps()));
  assert.ok(r.check({ type: 'todo', fm: { status: 'open' } }, deps()), 'missing tags = same as empty');
  assert.equal(r.check({ type: 'todo', fm: { status: 'open' }, tags: ['work'] }, deps()), null);
  assert.equal(r.check({ type: 'todo', fm: { status: 'done' }, tags: [] }, deps()), null, 'closed → silent');
});

test('todo-done-without-done-at: fires when status=done and done_at missing', () => {
  const r = findRule('todo-done-without-done-at');
  assert.ok(r.check({ type: 'todo', fm: { status: 'done' } }, deps()));
  assert.equal(r.check({
    type: 'todo', fm: { status: 'done', done_at: '2026-06-17T10:00+08:00' },
  }, deps()), null);
  assert.equal(r.check({ type: 'todo', fm: { status: 'open' } }, deps()), null, 'open → silent');
  assert.equal(r.check({ type: 'entity', fm: {} }, deps()), null, 'non-todo → silent');
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
  // multi-fact-observation is strict:false, so an advisory-only page yields 0 strict errors.
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

function mkIdeaPage(slug, body, fmExtras = {}) {
  return mkAllPage(slug, body, { type: 'concept', tags: ['idea'], title: slug, ...fmExtras });
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

// ─── idea-source-attribution ───────────────────────────────────────────────

test('idea-source-attribution: rejects cites relations that only point to concepts', () => {
  const thisPage = mkIdeaPage('uniform-ai-regularization',
    '- [hypothesis] a claim ^[raw/transcripts/post_agi_transcripts/example.md]\n- cites [[related-concept]]');
  const allPages = [
    thisPage,
    mkIdeaPage('related-concept', '- [hypothesis] another claim ^[web:example]'),
  ];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  const hit = errors.find((e) => e.rule === 'idea-source-attribution');
  assert.ok(hit, 'concept-to-concept cites must not satisfy source attribution');
  assert.match(hit.message, /none point to a type=source page/);
  assert.match(hit.detail, /\[\[related-concept\]\] is type=concept/);
});

test('idea-source-attribution: accepts a cites relation to a real source page', () => {
  const thisPage = mkIdeaPage('uniform-ai-regularization',
    '- [hypothesis] a claim ^[raw/transcripts/post_agi_transcripts/example.md]\n- cites [[source-example]]');
  const source = mkAllPage('source-example', '- [fact] source record ^[web:example]', {
    type: 'source',
    tags: [],
    kind: 'article',
  });
  const allPages = [thisPage, source];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  assert.equal(errors.find((e) => e.rule === 'idea-source-attribution'), undefined);
});

test('idea-source-attribution: rejects origin slugs that resolve to non-source pages', () => {
  const thisPage = mkIdeaPage('bad-origin',
    '- [hypothesis] a claim ^[telegram:2026-07-03]',
    { origin: 'related-concept' });
  const allPages = [thisPage, mkIdeaPage('related-concept', '- [hypothesis] another claim ^[web:example]')];
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages });
  const hit = errors.find((e) => e.rule === 'idea-source-attribution');
  assert.ok(hit);
  assert.match(hit.message, /origin must be a type=source page/);
});

test('idea-source-attribution: rejects origin slugs that do not exist', () => {
  const thisPage = mkIdeaPage('missing-origin',
    '- [hypothesis] a claim ^[telegram:2026-07-03]',
    { origin: 'missing-source' });
  const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages: [thisPage] });
  const hit = errors.find((e) => e.rule === 'idea-source-attribution');
  assert.ok(hit);
  assert.match(hit.message, /\[\[missing-source\]\] does not exist/);
});

test('idea-source-attribution: control-word origins remain valid escape valves', () => {
  for (const origin of ['original', 'unattributed']) {
    const thisPage = mkIdeaPage(`idea-${origin}`,
      '- [hypothesis] a claim ^[telegram:2026-07-03]',
      { origin });
    const errors = strictCrossPageErrors(thisPage, { ...deps(), allPages: [thisPage] });
    assert.equal(errors.find((e) => e.rule === 'idea-source-attribution'), undefined);
  }
});

test('auditVault: surfaces idea-source-attribution for existing bad concept cites', () => {
  const pages = [
    mkIdeaPage('uniform-ai-regularization',
      '- [hypothesis] a claim ^[raw/transcripts/post_agi_transcripts/example.md]\n- cites [[related-concept]]'),
    mkIdeaPage('related-concept', '- [hypothesis] another claim ^[web:example]'),
  ];
  const out = auditVault({ pages, ...deps() });
  const r = out.perPage.find((p) => p.slug === 'uniform-ai-regularization');
  const hit = r.issues.find((i) => i.rule === 'idea-source-attribution');
  assert.ok(hit, 'vault audit must expose existing pages created under the old weak cites rule');
  assert.equal(hit.severity, 'high');
  assert.ok(r.score >= 3, 'high-severity source-attribution issue must contribute to the page score');
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

// ─── C1/C2/C3 ingestion-audit fixes ──────────────────────────────────────────

test('mislabeled-event: exempt for type=concept (C1 — concepts are never events)', () => {
  const r = findRule('mislabeled-event');
  // "review" is in the test schema's eventKeywords; on a concept it must NOT flag.
  assert.equal(r.check({ title: 'Literature review of policy gradients', type: 'concept' }, deps()), null);
  assert.equal(r.check({ title: 'Quarterly review', type: 'synthesis' }, deps()), null);
  // still fires on a note/entity title
  assert.ok(r.check({ title: 'Monday review', type: 'note' }, deps()));
});

test('mislabeled-event: broad event words can be todo action targets', () => {
  const r = findRule('mislabeled-event');
  assert.equal(r.check({ title: 'Finish TMLR review', type: 'todo' }, deps()), null);
  assert.equal(r.check({ title: 'Submit holiday request', type: 'todo' }, deps()), null);
  assert.ok(r.check({ title: 'Meeting at CBIS at 11:00 AM', type: 'todo' }, deps()));
});

test('empty-page: stub exempt even when provenance contains a wikilink (C2)', () => {
  const r = findRule('empty-page');
  assert.equal(
    r.check({ type: 'entity', body: 'Stub. ^[gmail:you@example.com:2026-05-20:[[alice]]-bob]' }, deps()),
    null,
  );
});

test('multi-fact-observation: silent on multi-sentence elaboration of ONE idea (C3)', () => {
  const r = findRule('multi-fact-observation');
  const elaborated = '- [fact] The estimator reweights particles toward future-compatible states. This is what makes the twist learnable. Therefore the variance shrinks. Such normalization removes the horizon offset ^[t:1]';
  // 4 sentence segments, but 3 open with continuation words (This/Therefore/Such)
  // → only 1 independent assertion → not flagged.
  assert.equal(r.check({ body: elaborated }, deps()), null);
});

// ─── C1: edge-aptness (lineage edge between cards sharing no hook) ────────────

test('auditVault: edge-aptness flags a lineage edge whose endpoints share no hook', () => {
  const pages = [
    mkPage('a', '- [claim] x ^[t:1]\n- extends [[b]]', { type: 'concept', fm: { hooks: ['alpha'] } }),
    mkPage('b', '- [claim] y ^[t:1]', { type: 'concept', fm: { hooks: ['beta'] } }),
  ];
  const { perPage } = auditVault({ pages, ...deps() });
  const a = perPage.find((p) => p.slug === 'a');
  assert.ok(a.issues.some((i) => i.rule === 'edge-aptness'), 'extends to a no-shared-hook card should flag');
});

test('auditVault: edge-aptness is silent when endpoints share a hook', () => {
  const pages = [
    mkPage('a', '- [claim] x ^[t:1]\n- extends [[b]]', { type: 'concept', fm: { hooks: ['shared', 'alpha'] } }),
    mkPage('b', '- [claim] y ^[t:1]', { type: 'concept', fm: { hooks: ['shared'] } }),
  ];
  const { perPage } = auditVault({ pages, ...deps() });
  const a = perPage.find((p) => p.slug === 'a');
  assert.equal(a.issues.some((i) => i.rule === 'edge-aptness'), false);
});

test('auditVault: edge-aptness does not judge a hookless endpoint or a non-lineage verb', () => {
  const pages = [
    // target hookless → not judged
    mkPage('a', '- [claim] x ^[t:1]\n- extends [[b]]', { type: 'concept', fm: { hooks: ['alpha'] } }),
    mkPage('b', '- [claim] y ^[t:1]', { type: 'concept', fm: {} }),
    // cites (not a lineage verb) with disjoint hooks → not judged
    mkPage('c', '- [claim] z ^[t:1]\n- cites [[d]]', { type: 'concept', fm: { hooks: ['gamma'] } }),
    mkPage('d', '- [claim] w ^[t:1]', { type: 'concept', fm: { hooks: ['delta'] } }),
  ];
  const { perPage } = auditVault({ pages, ...deps() });
  assert.equal(perPage.find((p) => p.slug === 'a').issues.some((i) => i.rule === 'edge-aptness'), false);
  assert.equal(perPage.find((p) => p.slug === 'c').issues.some((i) => i.rule === 'edge-aptness'), false);
});
