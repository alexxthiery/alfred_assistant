// Unit tests for bin/lib/epistemic-verbs.js — pure builders that construct
// observation lines for `wiki predict` and `wiki hypothesize`. The CLI verbs
// in bin/wiki are thin glue: they validate the slug exists on disk, then
// delegate to cmdPatch with --observation = <built line>. So the line-shape
// correctness is the unit-testable part.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildPredictionLine, buildHypothesisLine } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'epistemic-verbs.js'),
);

// ─── buildPredictionLine ───────────────────────────────────────────────────

test('buildPredictionLine produces a well-shaped [prediction] line', () => {
  const line = buildPredictionLine({
    body: 'X will happen',
    by: '2027-06',
    confidence: 0.7,
    provenance: 'conversation:2026-05-19',
  });
  assert.equal(line, '[prediction] X will happen [by 2027-06] [confidence: 0.7] ^[conversation:2026-05-19]');
});

test('buildPredictionLine accepts YYYY-MM-DD or YYYY-MM date precision', () => {
  const a = buildPredictionLine({ body: 'X', by: '2027-06-15', confidence: 0.5, provenance: 'p:1' });
  const b = buildPredictionLine({ body: 'X', by: '2027-06', confidence: 0.5, provenance: 'p:1' });
  assert.match(a, /\[by 2027-06-15\]/);
  assert.match(b, /\[by 2027-06\]/);
});

test('buildPredictionLine rejects confidence > 1', () => {
  assert.throws(
    () => buildPredictionLine({ body: 'X', by: '2027-06', confidence: 1.5, provenance: 'p:1' }),
    /confidence/i,
  );
});

test('buildPredictionLine rejects confidence < 0', () => {
  assert.throws(
    () => buildPredictionLine({ body: 'X', by: '2027-06', confidence: -0.1, provenance: 'p:1' }),
    /confidence/i,
  );
});

test('buildPredictionLine rejects malformed date (e.g. 2027/06)', () => {
  assert.throws(
    () => buildPredictionLine({ body: 'X', by: '2027/06', confidence: 0.5, provenance: 'p:1' }),
    /date/i,
  );
});

test('buildPredictionLine rejects missing date', () => {
  assert.throws(
    () => buildPredictionLine({ body: 'X', confidence: 0.5, provenance: 'p:1' }),
    /date|by/i,
  );
});

test('buildPredictionLine rejects body containing a square-bracket close that would corrupt the line', () => {
  // [until ...] [confidence: ...] tags are parsed as inline; a stray ] in the
  // body would split the line. Refuse rather than escape (the user almost
  // certainly didn't mean to include it literally).
  assert.throws(
    () => buildPredictionLine({ body: 'X [will] happen', by: '2027-06', confidence: 0.5, provenance: 'p:1' }),
    /body/i,
  );
});

test('buildPredictionLine rejects empty body', () => {
  assert.throws(
    () => buildPredictionLine({ body: '', by: '2027-06', confidence: 0.5, provenance: 'p:1' }),
    /body/i,
  );
});

// ─── buildHypothesisLine ───────────────────────────────────────────────────

test('buildHypothesisLine produces a well-shaped [hypothesis] line (no [by] tag)', () => {
  const line = buildHypothesisLine({
    body: 'X might be true',
    confidence: 0.6,
    provenance: 'conversation:2026-05-19',
  });
  assert.equal(line, '[hypothesis] X might be true [confidence: 0.6] ^[conversation:2026-05-19]');
  // No [by ...] tag — hypotheses are open-ended, predictions are time-bounded.
  assert.doesNotMatch(line, /\[by/);
});

test('buildHypothesisLine confidence defaults to 0.5 when omitted', () => {
  const line = buildHypothesisLine({ body: 'X might be true', provenance: 'p:1' });
  assert.match(line, /\[confidence: 0\.5\]/);
});

test('buildHypothesisLine rejects confidence > 1', () => {
  assert.throws(
    () => buildHypothesisLine({ body: 'X', confidence: 2, provenance: 'p:1' }),
    /confidence/i,
  );
});

test('buildHypothesisLine rejects empty body', () => {
  assert.throws(
    () => buildHypothesisLine({ body: '   ', provenance: 'p:1' }),
    /body/i,
  );
});

test('buildHypothesisLine rejects body containing close bracket', () => {
  assert.throws(
    () => buildHypothesisLine({ body: 'X [foo] Y', provenance: 'p:1' }),
    /body/i,
  );
});
