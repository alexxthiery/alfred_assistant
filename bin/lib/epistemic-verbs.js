// epistemic-verbs.js — pure builders for the observation lines produced by
// `wiki predict` and `wiki hypothesize`. The CLI verbs glue these to fs +
// cmdPatch in bin/wiki; this module has no side effects so it's unit-testable.
//
// Why a dedicated module: the [prediction]/[hypothesis] line shape has to
// stay in lockstep with parseObservations' regex in bin/lib/graph.js. By
// keeping construction here we get a single source of truth that's easy to
// extend (e.g., if [confidence] precision rules change).

'use strict';

const DATE_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

function assertConfidence(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    throw new Error(`confidence must be a number in [0, 1]; got ${confidence}`);
  }
  if (confidence < 0 || confidence > 1) {
    throw new Error(`confidence ${confidence} out of range [0, 1]`);
  }
}

function assertBody(body) {
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('body must be a non-empty string');
  }
  // Square brackets in body would collide with inline tag syntax
  // ([by ...], [confidence: ...], [since ...] etc.) and corrupt the line on
  // re-parse. Refuse rather than escape: the user is constructing a sentence,
  // not a markdown subset; if they truly meant brackets, they can write the
  // line by hand via `wiki patch --observation`.
  if (/[\[\]]/.test(body)) {
    throw new Error('body contains "[" or "]" which would corrupt the inline-tag layout; rephrase or use `wiki patch --observation` directly');
  }
}

function assertDate(date, fieldName) {
  if (!date || typeof date !== 'string') {
    throw new Error(`${fieldName} date is required (YYYY, YYYY-MM, or YYYY-MM-DD)`);
  }
  if (!DATE_RE.test(date)) {
    throw new Error(`${fieldName} date must match YYYY[-MM[-DD]]; got "${date}"`);
  }
}

function assertProvenance(prov) {
  if (typeof prov !== 'string' || !prov.trim()) {
    throw new Error('provenance must be a non-empty string (e.g. "conversation:2026-05-19")');
  }
}

function buildPredictionLine({ body, by, confidence, provenance }) {
  assertBody(body);
  assertDate(by, 'by');
  assertConfidence(confidence);
  assertProvenance(provenance);
  return `[prediction] ${body.trim()} [by ${by}] [confidence: ${confidence}] ^[${provenance}]`;
}

function buildHypothesisLine({ body, confidence, provenance }) {
  assertBody(body);
  const c = confidence === undefined ? 0.5 : confidence;
  assertConfidence(c);
  assertProvenance(provenance);
  return `[hypothesis] ${body.trim()} [confidence: ${c}] ^[${provenance}]`;
}

// Default provenance helper. `today` is a Date instance (DI for tests); when
// omitted the call site uses `new Date()`.
function defaultProvenance(today = new Date()) {
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  return `conversation:${y}-${m}-${d}`;
}

module.exports = { buildPredictionLine, buildHypothesisLine, defaultProvenance, assertBody };
