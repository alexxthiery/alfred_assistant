// supersession.js — pure helpers for retiring observations with structured
// metadata. The CLI keeps old observations instead of deleting them; this file
// owns the small `[reason: ...] [replaced_by: ...]` contract.

'use strict';

const { extractId, mintId } = require('./obsid.js');

const REASON_RE = /^[a-z][a-z0-9-]{0,31}$/;
const OBS_HANDLE_RE = /^obs:[a-z0-9]{6}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const SLUG_OBS_HANDLE_RE = /^[a-z0-9][a-z0-9-]*#obs:[a-z0-9]{6}$/;

function validateSupersedeReason(reason) {
  if (reason === undefined || reason === null || reason === false || reason === '') return null;
  const s = String(reason).trim();
  if (!REASON_RE.test(s)) {
    return `invalid supersede reason "${reason}"; use a lowercase token like corrected, split, moved, stale, duplicate`;
  }
  return null;
}

function normalizeSupersedeReason(reason) {
  if (reason === undefined || reason === null || reason === false || reason === '') return null;
  return String(reason).trim();
}

function validReplacedByHandle(handle) {
  return OBS_HANDLE_RE.test(handle) || SLUG_RE.test(handle) || SLUG_OBS_HANDLE_RE.test(handle);
}

function parseReplacedBy(value) {
  if (value === undefined || value === null || value === false || value === '') {
    return { values: [], error: null };
  }
  const values = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (!values.length) return { values: [], error: 'replaced_by must name at least one obs/page handle' };
  const bad = values.filter((v) => !validReplacedByHandle(v));
  if (bad.length) {
    return {
      values,
      error: `invalid replaced_by handle(s): ${bad.join(', ')}; use obs:abc123, page-slug, or page-slug#obs:abc123`,
    };
  }
  return { values, error: null };
}

function formatSupersedeAnnotations({ until, reason, replacedBy } = {}) {
  if (!until) throw new Error('formatSupersedeAnnotations requires until');
  const parts = [`[until ${until}]`];
  const normalizedReason = normalizeSupersedeReason(reason);
  if (normalizedReason) {
    const err = validateSupersedeReason(normalizedReason);
    if (err) throw new Error(err);
    parts.push(`[reason: ${normalizedReason}]`);
  }
  const rb = Array.isArray(replacedBy)
    ? replacedBy
    : parseReplacedBy(replacedBy).values;
  if (rb.length) {
    const parsed = parseReplacedBy(rb.join(','));
    if (parsed.error) throw new Error(parsed.error);
    parts.push(`[replaced_by: ${parsed.values.join(', ')}]`);
  }
  return parts.join(' ');
}

function ensureObservationLineId(line) {
  const id = extractId(line);
  if (id) return { line, id };
  const nextId = mintId();
  return { line: `${String(line).replace(/\s+$/, '')} <!--obs:${nextId}-->`, id: nextId };
}

function supersedeObservationLine(line, { until, reason, replacedBy } = {}) {
  const text = String(line || '');
  if (!/^- (?:~~)?\[/.test(text)) {
    return { line: text, error: 'line is not an observation' };
  }
  if (/^- ~~/.test(text)) {
    return { line: text, error: `already superseded: ${text}` };
  }
  const reasonError = validateSupersedeReason(reason);
  if (reasonError) return { line: text, error: reasonError };
  const rb = parseReplacedBy(Array.isArray(replacedBy) ? replacedBy.join(',') : replacedBy);
  if (rb.error) return { line: text, error: rb.error };
  const annotations = formatSupersedeAnnotations({ until, reason, replacedBy: rb.values });
  const m = text.match(/^- (\[[a-z]+\][\s\S]*?)\s*$/);
  if (!m) return { line: text, error: 'line is not a supported observation category' };
  return { line: `- ~~${m[1]}~~ ${annotations}`, error: null };
}

module.exports = {
  REASON_RE,
  OBS_HANDLE_RE,
  SLUG_RE,
  SLUG_OBS_HANDLE_RE,
  validateSupersedeReason,
  parseReplacedBy,
  formatSupersedeAnnotations,
  ensureObservationLineId,
  supersedeObservationLine,
};
