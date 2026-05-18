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

module.exports = { formatIndex, formatLogLine, applyExtraFrontmatter, EXTRA_FIELDS, LIST_FIELDS };
