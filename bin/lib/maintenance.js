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

const EXTRA_FIELDS = [
  'status', 'due', 'priority', 'decided_on', 'supersedes', 'derived_from',
  'raw_path', 'sha256', 'aliases', 'source',
  'homepage', 'scholar', 'orcid', 'github', 'linkedin', 'twitter', 'arxiv', 'email',
  'when', 'duration', 'location', 'attendees', 'recurrence',
];

const LIST_FIELDS = new Set(['derived_from', 'supersedes', 'aliases', 'attendees']);

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
  const byType = {};
  for (const { slug: fileSlug, fm, body } of pages) {
    const slug = fm.id || fileSlug;
    const title = fm.title || slug;
    const type = fm.type || 'note';
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

function applyExtraFrontmatter(fm, args) {
  for (const f of EXTRA_FIELDS) {
    if (args[f] !== undefined && args[f] !== false) {
      if (LIST_FIELDS.has(f) && typeof args[f] === 'string') {
        fm[f] = args[f].split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        fm[f] = args[f];
      }
    }
  }
}

module.exports = {
  formatIndex,
  formatLogLine,
  applyExtraFrontmatter,
  validateAliasArg,
  aliasValueError,
  EXTRA_FIELDS,
  LIST_FIELDS,
};
