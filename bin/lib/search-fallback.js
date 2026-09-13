// search-fallback.js — deterministic Node-only retrieval for wiki search.
//
// This is the fail-safe path for environments without DuckDB. It does not
// replace BM25; it keeps the assistant's retrieval reflex usable when the analytical
// index is unavailable.

'use strict';

const { stripSupersededObservationLines } = require('./graph.js');
const { matchesTagExpression, parseTagExpression } = require('./tag-filter.js');
const { confidenceForCandidate, labelMatch, queryTokens } = require('./retrieval.js');

function tokenizeSearchQuery(value) {
  return queryTokens(value);
}

function labelsForPage(page) {
  const fm = page.fm || {};
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
  return [page.slug, fm.id, fm.title, ...aliases]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

function firstTokenIndex(text, tokens) {
  const lower = String(text || '').toLowerCase();
  let best = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

function excerptForBody(body, tokens) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const idx = firstTokenIndex(text, tokens);
  if (idx < 0) return '';
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + 120);
  return text.slice(start, end).trim();
}

function scoreSearchPage(page, tokens, query) {
  if (!tokens.length) return null;
  const body = stripSupersededObservationLines(page.body);
  const labelText = labelsForPage(page).join(' ').toLowerCase();
  const bodyText = body.toLowerCase();
  const queryText = String(query || '').trim().toLowerCase();

  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    const inLabel = labelText.includes(token);
    const inBody = bodyText.includes(token);
    if (!inLabel && !inBody) continue;
    matched++;
    if (inLabel) score += 8;
    if (inBody) score += 2;
  }
  if (matched === 0) return null;
  if (queryText && labelText.includes(queryText)) score += 12;
  if (queryText && bodyText.includes(queryText)) score += 4;
  score += matched / tokens.length;

  const fm = page.fm || {};
  const confidence = confidenceForCandidate(query, { ...page, body }, { threshold: page.threshold });
  const label = labelMatch(query, page);
  return {
    slug: fm.id || page.slug,
    title: fm.title || '',
    score,
    via: label ? label.via : 'lexical',
    confidence,
    excerpt: excerptForBody(body, tokens),
  };
}

function searchPagesLexical(pages, opts) {
  const query = opts.query || '';
  const tokens = tokenizeSearchQuery(query);
  const limit = Math.max(1, opts.limit || 20);
  const doneSet = opts.doneSet || null;
  const tagAst = opts.tag ? parseTagExpression(opts.tag) : null;
  const rows = [];

  for (const page of pages) {
    const fm = page.fm || {};
    const slug = fm.id || page.slug;
    if (doneSet && doneSet.has(slug)) continue;
    if (tagAst && !matchesTagExpression(Array.isArray(fm.tags) ? fm.tags : [], tagAst)) continue;
    const scored = scoreSearchPage({ ...page, slug, threshold: opts.threshold }, tokens, query);
    if (scored) rows.push(scored);
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.slug.localeCompare(b.slug);
  });
  return rows.slice(0, limit);
}

module.exports = {
  tokenizeSearchQuery,
  scoreSearchPage,
  searchPagesLexical,
};
