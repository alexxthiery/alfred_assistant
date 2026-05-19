// Unit tests for bin/lib/capture-classifier.js — pure utterance classifier
// that routes user-speech shape to an observation category + confidence + date.
//
// The classifier is deterministic: regex-based shape lexicon, precedence
// resolver, confidence inference, date extraction. No NLP. Output is consumed
// by `cmdCapture` in bin/wiki which builds the observation line and delegates
// to cmdPatch.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { classifyUtterance } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'capture-classifier.js'),
);

const { parseObservations } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'graph.js'),
);

// ─── per-category detection ────────────────────────────────────────────────

test('classifyUtterance: question — interrogative shape', () => {
  const r = classifyUtterance('Why does the loss spike at epoch 50?');
  assert.equal(r.category, 'question');
});

test('classifyUtterance: question — bare interrogative without trailing question mark', () => {
  const r = classifyUtterance('Should I drop the project');
  assert.equal(r.category, 'question');
});

test('classifyUtterance: decision — "I\'ve decided"', () => {
  const r = classifyUtterance("I've decided to drop project X");
  assert.equal(r.category, 'decision');
});

test('classifyUtterance: claim — "X says Y"', () => {
  const r = classifyUtterance('someone says the system is strong');
  assert.equal(r.category, 'claim');
  assert.equal(r.source, 'someone');
});

test('classifyUtterance: claim — "according to X"', () => {
  const r = classifyUtterance('according to somebody the result holds');
  assert.equal(r.category, 'claim');
});

test('classifyUtterance: prediction — future-tense + date', () => {
  const r = classifyUtterance('X will happen by July 2027');
  assert.equal(r.category, 'prediction');
  assert.equal(r.by_date, '2027-07');
});

test('classifyUtterance: prediction — "probably" bumps confidence to 0.7', () => {
  const r = classifyUtterance('X will probably happen by 2027');
  assert.equal(r.category, 'prediction');
  assert.equal(r.confidence, 0.7);
});

test('classifyUtterance: prediction-without-date refuses', () => {
  const r = classifyUtterance('X will eventually happen');
  assert.equal(r.category, null);
  assert.equal(r.refuseReason, 'prediction-without-date');
});

test('classifyUtterance: hypothesis — "I think X"', () => {
  const r = classifyUtterance('I think X is true');
  assert.equal(r.category, 'hypothesis');
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
});

test('classifyUtterance: opinion — preference stance', () => {
  const r = classifyUtterance('I prefer X over Y');
  assert.equal(r.category, 'opinion');
});

test('classifyUtterance: opinion — "is the best" stance', () => {
  const r = classifyUtterance('Approach X is the best one we have');
  assert.equal(r.category, 'opinion');
});

test('classifyUtterance: idea — "what if"', () => {
  const r = classifyUtterance('What if we tried Langevin dynamics');
  assert.equal(r.category, 'idea');
});

test('classifyUtterance: fact fallback — bare declarative', () => {
  const r = classifyUtterance('the user is twelve years old');
  assert.equal(r.category, 'fact');
});

// ─── confidence inference ──────────────────────────────────────────────────

test('classifyUtterance: confidence — "definitely" → 0.9', () => {
  const r = classifyUtterance('I think X is definitely true');
  assert.equal(r.confidence, 0.9);
});

test('classifyUtterance: confidence — "might" → 0.5', () => {
  const r = classifyUtterance('I think X might be true');
  assert.equal(r.confidence, 0.5);
});

test('classifyUtterance: confidence — "unlikely" → 0.2', () => {
  const r = classifyUtterance('I think X is unlikely to hold');
  assert.equal(r.confidence, 0.2);
});

// ─── date extraction ───────────────────────────────────────────────────────

test('classifyUtterance: extracts "by Month YYYY" → YYYY-MM', () => {
  const r = classifyUtterance('X will happen by July 2027');
  assert.equal(r.by_date, '2027-07');
});

test('classifyUtterance: extracts "by Qn YYYY" → end-of-quarter month', () => {
  const r = classifyUtterance('X will happen by Q3 2026');
  assert.equal(r.by_date, '2026-09');
});

test('classifyUtterance: extracts "by YYYY-MM-DD" verbatim', () => {
  const r = classifyUtterance('X will happen by 2027-06-15');
  assert.equal(r.by_date, '2027-06-15');
});

// ─── precedence ────────────────────────────────────────────────────────────

test('classifyUtterance: precedence — claim wins over prediction (attribution dominant)', () => {
  // somebody's prediction is somebody's; the user's act is reporting somebody.
  const r = classifyUtterance('somebody says X will happen by 2027');
  assert.equal(r.category, 'claim');
});

test('classifyUtterance: precedence — question wins over decision (interrogative dominant)', () => {
  const r = classifyUtterance('Should I drop project X?');
  assert.equal(r.category, 'question');
});

// ─── refusal modes ─────────────────────────────────────────────────────────

test('classifyUtterance: rejects body containing "[" (would corrupt inline tags)', () => {
  assert.throws(() => classifyUtterance('X [foo] Y'), /\[|]|bracket/i);
});

test('classifyUtterance: rejects empty input', () => {
  assert.throws(() => classifyUtterance(''), /body|empty/i);
});

test('classifyUtterance: rejects whitespace-only input', () => {
  assert.throws(() => classifyUtterance('   \t\n  '), /body|empty/i);
});

// ─── roundtrip via parseObservations ───────────────────────────────────────
// Lines constructed downstream from these results must parse back to the
// same category. This locks the contract with bin/lib/graph.js.

test('roundtrip: hypothesis line parses back to category=hypothesis', () => {
  const r = classifyUtterance('I think X is true');
  // Mimic cmdCapture's line construction for non-prediction categories.
  const line = `- [${r.category}] ${r.body} [confidence: ${r.confidence}] ^[t:1]`;
  const obs = parseObservations(line);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].category, 'hypothesis');
});

test('roundtrip: question line parses back to category=question', () => {
  const r = classifyUtterance('Why does the loss spike?');
  const line = `- [${r.category}] ${r.body} ^[t:1]`;
  const obs = parseObservations(line);
  assert.equal(obs[0].category, 'question');
});

test('roundtrip: claim line parses back to category=claim', () => {
  const r = classifyUtterance('somebody says X is true');
  const line = `- [${r.category}] ${r.body} ^[t:1]`;
  const obs = parseObservations(line);
  assert.equal(obs[0].category, 'claim');
});
