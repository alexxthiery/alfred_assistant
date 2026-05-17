// audit.js — shared per-page audit rule table.
//
// Single source of truth for the per-page rules that both:
//   - `wiki audit` runs at audit-time (all rules, severity-weighted scoring)
//   - `wiki write` runs at write-time (the `strict: true` subset, blocks writes)
//
// Each entry: { name, severity, strict, check(input, deps) }.
//   input: { slug, title, type, tags, body, fm }
//   deps:  { schema, knownVerbs }
//   check: returns null (clean) or { detail, message, examples? }
//     detail  → used by audit-shape output
//     message → used by validateBody-shape output (with extra guidance)
//
// auditPage runs all rules; iterateStrict runs only `strict: true` rules.

'use strict';

const { ENTITY_KIND_TAGS } = require('./schema.js');
const { parseRelations, parseObservations } = require('./graph.js');

const STRICT_PROV_TYPES = new Set(['entity', 'event', 'concept', 'synthesis']);
const SUBSTANTIVE_TYPES = new Set(['entity', 'event', 'concept']);

const AUDIT_RULES = [
  {
    name: 'mislabeled-event',
    severity: 'high',
    strict: true,
    check: ({ title, type }, { schema }) => {
      if (type === 'event' || !title) return null;
      if (!schema || !schema.eventKeywords || !schema.eventKeywords.size) return null;
      const titleLower = String(title).toLowerCase();
      const hits = [];
      for (const kw of schema.eventKeywords) {
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        if (re.test(titleLower)) hits.push(kw);
      }
      if (!hits.length) return null;
      return {
        detail: `title contains: ${hits.join(', ')} but type=${type}`,
        message: `Title "${title}" contains event keyword(s) (${hits.join(', ')}) but type=${type}. Use --type event. (Override with --soft if intentional.)`,
      };
    },
  },

  {
    name: 'mislabeled-entity',
    severity: 'high',
    strict: false,
    check: ({ type, tags }) => {
      if (type !== 'note') return null;
      if (!Array.isArray(tags)) return null;
      const ek = tags.filter((t) => ENTITY_KIND_TAGS.has(t));
      if (!ek.length) return null;
      return {
        detail: `type=note but tagged: ${ek.join(', ')} (should be type=entity)`,
        message: `type=note but tagged: ${ek.join(', ')} (should be type=entity)`,
      };
    },
  },

  {
    name: 'uncategorized-bullets',
    severity: 'medium',
    strict: true,
    check: ({ body }) => {
      if (!body) return null;
      const uncat = [];
      for (const line of body.split('\n')) {
        if (!/^- /.test(line)) continue;
        if (/^- (?:~~)?\[(?:fact|hypothesis|opinion|claim|quote|question|decision|todo|idea)\]/.test(line)) continue;
        if (/^- (?:[a-z][a-z_]+|"[^"]+") \[\[[a-z0-9][a-z0-9-]*\]\]/.test(line)) continue;
        uncat.push(line.trim().slice(0, 80));
      }
      if (!uncat.length) return null;
      return {
        detail: `${uncat.length} bullet(s) without [category] prefix or relation form`,
        message: `${uncat.length} body bullet(s) lack [fact]/[hypothesis]/etc. category prefix AND aren't relations. ` +
          `Each "- " line must be either a categorized observation ("- [fact] ...") or a relation ("- verb [[slug]]"). ` +
          `Offenders (first 3): ${uncat.slice(0, 3).map((l) => `"${l}"`).join('; ')}`,
        examples: uncat.slice(0, 3),
      };
    },
  },

  {
    name: 'missing-provenance',
    severity: 'high',
    strict: true,
    check: ({ type, body, fm }) => {
      if (!STRICT_PROV_TYPES.has(type)) return null;
      if (!body) return null;
      const obs = parseObservations(body);
      if (obs.length === 0) return null;
      const hasProv = /\^\[[^\]]+\]/.test(body)
        || (fm && fm.raw_path)
        || (fm && Array.isArray(fm.derived_from) && fm.derived_from.length > 0);
      if (hasProv) return null;
      return {
        detail: `${obs.length} observation(s) with no ^[...] marker on page`,
        message: `Page has ${obs.length} observation(s) but no ^[...] provenance marker. ` +
          `Add ^[telegram:YYYY-MM-DD] or ^[raw/<kind>/<slug>.md] in body, or set raw_path / derived_from in frontmatter.`,
      };
    },
  },

  {
    name: 'invented-verb',
    severity: 'high',
    strict: true,
    check: ({ body }, { knownVerbs }) => {
      if (!body) return null;
      const invented = new Set();
      for (const r of parseRelations(body)) {
        if (!knownVerbs.has(r.verb)) invented.add(r.verb);
      }
      if (!invented.size) return null;
      const list = [...invented];
      return {
        detail: `verb(s) not in SCHEMA registries: ${list.join(', ')}`,
        message: `Relation verb(s) not in SCHEMA registries: ${list.join(', ')}. ` +
          `Use a verb from symmetric, inverse-pairs, or one-way allowlist. Edit SCHEMA.md to add new verbs.`,
      };
    },
  },

  {
    name: 'long-observation',
    severity: 'low',
    strict: false,
    check: ({ body }) => {
      if (!body) return null;
      const long = [];
      for (const o of parseObservations(body)) {
        if (o.body.length > 120) long.push(o.body.slice(0, 60) + '…');
      }
      if (!long.length) return null;
      return {
        detail: `${long.length} observation(s) >120 chars of body (multi-fact suspect)`,
        message: `${long.length} observation(s) >120 chars (multi-fact suspect; consider splitting)`,
      };
    },
  },

  {
    name: 'empty-page',
    severity: 'medium',
    strict: false,
    check: ({ type, body }) => {
      if (!SUBSTANTIVE_TYPES.has(type)) return null;
      if (!body) return { detail: `no body; type=${type} expected to have at least one [fact] or typed relation`, message: '' };
      // Stub template (`Stub. ^[source]`) is exempt — intentionally minimal.
      if (/^\s*Stub\.\s*\^\[[^\]]+\]\s*$/.test(body.trim())) return null;
      const obsCount = parseObservations(body).length;
      const relCount = parseRelations(body).length;
      if (obsCount > 0 || relCount > 0) return null;
      return {
        detail: `no observations or relations; type=${type} expected to have at least one [fact] or typed relation`,
        message: `type=${type} page has no observations or relations`,
      };
    },
  },

  {
    name: 'event-when',
    severity: 'high',
    strict: true,
    check: ({ type, fm }) => {
      if (type !== 'event') return null;
      if (fm && fm.when) return null;
      return {
        detail: `type=event but 'when' field missing`,
        message: `type=event requires --when YYYY-MM-DD (or ISO8601 for timed events)`,
      };
    },
  },

  {
    name: 'event-tag',
    severity: 'medium',
    strict: true,
    check: ({ type, tags }) => {
      if (type !== 'event') return null;
      if (Array.isArray(tags) && tags.includes('event')) return null;
      return {
        detail: `type=event but 'event' tag missing`,
        message: `type=event requires tag "event" in --tags`,
      };
    },
  },
];

// Run ALL rules against a page. Returns { score, issues } where score is the
// severity-weighted sum (high=3, medium=2, low=1).
function auditPage(input, deps) {
  const issues = [];
  for (const rule of AUDIT_RULES) {
    const out = rule.check(input, deps);
    if (!out) continue;
    const issue = { rule: rule.name, severity: rule.severity, detail: out.detail };
    if (out.examples) issue.examples = out.examples;
    issues.push(issue);
  }
  const score = issues.reduce((acc, i) => acc + severityScore(i.severity), 0);
  return { score, issues };
}

// Run only `strict: true` rules; emit validateBody-shape records.
function strictRuleErrors(input, deps) {
  const errors = [];
  for (const rule of AUDIT_RULES) {
    if (!rule.strict) continue;
    const out = rule.check(input, deps);
    if (!out) continue;
    errors.push({ rule: rule.name, message: out.message || out.detail });
  }
  return errors;
}

function severityScore(s) {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

module.exports = {
  AUDIT_RULES,
  auditPage,
  strictRuleErrors,
  severityScore,
};
