// Unit tests for bin/lib/inverse-closure.js.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { computeMissingInverses, groupByTarget } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'inverse-closure.js')
);

const sym = (...verbs) => new Set(verbs);
const inv = (...pairs) => {
  const m = new Map();
  for (const [a, b] of pairs) { m.set(a, b); m.set(b, a); }
  return m;
};

test('detects missing symmetric inverse (sibling_of)', () => {
  const rels = new Map([
    ['node-a', [{ verb: 'sibling_of', target: 'node-b' }]],
    ['node-b', []],
  ]);
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['node-a', 'node-b']),
    schema: { symmetric: sym('sibling_of'), inverses: new Map() },
  });
  assert.deepEqual(missing, [{ fromSlug: 'node-a', verb: 'sibling_of', target: 'node-b', neededVerb: 'sibling_of' }]);
});

test('detects missing inverse-pair (parent_of → child_of)', () => {
  const rels = new Map([
    ['parent-1', [{ verb: 'parent_of', target: 'child-1' }]],
    ['child-1',  []],
  ]);
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['parent-1', 'child-1']),
    schema: { symmetric: new Set(), inverses: inv(['parent_of', 'child_of']) },
  });
  assert.deepEqual(missing, [{ fromSlug: 'parent-1', verb: 'parent_of', target: 'child-1', neededVerb: 'child_of' }]);
});

test('no missing when both directions already exist', () => {
  const rels = new Map([
    ['parent-1', [{ verb: 'parent_of', target: 'child-1' }]],
    ['child-1',  [{ verb: 'child_of',  target: 'parent-1' }]],
  ]);
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['parent-1', 'child-1']),
    schema: { symmetric: new Set(), inverses: inv(['parent_of', 'child_of']) },
  });
  assert.deepEqual(missing, []);
});

test('skips edges to non-existent targets (stubs)', () => {
  const rels = new Map([
    ['node-a', [{ verb: 'parent_of', target: 'ghost' }]],
  ]);
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['node-a']), // ghost is absent
    schema: { symmetric: new Set(), inverses: inv(['parent_of', 'child_of']) },
  });
  assert.deepEqual(missing, []);
});

test('skips one-way verbs (no symmetric, no inverse registered)', () => {
  const rels = new Map([
    ['node-a', [{ verb: 'wrote', target: 'paper-x' }]],
    ['paper-x', []],
  ]);
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['node-a', 'paper-x']),
    schema: { symmetric: new Set(), inverses: new Map() },
  });
  assert.deepEqual(missing, []);
});

test('fromSlugs filter narrows the scan (ingest scope)', () => {
  const rels = new Map([
    ['node-a', [{ verb: 'sibling_of', target: 'node-b' }]],
    ['node-c', [{ verb: 'sibling_of', target: 'node-d' }]],
    ['node-b', []],
    ['node-d', []],
  ]);
  // Only consider edges originating from "node-a" (ingest just touched it).
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['node-a', 'node-b', 'node-c', 'node-d']),
    schema: { symmetric: sym('sibling_of'), inverses: new Map() },
    fromSlugs: ['node-a'],
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].fromSlug, 'node-a');
  assert.equal(missing[0].target, 'node-b');
});

test('fromSlugs=null behaves as full scan', () => {
  const rels = new Map([
    ['node-a', [{ verb: 'sibling_of', target: 'node-b' }]],
    ['node-c', [{ verb: 'sibling_of', target: 'node-d' }]],
    ['node-b', []],
    ['node-d', []],
  ]);
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['node-a', 'node-b', 'node-c', 'node-d']),
    schema: { symmetric: sym('sibling_of'), inverses: new Map() },
    fromSlugs: null,
  });
  assert.equal(missing.length, 2);
});

test('inverse mapping is symmetric in the schema Map (both directions registered)', () => {
  // The schema typically stores both a→b and b→a in `inverses`.
  const rels = new Map([
    ['child-1',  [{ verb: 'child_of', target: 'parent-1' }]], // start from the child side
    ['parent-1', []],
  ]);
  const missing = computeMissingInverses({
    pageRelations: rels,
    slugSet: new Set(['child-1', 'parent-1']),
    schema: { symmetric: new Set(), inverses: inv(['parent_of', 'child_of']) },
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].neededVerb, 'parent_of');
  assert.equal(missing[0].target, 'parent-1');
});

test('groupByTarget collapses missing-list to per-target writes', () => {
  const missing = [
    { fromSlug: 'parent-1', verb: 'parent_of', target: 'child-1', neededVerb: 'child_of' },
    { fromSlug: 'parent-2', verb: 'parent_of', target: 'child-1', neededVerb: 'child_of' },
    { fromSlug: 'parent-1', verb: 'parent_of', target: 'child-2', neededVerb: 'child_of' },
  ];
  const grouped = groupByTarget(missing);
  assert.equal(grouped.size, 2);
  assert.deepEqual(grouped.get('child-1'), [
    { verb: 'child_of', fromSlug: 'parent-1' },
    { verb: 'child_of', fromSlug: 'parent-2' },
  ]);
  assert.deepEqual(grouped.get('child-2'), [
    { verb: 'child_of', fromSlug: 'parent-1' },
  ]);
});

test('validates inputs (throws on bad types)', () => {
  assert.throws(() => computeMissingInverses({
    pageRelations: {},
    slugSet: new Set(),
    schema: { symmetric: new Set(), inverses: new Map() },
  }), /pageRelations must be a Map/);
  assert.throws(() => computeMissingInverses({
    pageRelations: new Map(),
    slugSet: [],
    schema: { symmetric: new Set(), inverses: new Map() },
  }), /slugSet must be a Set/);
  assert.throws(() => computeMissingInverses({
    pageRelations: new Map(),
    slugSet: new Set(),
    schema: { symmetric: null, inverses: new Map() },
  }), /schema must expose/);
});
