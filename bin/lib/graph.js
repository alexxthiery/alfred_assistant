// graph.js — pure body-parsing helpers that lift the graph (wikilinks,
// typed relations, observations) out of a page's body text. No fs.
//
// Exports: firstBodyLine, extractWikilinks, extractProvenanceMarkers,
//          parseObservations, parseRelations, levenshtein,
//          scoreSlugCandidates.
//
// scoreSlugCandidates is the pure core of bin/wiki's resolveSlugCandidates:
// caller assembles the page list from fs and passes it in. Same scoring
// logic, no fs dependency.

'use strict';

// HR12: normalize fm.aliases to an array. Frontmatter may carry it as an
// array, a string (single alias), or be missing entirely. Each call site
// previously rewrote the same three-arm ternary. Callers wanting a mutable
// copy should spread the result: `[...aliasesOf(fm)]`.
function aliasesOf(fm) {
  if (!fm) return [];
  if (Array.isArray(fm.aliases)) return fm.aliases;
  if (fm.aliases) return [fm.aliases];
  return [];
}

// HR12: build the `[[slug]]` test/replace regex. Escapes regex special chars
// in slug prophylactically — currently SLUG_RE forbids them, but if it ever
// loosens, every call site would otherwise need to remember to escape.
// Pass `'g'` for replace-all use; default (no flags) for .test() (the /g flag
// on .test is the HR01 stateful-regex bug).
function backlinkRegex(slug, flags = '') {
  const escaped = String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[\\[${escaped}\\]\\]`, flags);
}

function firstBodyLine(body) {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, 120);
  }
  return '';
}

function extractWikilinks(body) {
  const re = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;
  const out = new Set();
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out].sort();
}

function extractProvenanceMarkers(body) {
  const re = /\^\[(?:raw|telegram|lab|conversation|external)[:\/][^\]]+\]/g;
  return body.match(re) || [];
}

// Parse observations: list items of the form `- [category] body`.
// Categories: fact, hypothesis, opinion, claim, quote, question, decision, todo, idea.
// Optional strikethrough wrap: ~~[cat] ...~~
function parseObservations(body) {
  const out = [];
  const re = /^- (~~)?\[(fact|hypothesis|opinion|claim|quote|question|decision|todo|idea|prediction)\] (.+?)$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const superseded = !!m[1];
    const category = m[2];
    let text = m[3].trim();
    if (superseded) text = text.replace(/~~\s*(?=(?:\[(?:since|until|on|as-of|by)\s|\^\[|$))/, '');
    const dates = {};
    const dateRe = /\[(since|until|on|as-of|by)\s+(\d{4}(?:-\d{2}(?:-\d{2})?)?)\]/g;
    let dm;
    while ((dm = dateRe.exec(text)) !== null) {
      const key = dm[1] === 'as-of' ? 'asOf' : dm[1];
      dates[key] = dm[2];
    }
    // Inline [confidence: X.X] — used by [prediction] for calibration scoring,
    // but accepted on any observation category. Value must be a number in [0,1];
    // out-of-range or malformed values are silently dropped (the observation
    // still parses, just without a confidence reading).
    let confidence = null;
    const confRe = /\[confidence:\s*(\d+(?:\.\d+)?)\]/i;
    const cMatch = text.match(confRe);
    if (cMatch) {
      const n = Number(cMatch[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) confidence = n;
    }
    const provenance = [];
    const provRe = /\^\[([^\]]+)\]/g;
    let pm;
    while ((pm = provRe.exec(text)) !== null) provenance.push(pm[1]);
    const cleaned = text
      .replace(/\[(since|until|on|as-of|by)\s+\d{4}(?:-\d{2}(?:-\d{2})?)?\]/g, '')
      .replace(/\[confidence:\s*\d+(?:\.\d+)?\]/gi, '')
      .replace(/\^\[[^\]]+\]/g, '')
      .replace(/~~/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ category, body: cleaned, text, dates, provenance, superseded, confidence });
  }
  return out;
}

// Parse relations: list items of the form `- relation_verb [[slug]]`
// or `- "multi word" [[slug]]`.
function parseRelations(body) {
  const out = [];
  const re1 = /^- ([a-z][a-z_]+) \[\[([a-z0-9][a-z0-9-]*)\]\]/gm;
  const re2 = /^- "([^"]+)" \[\[([a-z0-9][a-z0-9-]*)\]\]/gm;
  let m;
  while ((m = re1.exec(body)) !== null) out.push({ verb: m[1], target: m[2] });
  while ((m = re2.exec(body)) !== null) out.push({ verb: m[1], target: m[2] });
  return out;
}

// Classic Levenshtein distance (small inputs only — page titles).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Pure scoring core for fuzzy slug resolution. Caller passes pages as a
// list of { slug, title, aliases }; returns matches sorted by descending
// confidence. `opts.excludeSlug` skips a given slug (used by ingest to
// avoid self-matches on newly-created pages).
//
// Confidence tiers (see runbook: "Validation edge cases" in SCHEMA.md):
//   1.0   exact slug match (or normalized-slug)
//   0.95  exact title match (case-insensitive)
//   0.9   alias match
//   0.7   substring match in title or alias (>=3 chars)
//   0.5 - 0.1*lev   Levenshtein distance <= 2
function scoreSlugCandidates(query, pages, opts = {}) {
  const matches = [];
  const qLower = String(query).toLowerCase();
  const qNorm = qLower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const excludeSlug = opts.excludeSlug || null;

  for (const page of pages) {
    const { slug, title = '', aliases = [] } = page;
    if (excludeSlug && slug === excludeSlug) continue;
    const aliasList = Array.isArray(aliases) ? aliases : (aliases ? [aliases] : []);

    if (slug === query || slug === qNorm) {
      matches.push({ slug, confidence: 1.0, reason: 'exact slug' });
      continue;
    }
    if (title && title.toLowerCase() === qLower) {
      matches.push({ slug, confidence: 0.95, reason: `exact title "${title}"` });
      continue;
    }
    const aliasHit = aliasList.find((a) => a.toLowerCase() === qLower);
    if (aliasHit) {
      matches.push({ slug, confidence: 0.9, reason: `alias "${aliasHit}"` });
      continue;
    }
    const allNames = [title, ...aliasList].filter(Boolean);
    const subHit = allNames.find((n) => n.toLowerCase().includes(qLower) || qLower.includes(n.toLowerCase()));
    if (subHit && subHit.length >= 3) {
      matches.push({ slug, confidence: 0.7, reason: `substring "${subHit}"` });
      continue;
    }
    let bestLev = Infinity, bestName = null;
    for (const n of allNames) {
      if (Math.abs(n.length - query.length) > 3) continue;
      const d = levenshtein(n.toLowerCase(), qLower);
      if (d < bestLev) { bestLev = d; bestName = n; }
    }
    if (bestLev <= 2 && bestName) {
      matches.push({ slug, confidence: 0.5 - 0.1 * bestLev, reason: `Levenshtein ${bestLev} to "${bestName}"` });
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

module.exports = {
  aliasesOf,
  backlinkRegex,
  firstBodyLine,
  extractWikilinks,
  extractProvenanceMarkers,
  parseObservations,
  parseRelations,
  levenshtein,
  scoreSlugCandidates,
};
