// ingest-body.js — pure renderers that turn an ingest spec into markdown body
// lines. No fs, no globals. The category list comes from lib/ingest.js
// (single source of truth) so the renderer and the ingest validator's
// hasContent check never drift. Consumed by cmdIngest.

'use strict';

const { OBSERVATION_CATEGORIES } = require('./ingest.js');

// Format an observation spec into a markdown line.
// spec: {body, since?, until?, on?, asOf?, tags?, source?}
// defaultSource: applied if obs has no own source (becomes ^[default])
function formatObservation(spec, category, defaultSource) {
  // E1: accept a bare string as shorthand for { body: "..." }. The natural
  // spec `hypotheses: ["plain text"]` used to silently drop every element
  // (no `.body`), producing content-free pages with no error.
  if (typeof spec === 'string') spec = { body: spec };
  if (!spec || !spec.body) return null;
  const dateParts = [];
  if (spec.since) dateParts.push(`[since ${spec.since}]`);
  if (spec.until) dateParts.push(`[until ${spec.until}]`);
  if (spec.on) dateParts.push(`[on ${spec.on}]`);
  if (spec.asOf) dateParts.push(`[as-of ${spec.asOf}]`);
  const tagParts = (Array.isArray(spec.tags) ? spec.tags : []).map((t) => `#${t}`);
  const source = spec.source || defaultSource;
  const provPart = source ? `^[${source}]` : '';
  const segments = [spec.body.trim(), ...dateParts, ...tagParts, provPart].filter(Boolean);
  return `- [${category}] ${segments.join(' ')}`;
}

function formatRelation(rel) {
  if (!rel || !rel.verb || !rel.target) return null;
  // Multi-word verbs: quote
  if (/\s/.test(rel.verb)) return `- "${rel.verb}" [[${rel.target}]]`;
  return `- ${rel.verb} [[${rel.target}]]`;
}

function buildBodyFromSpec(spec, defaultSource) {
  const lines = [];
  if (spec.summary) { lines.push(spec.summary.trim()); lines.push(''); }
  // Categories come from the single source of truth in lib/ingest.js, so the
  // renderer and the ingest validator's hasContent check never drift.
  for (const [cat, field] of OBSERVATION_CATEGORIES) {
    const arr = spec[field];
    if (!Array.isArray(arr)) continue;
    for (const obs of arr) {
      const line = formatObservation(obs, cat, defaultSource);
      if (line) lines.push(line);
    }
  }
  if (Array.isArray(spec.relations)) {
    for (const r of spec.relations) {
      const line = formatRelation(r);
      if (line) lines.push(line);
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

module.exports = { formatObservation, formatRelation, buildBodyFromSpec };
