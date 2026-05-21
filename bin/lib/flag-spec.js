// flag-spec.js — derive the set of flags a verb legitimately accepts, so the
// CLI can reject unknown flags loudly instead of silently swallowing them.
//
// Background: parseArgs accepts ANY `--flag` into args. A flag a verb does not
// read is silently ignored (no error, no behavior change). That hid a real bug
// (`wiki list --limit N` did nothing). This module is the single source of
// truth for "what flags does verb X know", shared by the runtime validator
// (bin/wiki dispatch) AND the parity tests, so the two cannot drift.
//
// A verb's known flags come from three places:
//   1. Its help text (the VERBS table `lines` + optional `longHelp`) — every
//      `--flag` token mentioned there.
//   2. GLOBAL_FLAGS — accepted on every verb regardless of help.
//   3. extraValidFlags(verb) — code-only flags a verb reads but does not list
//      one-by-one in its terse help (write/patch funnel ~30 typed frontmatter
//      fields through EXTRA_FIELDS rather than documenting each).
//
// FREEFORM_VERBS accept arbitrary `--key=value` (e.g. `measure` takes a column
// per flag); validation is skipped for them.
//
// Pure: no fs, no process, no globals. Safe to require() from tests.

'use strict';

const { EXTRA_FIELDS } = require('./maintenance.js');

// Flags valid on any verb, never listed in per-verb help.
//   help            — per-verb help (handled before validation, but harmless)
//   no-auto-commit  — global write toggle, stripped before dispatch
//   accept-tamper   — tamper-check escape hatch (write verbs)
const GLOBAL_FLAGS = new Set(['help', 'no-auto-commit', 'accept-tamper']);

// Verbs that accept arbitrary `--key=value` flags. Flag validation is skipped.
//   measure — each `--<column>=<value>` writes a TSV column; columns are open-ended.
const FREEFORM_VERBS = new Set(['measure']);

// The shared write-core flag surface. Every write-class verb funnels through
// the same page-write + duplicate-check + replay-capture helpers (e.g. predict
// /hypothesize/capture call `cmdPatch({ ...args })`), so each inherits this
// whole set. Includes the typed-frontmatter family (EXTRA_FIELDS: born, when,
// scholar, ...) plus the structural write flags. Documenting all of these in
// every verb's terse help would bloat it; instead they live here, and the
// flag-parity test guarantees the set stays complete against the code.
const WRITE_CORE_FLAGS = new Set([
  ...EXTRA_FIELDS,
  'add-tag', 'alias', 'allow-duplicates', 'allow-secret', 'append', 'content',
  'file', 'force-alias', 'force-duplicate', 'no-anchor', 'observation',
  'provenance', 'relation', 'remove-tag', 'replace', 'replay', 'soft', 'stdin',
  'summary', 'supersede', 'tags', 'title', 'type', 'dry-run', 'today', 'on',
]);

// Verbs that thread args through the shared write core and so accept the whole
// WRITE_CORE_FLAGS surface.
const WRITE_CLASS_VERBS = new Set([
  'write', 'patch', 'ingest', 'merge', 'mv', 'predict', 'hypothesize',
  'capture', 'groom', 'todo',
]);

// Per-verb code-only flags outside the write core.
//   groom --propose/--apply: read only to report "not implemented" (mechanical
//     is the sole mode), so they are accepted but not advertised.
const VERB_EXTRA_FLAGS = {
  groom: ['propose', 'apply'],
};

// Code-only flags a verb reads but does not enumerate in its one-line help.
function extraValidFlags(verb) {
  const s = new Set();
  if (WRITE_CLASS_VERBS.has(verb)) for (const f of WRITE_CORE_FLAGS) s.add(f);
  for (const f of VERB_EXTRA_FLAGS[verb] || []) s.add(f);
  return s;
}

// Extract `--flag` tokens from help text. Handles `[--tag t]`, `--a|--b`,
// `--field=value` (captures `field`). Strips HTML comments first so the
// `<!--obs:XXXXXX-->` marker mentioned in some help strings is not misread as
// an `--obs` flag.
function flagsFromHelpText(helpText) {
  const text = String(helpText || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const out = new Set();
  for (const m of text.matchAll(/--([a-z][a-z0-9-]*)/g)) {
    out.add(m[1]);
  }
  return out;
}

// The full set of flags `verb` accepts, given its help text.
function knownFlags(verb, helpText) {
  const s = new Set(GLOBAL_FLAGS);
  for (const f of flagsFromHelpText(helpText)) s.add(f);
  for (const f of extraValidFlags(verb)) s.add(f);
  return s;
}

// Flags that always take a value. parseArgs turns a value-less flag into the
// boolean `true` (e.g. `wiki write x --title --type entity` makes title=true),
// which the write path then stringifies to "true" and persists — silent
// corruption. If any of these is present as boolean `true`, that is an error.
//
// Conservative by construction: listing a flag here only ADDS a guard, never a
// false rejection. Boolean flags (--soft, --append, --dry-run, --slugs-only,
// --sensitive, ...) are intentionally absent, so they can never be rejected.
// Omitting a value flag leaves it unguarded but never breaks anything.
const VALUE_REQUIRED_FLAGS = new Set([
  // identity / content
  'title', 'summary', 'content', 'type', 'tags', 'alias', 'add-tag', 'remove-tag',
  'hooks',
  // observations / relations
  'observation', 'relation', 'supersede', 'provenance',
  // typed frontmatter + external links
  'born', 'visibility', 'confidence', 'source', 'location', 'duration',
  'recurrence', 'attendees', 'derived_from', 'supersedes', 'decided_on',
  'raw_path', 'sha256', 'homepage', 'scholar', 'orcid', 'github', 'linkedin',
  'twitter', 'arxiv', 'email', 'status', 'due', 'priority',
  // dates / numbers / selectors
  'on', 'by', 'since', 'until', 'days', 'limit', 'max-hops', 'threshold',
  'only', 'date', 'birth', 'window', 'month-day', 'to', 'asof',
]);

// Value-required flags that were passed with no value (boolean `true`).
function valuelessFlags(args) {
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === '_') continue;
    if (VALUE_REQUIRED_FLAGS.has(k) && v === true) out.push(k);
  }
  return out;
}

// Flag keys present in `args` that the verb does not accept. Empty for
// free-form verbs. `_` (positionals) is never a flag.
function unknownFlags(verb, args, helpText) {
  if (FREEFORM_VERBS.has(verb)) return [];
  const known = knownFlags(verb, helpText);
  const out = [];
  for (const key of Object.keys(args)) {
    if (key === '_') continue;
    if (!known.has(key)) out.push(key);
  }
  return out;
}

module.exports = {
  GLOBAL_FLAGS,
  FREEFORM_VERBS,
  VALUE_REQUIRED_FLAGS,
  flagsFromHelpText,
  extraValidFlags,
  knownFlags,
  unknownFlags,
  valuelessFlags,
};
