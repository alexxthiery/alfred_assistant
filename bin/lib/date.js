// date.js — single source of truth for ISO-date (YYYY-MM-DD) shape validation.
//
// This regex had drifted across ~6 call sites (capture --on, wiki day,
// agenda --on, stampOnDate, daily-brief). Centralising it gives one place to
// fix if the accepted shape ever changes, and removes the risk of a subtle
// divergence between sites.
//
// Shape gate only — NOT a calendar validator. `2026-13-40` matches the shape;
// callers that need real-date correctness parse with Date() downstream.
//
// No fs, no deps — pure module.

'use strict';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function isISODate(s) {
  return typeof s === 'string' && ISO_RE.test(s);
}

module.exports = { isISODate, ISO_RE };
