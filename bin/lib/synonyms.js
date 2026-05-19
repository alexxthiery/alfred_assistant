// synonyms.js — parse a tiny SYNONYMS.md file and expand a query string at
// retrieval time. Closes the paraphrase gap for BM25 search without an
// embedding model.
//
// File format (line-oriented, intentionally minimal):
//
//   # comments start with #
//   key = syn1, syn2, syn3
//   teacher = instructor, educator
//
// Keys are lowercased on parse. Lookup is case-insensitive. Malformed lines
// (no `=`) are silently skipped — better to drop a typo than refuse the whole
// file at startup.
//
// `expandQuery(text, syns)` splits the input on whitespace, looks up each
// token in the synonyms Map, and emits a flat space-separated string carrying
// the original tokens plus every synonym. Order within the expansion is not
// preserved (BM25 is order-agnostic). When `syns` is null/undefined the
// function is a lowercased identity.
//
// No fs — pure module. Callers handle file resolution.

'use strict';

function parseSynonymsFile(text) {
  const out = new Map();
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    const values = line
      .slice(eq + 1)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (values.length === 0) continue;
    out.set(key, values);
  }
  return out;
}

function expandQuery(text, syns) {
  if (!text) return '';
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!syns || !(syns instanceof Map) || syns.size === 0) {
    return tokens.join(' ');
  }
  const seen = new Set();
  const out = [];
  const add = (t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const tok of tokens) {
    add(tok);
    const synList = syns.get(tok);
    if (synList) for (const s of synList) add(s);
  }
  return out.join(' ');
}

module.exports = { parseSynonymsFile, expandQuery };
