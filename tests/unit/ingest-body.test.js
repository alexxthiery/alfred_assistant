// Unit tests for bin/lib/ingest-body.js — pure spec -> markdown renderers.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatObservation, formatRelation, buildBodyFromSpec } = require('../../bin/lib/ingest-body.js');

test('formatObservation: string shorthand becomes a body', () => {
  assert.equal(formatObservation('hello', 'fact'), '- [fact] hello');
});

test('formatObservation: dates, tags, and source compose in order', () => {
  const line = formatObservation(
    { body: 'lives in Paris', since: '2020', asOf: '2026-05', tags: ['home'], source: 'telegram:2026-05-25' },
    'fact',
  );
  assert.equal(line, '- [fact] lives in Paris [since 2020] [as-of 2026-05] #home ^[telegram:2026-05-25]');
});

test('formatObservation: defaultSource applies only when spec has none', () => {
  assert.match(formatObservation({ body: 'x' }, 'fact', 'memory:2026-05-25'), /\^\[memory:2026-05-25\]$/);
  assert.match(formatObservation({ body: 'x', source: 'web:e.com' }, 'fact', 'memory:2026-05-25'), /\^\[web:e\.com\]$/);
});

test('formatObservation: empty/invalid returns null', () => {
  assert.equal(formatObservation(null, 'fact'), null);
  assert.equal(formatObservation({}, 'fact'), null);
});

test('formatRelation: simple and multi-word (quoted), null guard', () => {
  assert.equal(formatRelation({ verb: 'works_at', target: 'acme' }), '- works_at [[acme]]');
  assert.equal(formatRelation({ verb: 'is married to', target: 'sam' }), '- "is married to" [[sam]]');
  assert.equal(formatRelation({ verb: 'x' }), null);
});

test('buildBodyFromSpec: summary + categorized observations + relations', () => {
  const body = buildBodyFromSpec({
    summary: 'A person.',
    facts: ['born in 1990'],
    relations: [{ verb: 'works_at', target: 'acme' }],
  }, 'memory:2026-05-25');
  assert.match(body, /^A person\.\n\n/);
  assert.match(body, /- \[fact\] born in 1990 \^\[memory:2026-05-25\]/);
  assert.match(body, /- works_at \[\[acme\]\]/);
  assert.ok(body.endsWith('\n'));
});

test('buildBodyFromSpec: empty spec yields empty string', () => {
  assert.equal(buildBodyFromSpec({}), '');
});
