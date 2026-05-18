// audit.js — shared per-page audit rule table.
//
// Single source of truth for the per-page rules that both:
//   - `wiki audit` runs at audit-time (all rules, severity-weighted scoring)
//   - `wiki write` runs at write-time (the `strict: true` subset, blocks writes)
//
// Each entry: { name, severity, strict, check(input, deps) }.
//   input: { slug, title, type, tags, body, fm }
//   deps:  { schema, knownVerbs }
//   check: returns null (clean) or { detail, message?, examples?, fix? }
//     detail  → used by audit-shape output
//     message → used by validateBody-shape output (with extra guidance)
//     fix     → HR-OOB-A: a concrete verb invocation the agent or human can
//               run verbatim to resolve the finding. Surfaced by callers
//               (postWriteAudit, auditAll, strict-rejection printer) as a
//               `→ fix: <command>` line right under the finding. Rule
//               authors should produce this string with all slug/value
//               substitutions already filled in.
//
// auditPage runs all rules; strictRuleErrors runs only `strict: true` rules.
//
// HR-OOB-B: cross-page strict rules live in a separate table,
// STRICT_CROSS_PAGE_RULES. They differ from AUDIT_RULES in signature:
//   check({thisPage, allPages}, deps) -> null | {detail, message?, fix?}
// and are only invoked when validateBody is called with `allPages` in deps.
// Surfaced through strictCrossPageErrors() in the same {rule, message, fix?}
// shape as strictRuleErrors() so the strict-rejection printer can treat them
// uniformly.

'use strict';

const { ENTITY_KIND_TAGS } = require('./schema.js');
const { parseRelations, parseObservations, extractWikilinks } = require('./graph.js');

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
// severity-weighted sum (high=3, medium=2, low=1). Each issue may carry
// {fix?} — a concrete suggested verb invocation (HR-OOB-A) that the agent or
// human can run verbatim to resolve the finding. Surfaced by callers in
// bin/wiki (postWriteAudit, auditAll) via `→ fix:` output lines.
function auditPage(input, deps) {
  const issues = [];
  for (const rule of AUDIT_RULES) {
    const out = rule.check(input, deps);
    if (!out) continue;
    const issue = { rule: rule.name, severity: rule.severity, detail: out.detail };
    if (out.examples) issue.examples = out.examples;
    if (out.fix) issue.fix = out.fix;
    issues.push(issue);
  }
  const score = issues.reduce((acc, i) => acc + severityScore(i.severity), 0);
  return { score, issues };
}

// Run only `strict: true` rules; emit validateBody-shape records.
// HR-OOB-A: `fix?` propagated alongside message so the strict-rejection
// printer can emit `→ fix: <command>` lines.
function strictRuleErrors(input, deps) {
  const errors = [];
  for (const rule of AUDIT_RULES) {
    if (!rule.strict) continue;
    const out = rule.check(input, deps);
    if (!out) continue;
    const error = { rule: rule.name, message: out.message || out.detail };
    if (out.fix) error.fix = out.fix;
    errors.push(error);
  }
  return errors;
}

function severityScore(s) {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

// HR-OOB-B: cross-page strict rules. Each entry:
//   {name, severity, strict: true, check({thisPage, allPages}, deps)}
//     thisPage: {slug, title, type, tags, body, fm}
//     allPages: Array<{slug, title, type, tags, fm, body}>  (snapshot from vault)
//     deps:     {schema, knownVerbs}
//     check returns null (clean) or {detail, message?, fix?}
// HR-OOB-C populates this table; the pipeline is wired empty so validateBody
// can already plumb allPages through harmlessly.
const STRICT_CROSS_PAGE_RULES = [];

function strictCrossPageErrors(thisPage, deps) {
  if (!deps || !deps.allPages) return [];
  const errors = [];
  for (const rule of STRICT_CROSS_PAGE_RULES) {
    const out = rule.check({ thisPage, allPages: deps.allPages }, deps);
    if (!out) continue;
    const error = { rule: rule.name, message: out.message || out.detail };
    if (out.fix) error.fix = out.fix;
    errors.push(error);
  }
  return errors;
}

// HR05: vault-wide audit. Runs per-page (auditPage) plus the two cross-page
// rules (hot-text-mention, lonely) that need a vault-wide view. Pure: takes
// a pre-built `pages` snapshot + deps; returns the same shape as before
// extraction ({perPage, hotMentions}).
//
// Pages shape: Array<{slug, title, type, tags, fm, body}>.
// Deps: { schema, knownVerbs }.
//
// Why a snapshot? Both cross-page rules need to walk every page's body once;
// keeping the walk caller-side means cmdIngest/cmdAudit can fold this walk
// with other passes (see HR23).
function auditVault({ pages, schema, knownVerbs }) {
  const perPage = pages.map((p) => ({
    slug: p.slug,
    ...auditPage(
      { slug: p.slug, title: p.title, type: p.type, tags: p.tags, body: p.body, fm: p.fm },
      { schema, knownVerbs },
    ),
  }));

  // hot-text-mention: capitalized 2+ word phrases in prose, appearing across
  // 2+ pages, with no canonical stub.
  const HOT_RE = /\b((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}))\b/g;
  const STOPWORDS = new Set(['New York', 'Hong Kong', 'San Francisco']);
  const slugSet = new Set(pages.map((p) => p.slug));
  const phraseCounts = new Map();

  // lonely: inbound + outbound wikilink count < 2.
  const wikilinkInbound = {};
  const wikilinkOutbound = {};

  for (const p of pages) {
    const stripped = p.body.replace(/\[\[[^\]]+\]\]/g, '');
    let m;
    HOT_RE.lastIndex = 0;
    while ((m = HOT_RE.exec(stripped)) !== null) {
      const phrase = m[1].trim();
      if (phrase.length < 6) continue;
      if (STOPWORDS.has(phrase)) continue;
      const slugified = phrase.toLowerCase().replace(/\s+/g, '-');
      if (slugSet.has(slugified)) continue;
      if (!phraseCounts.has(phrase)) phraseCounts.set(phrase, new Set());
      phraseCounts.get(phrase).add(p.slug);
    }
    const out = new Set(extractWikilinks(p.body));
    wikilinkOutbound[p.slug] = out.size;
    for (const t of out) {
      wikilinkInbound[t] = (wikilinkInbound[t] || 0) + 1;
    }
  }

  const hotMentions = [];
  for (const [phrase, slugs] of phraseCounts.entries()) {
    if (slugs.size >= 2) hotMentions.push({ phrase, count: slugs.size, pages: [...slugs] });
  }
  hotMentions.sort((a, b) => b.count - a.count);

  const pageBySlug = new Map(pages.map((p) => [p.slug, p]));
  for (const r of perPage) {
    const inLinks = wikilinkInbound[r.slug] || 0;
    const outLinks = wikilinkOutbound[r.slug] || 0;
    const total = inLinks + outLinks;
    const type = pageBySlug.get(r.slug).type;
    if (total < 2 && type !== 'todo' && type !== 'source') {
      r.issues.push({ rule: 'lonely', severity: 'low', detail: `${total} graph connection(s); orphan-risk` });
      r.score += 1;
    }
  }

  return { perPage, hotMentions };
}

module.exports = {
  AUDIT_RULES,
  STRICT_CROSS_PAGE_RULES,
  auditPage,
  auditVault,
  strictRuleErrors,
  strictCrossPageErrors,
  severityScore,
};
