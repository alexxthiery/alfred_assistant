// maintenance.js — pure cores of the vault-maintenance helpers.
//
// bin/wiki has three small mutators that drive the auto-maintained files:
// regenerateIndex (writes wiki/index.md), appendLog (writes wiki/log.md),
// applyExtraFrontmatter (mutates fm in-place from CLI args). The fs-touching
// wrappers stay in bin/wiki; their pure cores live here so unit tests can
// pin the output shape without standing up a vault.
//
// Exported:
//   formatIndex(pages, opts) — pages: Array<{slug, fm, body}>. Returns the
//     wiki/index.md text. opts.now is the timestamp string to embed.
//   formatLogLine(timestamp, op, detail) — returns one log line incl. trailing
//     newline. Format: `## [<ts>] <op> | <detail>\n`.
//   applyExtraFrontmatter(fm, args) — mutates fm in place. For each known
//     extra field present in args (and not false), copies it onto fm.
//     Comma-string lists are split for the list-typed fields (derived_from,
//     supersedes, aliases, attendees).
//
// All three are deterministic and synchronous. No fs, no globals, no time
// reads (caller supplies the timestamp). See audit/13 § module-purity.

'use strict';

const { firstBodyLine } = require('./graph.js');
const { isISO8601DateTime } = require('./date.js');

const EXTRA_FIELDS = [
  'status', 'due', 'priority', 'decided_on', 'supersedes', 'derived_from',
  'raw_path', 'sha256', 'aliases', 'source',
  'homepage', 'scholar', 'orcid', 'github', 'linkedin', 'twitter', 'arxiv', 'email',
  'when', 'duration', 'location', 'attendees', 'recurrence',
  'born', 'visibility', 'sensitive', 'confidence',
  'hooks',
  'remind_at', 'reminded_at', 'notify',
];

const LIST_FIELDS = new Set(['derived_from', 'supersedes', 'aliases', 'attendees', 'hooks', 'notify']);

// HR07: parse/serialize round-trip is lossy for aliases containing `,` or `]`
// (audit/12 § parser-robustness). User chose the reject-at-write path: any
// alias containing one of these forbidden characters is refused before the
// page is written, so the lossy-round-trip case can never materialize from
// the CLI. Returns [] on safe input, or a single-element error array.
const ALIAS_FORBIDDEN_CHARS = /[,\]]/;
function aliasValueError(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const m = value.match(ALIAS_FORBIDDEN_CHARS);
  if (!m) return null;
  return `alias "${value}" contains forbidden character "${m[0]}" (commas and right brackets break the frontmatter round-trip; see HR07)`;
}
function validateAliasArg(arg) {
  if (arg === undefined || arg === null || arg === false) return [];
  const list = Array.isArray(arg)
    ? arg
    : (typeof arg === 'string' ? arg.split(',').map((s) => s.trim()).filter(Boolean) : []);
  // Special case: a comma-string `"Foo, Bar"` from CLI is the *intended* two-alias
  // form, not one alias with a comma. But a comma-string `"Doe, John"` cannot be
  // distinguished from the same — so the user is stuck. We accept this as the
  // documented trade-off: array form (one alias per element) is the only safe
  // way to pass an alias that needs a comma in it (which we now refuse anyway).
  const errors = [];
  for (const v of list) {
    const e = aliasValueError(v);
    if (e) errors.push(e);
  }
  return errors;
}

function formatIndex(pages, opts = {}) {
  const now = opts.now || '';
  const today = now.slice(0, 10);
  const byType = {};
  for (const { slug: fileSlug, fm, body } of pages) {
    const type = fm.type || 'note';
    // Keep the browse index lean: omit retired items (they remain in wiki/ and
    // queryable via `todo list --include-done` / `agenda past`). Done todos are
    // operational chores, not knowledge; past events are historical.
    if (type === 'todo' && (fm.status || 'open') === 'done') continue;
    if (type === 'event' && fm.when && today && String(fm.when).slice(0, 10) < today) continue;
    const slug = fm.id || fileSlug;
    const title = fm.title || slug;
    const summary = firstBodyLine(body);
    (byType[type] ||= []).push({ slug, title, summary });
  }
  const sections = Object.keys(byType).sort();
  const out = ['# Wiki Index', '', `_Regenerated ${now}_`, ''];
  if (sections.length === 0) out.push('_(empty)_');
  for (const type of sections) {
    out.push(`## ${type}`);
    out.push('');
    for (const p of byType[type]) {
      out.push(`- [[${p.slug}]] — ${p.title}${p.summary ? `: ${p.summary}` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function formatLogLine(timestamp, op, detail) {
  return `## [${timestamp}] ${op} | ${detail}\n`;
}

// Validate + normalise a typed frontmatter value (used by `wiki write` via
// applyExtraFrontmatter AND by `wiki patch` for the same fields, so the two
// verbs accept identical input contracts). Returns {value, error}: value is
// the parsed/coerced form (e.g. true/false for booleans, Number for
// confidence); error is a human-readable string when invalid.
function validateExtraFieldValue(name, raw) {
  switch (name) {
    case 'born': {
      const v = String(raw).trim();
      if (!/^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/.test(v)) {
        return { error: `--born must be YYYY-MM-DD or MM-DD (got "${v}")` };
      }
      return { value: v };
    }
    case 'visibility': {
      const v = String(raw).trim();
      if (!['private', 'personal', 'public'].includes(v)) {
        return { error: `--visibility must be private|personal|public (got "${v}")` };
      }
      return { value: v };
    }
    case 'sensitive': {
      const v = raw === true ? 'true' : String(raw).trim().toLowerCase();
      if (!['true', 'false'].includes(v)) {
        return { error: `--sensitive must be true|false (got "${v}")` };
      }
      return { value: v === 'true' };
    }
    case 'confidence': {
      const v = String(raw).trim();
      const num = Number(v);
      if (!/^\d+(\.\d+)?$/.test(v) || !Number.isFinite(num) || num < 0 || num > 1) {
        return { error: `--confidence must be a number in [0, 1] (got "${v}")` };
      }
      return { value: num };
    }
    case 'remind_at':
    case 'reminded_at': {
      const v = String(raw).trim();
      if (!isISO8601DateTime(v)) {
        return { error: `--${name} must be ISO8601 datetime YYYY-MM-DDTHH:MM[:SS][±HH:MM|Z] (got "${v}")` };
      }
      return { value: v };
    }
    default:
      return { value: raw };
  }
}

// Soft-warn on hooks that look sentence-like instead of short connective
// concept names. A hook only creates a link if a FUTURE card lands on the same
// string, so a long/sentence-like hook (a whole claim crammed into a slug)
// bridges nothing. Returns human-readable warning strings (empty = all fine).
// Soft by design: callers print these as hints; they never block a write.
const HOOK_MAX_CHARS = 32;
const HOOK_MAX_HYPHENS = 3;
function hookWarnings(hooks) {
  const out = [];
  const list = Array.isArray(hooks) ? hooks : [];
  for (const h of list) {
    if (typeof h !== 'string' || !h) continue;
    const hyphens = (h.match(/-/g) || []).length;
    if (h.length > HOOK_MAX_CHARS || hyphens > HOOK_MAX_HYPHENS) {
      out.push(`hook "${h}" looks sentence-like (${h.length} chars, ${hyphens} hyphens); prefer a short standard concept name (e.g. advantage-baseline, control-variate, two-timescale)`);
    }
  }
  return out;
}

// Soft-warn on aliases that look too GENERIC to be safe autolink anchors.
// Autolink splices `[[slug]]` wherever an alias phrase appears in prose, so a
// common 1-2 word phrase ("optimal policy", "successor measure") as an alias
// rewrites that phrase across the whole vault — often to the wrong card (V1).
// A distinctive alias (long, hyphenated, capitalized acronym, or with digits)
// is a safe anchor; a short all-lowercase 1-2 word phrase is a smell. Soft by
// design (a hint, never a block) — mirrors hookWarnings.
const ALIAS_GENERIC_MAX_WORDS = 2;
// True for an alias too generic to be a safe autolink anchor: a short
// all-lowercase 1-2 word phrase with no distinctive marker (capital/acronym,
// digit, or hyphen). Distinctive aliases ("gamma-model", "DPO", >2 words) are
// safe. Shared by aliasWarnings (creation-time hint, V6) and buildTitleEntries
// (which excludes generic aliases from the autolink anchor set, V1).
function isGenericAlias(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  const s = v.trim();
  const words = s.split(/\s+/);
  const distinctive = /[A-Z]/.test(s) || /\d/.test(s) || s.includes('-') || words.length > ALIAS_GENERIC_MAX_WORDS;
  return !distinctive;
}

function aliasWarnings(aliases) {
  const out = [];
  const list = Array.isArray(aliases) ? aliases : (aliases ? [aliases] : []);
  for (const a of list) {
    if (typeof a !== 'string' || !a.trim()) continue;
    const v = a.trim();
    if (isGenericAlias(v)) {
      const n = v.split(/\s+/).length;
      out.push(`alias "${v}" looks generic (${n} common word${n === 1 ? '' : 's'}); autolink will link this phrase wherever it appears in prose, possibly to the wrong card. Prefer a distinctive term, or skip the alias.`);
    }
  }
  return out;
}

// C2: warn when one hook is over-applied across a single batch — a topic
// anchor splattered onto most cards is an instant stopword (it bridges
// everything, so it bridges nothing). `hooksPerCard` is an array of per-card
// hook arrays. Flags any hook on more than `fraction` of the cards (default
// 40%), once the batch is big enough to be meaningful (>= minCards). Returns
// human-readable warning strings (empty = fine). Soft: a creation-time hint,
// caught here instead of at a later `wiki review` dilution pass.
function batchHookWarnings(hooksPerCard, { fraction = 0.4, minCards = 5 } = {}) {
  const cards = Array.isArray(hooksPerCard) ? hooksPerCard : [];
  if (cards.length < minCards) return [];
  const count = new Map();
  for (const hooks of cards) {
    for (const h of new Set(Array.isArray(hooks) ? hooks : [])) {
      if (typeof h === 'string' && h) count.set(h, (count.get(h) || 0) + 1);
    }
  }
  const out = [];
  for (const [h, n] of count) {
    if (n > fraction * cards.length) {
      out.push(`hook "${h}" is on ${n}/${cards.length} cards in this batch (>${Math.round(fraction * 100)}%) — likely an over-applied topic anchor (a stopword that bridges everything). Reserve it for cards it genuinely instantiates.`);
    }
  }
  return out.sort();
}

function applyExtraFrontmatter(fm, args) {
  for (const f of EXTRA_FIELDS) {
    if (args[f] === undefined || args[f] === false) continue;
    if (LIST_FIELDS.has(f) && typeof args[f] === 'string') {
      fm[f] = args[f].split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const { value, error } = validateExtraFieldValue(f, args[f]);
    if (error) throw new Error(error);
    fm[f] = value;
  }
}

module.exports = {
  formatIndex,
  formatLogLine,
  applyExtraFrontmatter,
  validateExtraFieldValue,
  validateAliasArg,
  aliasValueError,
  hookWarnings,
  aliasWarnings,
  isGenericAlias,
  batchHookWarnings,
  EXTRA_FIELDS,
  LIST_FIELDS,
};
