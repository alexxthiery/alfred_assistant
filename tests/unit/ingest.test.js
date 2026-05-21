// Unit tests for bin/lib/ingest.js. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { validateIngestSpec, validateBody, FUZZY_DUP_THRESHOLD } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'ingest.js'));

// Build a fake schema that closely matches the test vault's surface.
function makeSchema(overrides = {}) {
  return {
    tags: new Set(['person', 'org', 'tool', 'paper', 'family', 'friend', 'event', 'work', 'travel']),
    forbidden: new Set(['family', 'people']),
    symmetric: new Set(['spouse_of', 'sibling_of']),
    inverses: new Map([['parent_of', 'child_of'], ['employs', 'works_at']]),
    oneWay: new Set(['located_in']),
    eventKeywords: new Set(['lunch', 'meeting']),
    ...overrides,
  };
}

// Build the known-verbs set the way knownRelationVerbs(schema) does.
function makeKnownVerbs(schema) {
  const out = new Set();
  for (const v of schema.symmetric) out.add(v);
  for (const v of schema.oneWay) out.add(v);
  for (const [a, b] of schema.inverses) { out.add(a); out.add(b); }
  return out;
}

// Default deps for a spec that runs against an empty vault.
function defaultDeps(overrides = {}) {
  const schema = overrides.schema || makeSchema();
  return {
    schema,
    knownVerbs: overrides.knownVerbs || makeKnownVerbs(schema),
    existingSlugs: overrides.existingSlugs || new Set(),
    fuzzyMatchFn: overrides.fuzzyMatchFn || (() => []),
    allowDuplicates: !!overrides.allowDuplicates,
  };
}

// ─── top-level shape ───────────────────────────────────────────────────────

test('validateIngestSpec: non-object spec rejected with one error', () => {
  const out = validateIngestSpec(null, defaultDeps());
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /spec must be an object/);
});

test('validateIngestSpec: missing source rejected', () => {
  const out = validateIngestSpec({ stubs: [{ slug: 'a', title: 'A' }] }, defaultDeps());
  assert.ok(out.errors.some((e) => /source.*required/.test(e)));
});

test('validateIngestSpec: empty spec rejected', () => {
  const out = validateIngestSpec({ source: 'telegram:1' }, defaultDeps());
  assert.ok(out.errors.some((e) => /spec is empty/.test(e)));
});

test('validateIngestSpec: valid minimal stub passes', () => {
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'alice', title: 'Alice' }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.deepEqual(out.errors, []);
  assert.ok(out.createdSlugs.has('alice'));
});

// ─── slug uniqueness within spec ───────────────────────────────────────────

test('validateIngestSpec: duplicate slug across sections rejected', () => {
  const spec = {
    source: 'telegram:1',
    stubs:    [{ slug: 'alice', title: 'Alice' }],
    entities: [{ slug: 'alice', title: 'Alice', tags: ['person'], facts: [{ body: 'x' }] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /duplicate slug "alice"/.test(e)));
});

// ─── forbidden + reserved slug rejection ───────────────────────────────────

test('validateIngestSpec: forbidden aggregator slug rejected', () => {
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'family', title: 'Family' }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /invalid slug "family"/.test(e)));
});

test('validateIngestSpec: reserved slug "index" rejected', () => {
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'index', title: 'Index' }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /invalid slug "index"/.test(e)));
});

// ─── tag taxonomy ──────────────────────────────────────────────────────────

test('validateIngestSpec: unknown tag rejected', () => {
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'alice', title: 'Alice', tags: ['unknown-tag'] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /unknown tag.*unknown-tag/.test(e)));
});

test('validateIngestSpec: tags-not-array rejected', () => {
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'alice', title: 'Alice', tags: 'person' }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /tags must be an array/.test(e)));
});

// ─── entity rules ──────────────────────────────────────────────────────────

test('validateIngestSpec: entity missing kind tag rejected', () => {
  const spec = {
    source: 'telegram:1',
    entities: [{ slug: 'alice', title: 'Alice', tags: ['work'], facts: [{ body: 'x' }] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /type=entity requires one of tags/.test(e)));
});

test('validateIngestSpec: entity with no facts/hypotheses/relations rejected', () => {
  const spec = {
    source: 'telegram:1',
    entities: [{ slug: 'alice', title: 'Alice', tags: ['person'] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /entity needs ≥1 fact/.test(e)));
});

test('validateIngestSpec: entity with bad type rejected', () => {
  const spec = {
    source: 'telegram:1',
    entities: [{ slug: 'alice', title: 'Alice', type: 'event', tags: ['person'], facts: [{ body: 'x' }] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /type must be entity\/concept\/decision/.test(e)));
});

// ─── relation rules ────────────────────────────────────────────────────────

test('validateIngestSpec: self-relation rejected', () => {
  const spec = {
    source: 'telegram:1',
    entities: [{
      slug: 'alice', title: 'Alice', tags: ['person'],
      relations: [{ verb: 'spouse_of', target: 'alice' }],
    }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /self-relation not allowed/.test(e)));
});

test('validateIngestSpec: invented (non-schema) relation verb rejected', () => {
  const spec = {
    source: 'telegram:1',
    entities: [{
      slug: 'alice', title: 'Alice', tags: ['person'],
      relations: [{ verb: 'totally_made_up', target: 'bob' }],
    }],
  };
  const deps = defaultDeps({ existingSlugs: new Set(['bob']) });
  const out = validateIngestSpec(spec, deps);
  assert.ok(out.errors.some((e) => /invented verb "totally_made_up"/.test(e)));
});

test('validateIngestSpec: relation to nonexistent slug rejected', () => {
  const spec = {
    source: 'telegram:1',
    entities: [{
      slug: 'alice', title: 'Alice', tags: ['person'],
      relations: [{ verb: 'spouse_of', target: 'nonexistent' }],
    }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /target \[\[nonexistent\]\] does not exist/.test(e)));
});

test('validateIngestSpec: relation to slug created in same spec passes', () => {
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'bob', title: 'Bob' }],
    entities: [{
      slug: 'alice', title: 'Alice', tags: ['person'],
      relations: [{ verb: 'spouse_of', target: 'bob' }],
    }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.deepEqual(out.errors, []);
});

test('validateIngestSpec: relation missing verb/target rejected', () => {
  const spec = {
    source: 'telegram:1',
    entities: [{
      slug: 'alice', title: 'Alice', tags: ['person'],
      relations: [{ verb: 'spouse_of' }],  // no target
    }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /relation needs \{verb, target\}/.test(e)));
});

// ─── event rules ───────────────────────────────────────────────────────────

test('validateIngestSpec: event missing "when" rejected', () => {
  const spec = {
    source: 'telegram:1',
    events: [{ slug: 'lunch-x', title: 'Lunch', tags: ['event'] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /"when" required/.test(e)));
});

test('validateIngestSpec: event missing "event" tag rejected', () => {
  const spec = {
    source: 'telegram:1',
    events: [{ slug: 'lunch-x', title: 'Lunch', when: '2026-05-20', tags: ['family'] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /tags must include "event"/.test(e)));
});

test('validateIngestSpec: event with malformed when rejected', () => {
  const spec = {
    source: 'telegram:1',
    events: [{ slug: 'lunch-x', title: 'Lunch', when: 'tomorrow', tags: ['event'] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /"when" must be YYYY-MM-DD/.test(e)));
});

test('validateIngestSpec: event with valid ISO datetime passes', () => {
  const spec = {
    source: 'telegram:1',
    events: [{ slug: 'lunch-x', title: 'Lunch', when: '2026-05-20T12:30:00Z', tags: ['event'] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.deepEqual(out.errors, []);
});

test('validateIngestSpec: event attendee that doesn\'t exist rejected', () => {
  const spec = {
    source: 'telegram:1',
    events: [{
      slug: 'lunch-x', title: 'Lunch', when: '2026-05-20', tags: ['event'],
      attendees: ['ghost'],
    }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /attendee \[\[ghost\]\] does not exist/.test(e)));
});

// ─── patch rules ───────────────────────────────────────────────────────────

test('validateIngestSpec: patch on nonexistent slug rejected', () => {
  const spec = {
    source: 'telegram:1',
    patches: [{ slug: 'ghost', add_facts: [{ body: 'x' }] }],
  };
  const out = validateIngestSpec(spec, defaultDeps());
  assert.ok(out.errors.some((e) => /target page does not exist/.test(e)));
});

test('validateIngestSpec: patch with no operations rejected', () => {
  const spec = {
    source: 'telegram:1',
    patches: [{ slug: 'alice' }],
  };
  const deps = defaultDeps({ existingSlugs: new Set(['alice']) });
  const out = validateIngestSpec(spec, deps);
  assert.ok(out.errors.some((e) => /patch needs ≥1 operation/.test(e)));
});

test('validateIngestSpec: patch with only add_claims counts as an operation', () => {
  // Regression: add_claims was missing from the hasOps check, so claim-only
  // patches were wrongly rejected with "patch needs ≥1 operation".
  const spec = {
    source: 'inbox/x.tex',
    patches: [{ slug: 'alice', add_claims: [{ body: 'a third-party assertion' }] }],
  };
  const deps = defaultDeps({ existingSlugs: new Set(['alice']) });
  const out = validateIngestSpec(spec, deps);
  assert.ok(!out.errors.some((e) => /patch needs ≥1 operation/.test(e)),
    `claim-only patch should be a valid op; errors: ${out.errors.join('; ')}`);
});

test('validateIngestSpec: patch on existing slug passes', () => {
  const spec = {
    source: 'telegram:1',
    patches: [{ slug: 'alice', add_facts: [{ body: 'x' }] }],
  };
  const deps = defaultDeps({ existingSlugs: new Set(['alice']) });
  const out = validateIngestSpec(spec, deps);
  assert.deepEqual(out.errors, []);
});

// ─── fuzzy duplicate check ─────────────────────────────────────────────────

test('validateIngestSpec: fuzzy duplicate above threshold rejected', () => {
  const fuzzyMatchFn = (title) => {
    if (title === 'Alice Smith') return [{ slug: 'alice', confidence: 0.95, reason: 'exact title "Alice"' }];
    return [];
  };
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'alice-smith', title: 'Alice Smith' }],
  };
  const deps = defaultDeps({ fuzzyMatchFn });
  const out = validateIngestSpec(spec, deps);
  assert.ok(out.errors.some((e) => /may duplicate existing \[\[alice\]\]/.test(e)));
});

test('validateIngestSpec: --allow-duplicates bypasses fuzzy check', () => {
  const fuzzyMatchFn = () => [{ slug: 'alice', confidence: 0.95, reason: 'exact title' }];
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'alice-smith', title: 'Alice Smith' }],
  };
  const deps = defaultDeps({ fuzzyMatchFn, allowDuplicates: true });
  const out = validateIngestSpec(spec, deps);
  assert.deepEqual(out.errors, []);
});

test('validateIngestSpec: fuzzy match below threshold does NOT reject', () => {
  const fuzzyMatchFn = () => [{ slug: 'alice', confidence: 0.5, reason: 'Levenshtein 2' }];
  const spec = {
    source: 'telegram:1',
    stubs: [{ slug: 'alyce', title: 'Alyce' }],
  };
  const deps = defaultDeps({ fuzzyMatchFn });
  const out = validateIngestSpec(spec, deps);
  // 0.5 < 0.7 threshold → should pass.
  assert.deepEqual(out.errors, []);
});

test('FUZZY_DUP_THRESHOLD: exported as 0.7', () => {
  assert.equal(FUZZY_DUP_THRESHOLD, 0.7);
});

// ─── validateBody ──────────────────────────────────────────────────────────

function bodyDeps(overrides = {}) {
  const schema = overrides.schema || makeSchema();
  const knownVerbs = overrides.knownVerbs || makeKnownVerbs(schema);
  return { schema, knownVerbs };
}

test('validateBody: clean event passes', () => {
  const errors = validateBody({
    slug: 'lunch-x', title: 'Lunch', type: 'event', tags: ['event'],
    body: '- [fact] Had lunch ^[telegram:1]', fm: { when: '2026-05-20' },
  }, bodyDeps());
  assert.deepEqual(errors, []);
});

test('validateBody: mislabeled-event fires on event-keyword in entity title', () => {
  const errors = validateBody({
    slug: 'monday-meeting-prep', title: 'Monday meeting prep',
    type: 'entity', tags: ['person'], body: '- [fact] foo ^[telegram:1]',
  }, bodyDeps());
  const rules = errors.map((e) => e.rule);
  assert.ok(rules.includes('mislabeled-event'));
});

test('validateBody: event-tag fires on type=event without "event" tag', () => {
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'event', tags: ['family'],
    body: '', fm: { when: '2026-05-20' },
  }, bodyDeps());
  assert.ok(errors.some((e) => e.rule === 'event-tag'));
});

test('validateBody: event-when fires on type=event missing fm.when', () => {
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'event', tags: ['event'],
    body: '', fm: {},
  }, bodyDeps());
  assert.ok(errors.some((e) => e.rule === 'event-when'));
});

test('validateBody: uncategorized-bullets fires on bare bullets', () => {
  const body = '- this is a bare bullet\n- works_at [[example-corp]]\n- [fact] real ^[t:1]';
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'entity', tags: ['person'], body, fm: {},
  }, bodyDeps());
  assert.ok(errors.some((e) => e.rule === 'uncategorized-bullets'));
});

test('validateBody: uncategorized-bullets ignores categorized + relation lines', () => {
  const body = '- [fact] one ^[t:1]\n- spouse_of [[bob]]\n- "is a kind of" [[mammal]]';
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'entity', tags: ['person'], body, fm: {},
  }, bodyDeps());
  assert.ok(!errors.some((e) => e.rule === 'uncategorized-bullets'));
});

test('validateBody: invented-verb fires on relation verbs not in schema', () => {
  const body = '- [fact] x ^[t:1]\n- frobnicates [[bob]]';
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'entity', tags: ['person'], body, fm: {},
  }, bodyDeps());
  assert.ok(errors.some((e) => e.rule === 'invented-verb' && /frobnicates/.test(e.message)));
});

test('validateBody: missing-provenance fires on substantive type without provenance', () => {
  const body = '- [fact] bare claim with no source\n- [hypothesis] another';
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'entity', tags: ['person'], body, fm: {},
  }, bodyDeps());
  assert.ok(errors.some((e) => e.rule === 'missing-provenance'));
});

test('validateBody: provenance via fm.raw_path counts as having provenance', () => {
  const body = '- [fact] bare claim';
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'source', tags: ['paper'], body,
    fm: { raw_path: 'raw/clippings/foo.md' },
  }, bodyDeps());
  assert.ok(!errors.some((e) => e.rule === 'missing-provenance'));
});

test('validateBody: provenance via fm.derived_from counts as having provenance', () => {
  const body = '- [fact] synthesised claim';
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'synthesis', tags: ['meta'], body,
    fm: { derived_from: ['a', 'b'] },
  }, bodyDeps());
  assert.ok(!errors.some((e) => e.rule === 'missing-provenance'));
});

test('validateBody: missing-provenance does NOT fire on notes/todos (non-strict types)', () => {
  const body = '- [fact] note without source';
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'note', tags: ['meta'], body, fm: {},
  }, bodyDeps());
  assert.ok(!errors.some((e) => e.rule === 'missing-provenance'));
});

test('validateBody: empty body produces no errors (only FM-level rules can fire)', () => {
  const errors = validateBody({
    slug: 'x', title: 'X', type: 'entity', tags: ['person'], body: '', fm: {},
  }, bodyDeps());
  // No provenance/uncat/invented/event errors when body is empty.
  assert.deepEqual(errors, []);
});

// ─── B2: per-item duplicate opt-out ──────────────────────────────────────────

test('validateIngestSpec: B2 allow_duplicate / allowDuplicateSlugs wave through one fuzzy dup', () => {
  const schema = makeSchema();
  const deps = {
    schema,
    knownVerbs: makeKnownVerbs(schema),
    existingSlugs: new Set(['abc']),
    fuzzyMatchFn: () => [{ slug: 'abc', confidence: 0.7, reason: 'substring "abc"' }],
    allowDuplicates: false,
  };
  const mk = (extra) => ({
    source: 'telegram:1',
    entities: [{ slug: 'gadget-concept', title: 'a gadget concept', type: 'concept', tags: ['work'], facts: [{ body: 'an idea. ^[telegram:1]' }], ...extra }],
  });
  const dupErrs = (out) => out.errors.filter((e) => /may duplicate/.test(e));
  // baseline: flagged
  assert.equal(dupErrs(validateIngestSpec(mk({}), deps)).length, 1);
  // per-entity opt-out: not flagged
  assert.equal(dupErrs(validateIngestSpec(mk({ allow_duplicate: true }), deps)).length, 0);
  // --allow-duplicate-slug opt-out: not flagged
  assert.equal(dupErrs(validateIngestSpec(mk({}), { ...deps, allowDuplicateSlugs: new Set(['gadget-concept']) })).length, 0);
});
