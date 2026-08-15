'use strict';

// retrieval.js — pure helpers for confidence/explainable retrieval.
//
// This module deliberately does not read files or call DuckDB. It provides the
// small deterministic pieces that search/eval/context can share: normalized
// query tokens, boundary-safe title/alias matching, and simple word coverage.

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do',
  'does', 'for', 'from', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it',
  'list', 'me', 'my', 'not', 'of', 'on', 'or', 'the', 'their', 'then', 'there',
  'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function queryTokens(value) {
  const raw = normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const kept = raw.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(kept.length ? kept : raw.filter((t) => t.length >= 2))];
}

function tokenSet(value) {
  return new Set(queryTokens(value));
}

function labelsForPage(page) {
  const fm = page && page.fm || {};
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : (fm.aliases ? [fm.aliases] : []);
  return [page && page.slug, fm.id, fm.title, ...aliases]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
}

function phraseToBoundaryRegex(phrase) {
  const tokens = queryTokens(phrase);
  if (!tokens.length) return null;
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(^|[^a-z0-9])${escaped.join('[^a-z0-9]+')}([^a-z0-9]|$)`, 'i');
}

function labelMatch(query, page) {
  const q = String(query || '').trim();
  const qTokens = queryTokens(q);
  if (!qTokens.length) return null;
  const qNorm = qTokens.join(' ');
  const titleNorm = queryTokens(page && page.fm && page.fm.title || '').join(' ');
  let best = null;

  for (const label of labelsForPage(page)) {
    const labelTokens = queryTokens(label);
    if (!labelTokens.length) continue;
    const labelNorm = labelTokens.join(' ');
    const exact = labelNorm === qNorm;
    const phraseRe = phraseToBoundaryRegex(q);
    const phrase = phraseRe ? phraseRe.test(normalizeText(label)) : false;
    const labelTokSet = new Set(labelTokens);
    const overlap = qTokens.filter((t) => labelTokSet.has(t));
    const coverage = qTokens.length ? overlap.length / qTokens.length : 0;
    if (!exact && !phrase && coverage === 0) continue;
    const via = exact
      ? (labelNorm === titleNorm ? 'title-exact' : 'alias-exact')
      : (phrase ? 'label-phrase' : 'label-token');
    const row = {
      via,
      label,
      matchedTokens: overlap,
      coverage,
      strong: exact || phrase || coverage === 1,
    };
    const priority = row.via === 'title-exact' ? 4
      : row.via === 'alias-exact' ? 3
        : row.via === 'label-phrase' ? 2
          : 1;
    row.priority = priority;
    if (!best || Number(row.strong) > Number(best.strong) || row.priority > best.priority || row.coverage > best.coverage) best = row;
  }
  return best;
}

function coverageForText(query, text) {
  const tokens = queryTokens(query);
  if (!tokens.length) return { coverage: 0, matchedTokens: [], missingTokens: [] };
  const hay = tokenSet(text);
  const matchedTokens = tokens.filter((t) => hay.has(t));
  const missingTokens = tokens.filter((t) => !hay.has(t));
  return {
    coverage: matchedTokens.length / tokens.length,
    matchedTokens,
    missingTokens,
  };
}

function confidenceForCandidate(query, candidate, opts = {}) {
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : 0.5;
  const label = labelMatch(query, candidate);
  if (label && label.strong) {
    return {
      confident: true,
      reason: label.via,
      coverage: label.coverage,
      matchedTokens: label.matchedTokens,
      missingTokens: [],
      threshold,
    };
  }
  const bodyCoverage = coverageForText(query, candidate && candidate.body || '');
  const confident = bodyCoverage.coverage >= threshold;
  return {
    confident,
    reason: confident ? 'body-coverage' : 'low-coverage',
    coverage: bodyCoverage.coverage,
    matchedTokens: bodyCoverage.matchedTokens,
    missingTokens: bodyCoverage.missingTokens,
    threshold,
  };
}

function rankRetrievalCandidates(query, pages, opts = {}) {
  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : 0.5;
  const rows = [];
  for (const page of pages || []) {
    const label = labelMatch(query, page);
    const confidence = confidenceForCandidate(query, page, { threshold });
    const bodyCoverage = coverageForText(query, page && page.body || '');
    if (!label && bodyCoverage.coverage === 0) continue;
    rows.push({
      slug: page.slug,
      title: page.fm && page.fm.title || '',
      via: label ? label.via : 'body',
      label,
      confidence,
      coverage: Math.max(label ? label.coverage : 0, bodyCoverage.coverage),
      bodyCoverage,
      page,
    });
  }
  rows.sort((a, b) => {
    const aLabel = a.label && a.label.strong ? 1 : 0;
    const bLabel = b.label && b.label.strong ? 1 : 0;
    if (bLabel !== aLabel) return bLabel - aLabel;
    if (Number(b.confidence.confident) !== Number(a.confidence.confident)) {
      return Number(b.confidence.confident) - Number(a.confidence.confident);
    }
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    return String(a.slug || '').localeCompare(String(b.slug || ''));
  });
  return rows;
}

function formatCoverage(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

module.exports = {
  STOPWORDS,
  normalizeText,
  queryTokens,
  labelsForPage,
  phraseToBoundaryRegex,
  labelMatch,
  coverageForText,
  confidenceForCandidate,
  rankRetrievalCandidates,
  formatCoverage,
};
