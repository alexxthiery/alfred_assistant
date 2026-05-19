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
const { parseRelations, parseObservations, extractWikilinks, aliasesOf } = require('./graph.js');
const { detectSecrets } = require('./secrets.js');

// HR-OOB-C: lowercase + hyphenate to produce the slug a string would resolve
// to (mirrors bin/wiki slug conventions: lowercase, whitespace→hyphen,
// otherwise unchanged because aliases are already simple).
function slugifyValue(v) {
  return String(v).trim().toLowerCase().replace(/\s+/g, '-');
}

// HR-OOB-C: case-insensitive equality used for alias/title comparisons.
function ciEq(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// HR-OOB-C: normalize a fact body for duplicate detection.
// Strips category prefix, provenance markers, collapses whitespace, lowercases.
function normalizeFactLine(line) {
  let s = String(line).trim();
  s = s.replace(/^- (?:~~)?\[fact\]\s*/i, '');
  s = s.replace(/\^\[[^\]]+\]/g, '');
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();
  return s;
}

const STRICT_PROV_TYPES = new Set(['entity', 'event', 'concept', 'synthesis']);
// SUBSTANTIVE_TYPES drives the `empty-page` rule: pages of these types are
// expected to carry at least one observation or relation.
// `question` is included because an empty question page is just a title with
// no thinking — the whole point of the type is to accrete hypotheses /
// evidence over time. But `question` is intentionally NOT in
// STRICT_PROV_TYPES: a fresh `[hypothesis]` on a question page may
// legitimately have no provenance yet (it's a candidate answer awaiting
// evidence).
const SUBSTANTIVE_TYPES = new Set(['entity', 'event', 'concept', 'question']);

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
    // Two non-superseded observation lines on the same page that share both
    // category and cleaned-body are byte-equal duplicates. Refuses at write
    // time; `--force-duplicate` bypasses for the rare legitimate case
    // (intentional parallel statements with distinct provenance).
    //
    // Canonical form = parseObservations(body) cleaned body, lowercased.
    // Inline date/provenance/confidence tags are already stripped by the
    // parser so the comparison is robust against trivial decoration drift.
    // Strikethrough-wrapped obs are skipped: the supersession workflow lands
    // an old line and a new identical line on the same page on purpose.
    name: 'exact-duplicate-observation',
    severity: 'high',
    strict: true,
    check: ({ body }) => {
      if (!body) return null;
      const obs = parseObservations(body);
      const seen = new Map();
      for (const o of obs) {
        if (o.superseded) continue;
        const key = `${o.category}|${o.body.toLowerCase()}`;
        if (seen.has(key)) {
          const dup = o.body.slice(0, 80);
          return {
            detail: `duplicate [${o.category}] observation: "${dup}"`,
            message: `duplicate observation on this page: [${o.category}] "${dup}". ` +
              `Two byte-equal observations carry the same epistemic weight as one. ` +
              `If this is an intentional re-statement (different provenance), bypass with --force-duplicate. ` +
              `If you meant to revise the earlier one, use \`wiki patch <slug> --supersede "<old needle>" --observation "<new>"\`.`,
            fix: `wiki patch <slug> --force-duplicate ...   (or --supersede + --observation if updating)`,
          };
        }
        seen.set(key, o);
      }
      return null;
    },
  },

  {
    // `[fact]` lines that read as speculation or future-tense almost certainly
    // belong in `[hypothesis]` or `[prediction]`. Surfacing them helps the
    // user (and Alfred during ingest) maintain epistemic discipline: the
    // schema distinguishes assertion from speculation, but only if writers
    // route lines to the right category. Advisory-only — false positives
    // ("Will Smith is an actor") are acceptable at low severity.
    //
    // Two heuristic banks:
    //   future-tense → [prediction]   ("will", "going to", "expects to", ...)
    //   epistemic-uncertainty → [hypothesis]  ("might", "i think", "likely", ...)
    // We inspect parseObservations' cleaned body so inline date/confidence/
    // provenance tags don't trigger false positives.
    name: 'speculative-shape-fact',
    severity: 'low',
    strict: false,
    check: ({ body }) => {
      if (!body) return null;
      const obs = parseObservations(body);
      const FUTURE = /\b(will|going to|plans to|aims to|expects? to|hopes to|is set to)\b/i;
      const EPISTEMIC = /\b(might|may|could|i\s+(?:think|believe|guess|suspect|expect)|seems?\s+(?:to|like)|probably|likely|apparently)\b/i;
      const offenders = [];
      for (const o of obs) {
        if (o.category !== 'fact') continue;
        const fm = o.body.match(FUTURE);
        const em = o.body.match(EPISTEMIC);
        if (!fm && !em) continue;
        const target = fm ? 'prediction' : 'hypothesis';
        const trigger = (fm || em)[0].toLowerCase();
        offenders.push({ trigger, target, body: o.body.slice(0, 80) });
      }
      if (!offenders.length) return null;
      const ex = offenders[0];
      return {
        detail: `${offenders.length} [fact] line(s) read as speculation; first trigger "${ex.trigger}" → suggest [${ex.target}]`,
        message: `${offenders.length} [fact] observation(s) carry speculative or future-tense shape ` +
          `(triggers like "${ex.trigger}"). Consider converting to [hypothesis] or [prediction]. ` +
          `Fix: \`wiki patch <slug> --supersede "<old-needle>" --observation "..."\` or use the ` +
          `\`wiki predict\` / \`wiki hypothesize\` verbs.`,
        examples: offenders.slice(0, 3).map((o) => `[${o.target}?] ${o.body}`),
      };
    },
  },

  {
    // `type: view` pages are saved DuckDB queries: the body's first fenced
    // ```sql block is what `wiki render` executes. A view without a query has
    // no useful behaviour, so flag it. Advisory (not strict): the page is
    // still allowed to land — the audit surfaces the gap.
    name: 'view-needs-query',
    severity: 'medium',
    strict: false,
    check: ({ type, body }) => {
      if (type !== 'view') return null;
      if (!body) return { detail: 'type=view page has empty body — no SQL to run.', message: 'type=view page has empty body. Add a ```sql fenced block; `wiki render` will execute the first one.' };
      if (/```\s*sql\b/i.test(body)) return null;
      return {
        detail: 'type=view page has no ```sql fenced block.',
        message: 'type=view page has no ```sql fenced block. Add one; `wiki render <slug>` will execute it.',
      };
    },
  },

  {
    // Ironclad: --soft cannot bypass this. Closed-set category vocabulary is
    // schema-syntax, not a discretionary quality nag. Without ironclad, a
    // user writing `wiki patch <slug> --observation "[issue] ..." --soft`
    // would silently land an unparseable observation line — this happened
    // in `_AI_box` before this rule was tightened. See audit findings.
    name: 'uncategorized-bullets',
    severity: 'medium',
    strict: true,
    ironclad: true,
    check: ({ body }) => {
      if (!body) return null;
      const uncat = [];
      for (const line of body.split('\n')) {
        if (!/^- /.test(line)) continue;
        if (/^- (?:~~)?\[(?:fact|hypothesis|opinion|claim|quote|question|decision|todo|idea|prediction)\]/.test(line)) continue;
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
    // Ironclad: --soft cannot bypass this. Relation-verb vocabulary is closed
    // (schema-defined symmetric / one-way / inverse-pair sets). A `--soft`
    // bypass would let `- inventedverb [[slug]]` land, which then renders as a
    // typed edge that isn't actually typed.
    name: 'invented-verb',
    severity: 'high',
    strict: true,
    ironclad: true,
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

  {
    name: 'contains-secret',
    severity: 'high',
    strict: true,
    // Detect high-confidence secret shapes in body (passwords, API tokens,
    // bank accounts, JWTs, etc.). The vault is auto-committed to git on
    // every write, so a leaked secret here lives in git history forever.
    // Strict refusal at write time is the only durable defense; the
    // --allow-secret escape hatch is for the rare legitimate case.
    check: ({ body }) => {
      if (!body) return null;
      const hits = detectSecrets(body);
      if (!hits.length) return null;
      const names = [...new Set(hits.map((h) => h.name))];
      return {
        detail: `body contains secret-shape value(s): ${names.join(', ')}`,
        message: `Body contains likely-secret value(s): ${names.join(', ')}. ` +
          `Pages are committed to git on every write — secrets here are permanent. ` +
          `Restructure as a reference (e.g. "key stored in 1Password under 'X'") ` +
          `or pass --allow-secret if you've audited the content and accept the risk.`,
        fix: `restructure the body to reference a secret store instead of inlining the value`,
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

// Run only `ironclad: true` rules. Used by cmdWrite + cmdPatch to enforce
// schema-syntax violations (unknown categories, unknown verbs) BEFORE the
// `--soft` short-circuit. `--soft` bypasses everyday strict rules
// (missing-provenance, mislabeled-event, etc.) but not these — the vocabulary
// is closed-set and a `--soft` bypass would produce unparseable artefacts.
function ironcladRuleErrors(input, deps) {
  const errors = [];
  for (const rule of AUDIT_RULES) {
    if (!rule.ironclad) continue;
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
const STRICT_CROSS_PAGE_RULES = [
  {
    name: 'non-functional-alias',
    severity: 'high',
    strict: true,
    // Refuse a write that declares `aliases: [X]` while X.md exists as a
    // separate page. The alias is functionally inert because [[X]] resolves
    // to X.md (exact-slug match wins over alias lookup). The nickname-
    // duplicate class of bug — adding an alias for a value that's already
    // a standalone page would leave both pages alive in the vault.
    check: ({ thisPage, allPages }) => {
      const aliases = aliasesOf(thisPage.fm);
      if (!aliases.length) return null;
      const slugSet = new Set(allPages.map((p) => p.slug));
      for (const v of aliases) {
        const target = slugifyValue(v);
        if (target === thisPage.slug) continue;
        if (!slugSet.has(target)) continue;
        return {
          detail: `aliases includes "${v}" but [[${target}]] exists as a separate page; alias is functionally inert.`,
          message: `aliases on ${thisPage.slug} includes "${v}", but [[${target}]] is a separate page. ` +
            `The alias is inert: [[${v}]] still resolves to ${target}.md, not ${thisPage.slug}.md. ` +
            `Merge the two pages instead.`,
          fix: `wiki merge ${target} ${thisPage.slug} --add-aliases "${v}"`,
        };
      }
      return null;
    },
  },

  {
    name: 'alias-collision',
    severity: 'high',
    strict: true,
    // Refuse if any alias on thisPage matches another page's title or alias
    // (case-insensitively). Covers conflicts where the colliding page's slug
    // differs from the alias value (non-functional-alias handles the slug
    // case; this rule handles the title/alias case).
    check: ({ thisPage, allPages }) => {
      const aliases = aliasesOf(thisPage.fm);
      if (!aliases.length) return null;
      for (const v of aliases) {
        const targetSlug = slugifyValue(v);
        for (const other of allPages) {
          if (other.slug === thisPage.slug) continue;
          if (other.slug === targetSlug) continue; // covered by non-functional-alias
          let kind = null;
          if (other.title && ciEq(other.title, v)) kind = 'title';
          else if (aliasesOf(other.fm).some((a) => ciEq(a, v))) kind = 'alias';
          if (!kind) continue;
          const [smaller, larger] = (thisPage.body || '').length <= (other.body || '').length
            ? [thisPage.slug, other.slug]
            : [other.slug, thisPage.slug];
          return {
            detail: `alias "${v}" already lives as ${kind} on [[${other.slug}]]; one of these is the duplicate.`,
            message: `alias "${v}" on ${thisPage.slug} collides with the ${kind} of [[${other.slug}]]. ` +
              `Two pages cannot claim the same name; merge them.`,
            fix: `wiki merge ${smaller} ${larger}`,
          };
        }
      }
      return null;
    },
  },
];

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

  // HR-OOB-C: duplicate-fact (advisory). For each non-superseded fact line
  // on each page, look for a normalized-equal match on a different page.
  // Threshold ≥ 40 chars (normalized) keeps trivia (years, single words)
  // out of the report. Fix string depends on overlap density.
  const factIndex = new Map(); // normalized → [{slug, raw}]
  for (const p of pages) {
    if (!p.body) continue;
    for (const line of p.body.split('\n')) {
      if (!/^- \[fact\]/i.test(line)) continue; // skip superseded (~~) and non-facts
      const norm = normalizeFactLine(line);
      if (norm.length < 40) continue;
      if (!factIndex.has(norm)) factIndex.set(norm, []);
      factIndex.get(norm).push({ slug: p.slug, raw: line.trim() });
    }
  }
  const overlapBetween = new Map(); // "a||b" (sorted) → count
  const dupesByPage = new Map();    // slug → [{otherSlug, snippet}]
  for (const [norm, hits] of factIndex.entries()) {
    if (hits.length < 2) continue;
    const slugs = [...new Set(hits.map((h) => h.slug))];
    if (slugs.length < 2) continue; // duplicates within same page are unrelated
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const key = [slugs[i], slugs[j]].sort().join('||');
        overlapBetween.set(key, (overlapBetween.get(key) || 0) + 1);
      }
    }
    const snippet = norm.slice(0, 60) + (norm.length > 60 ? '…' : '');
    for (const slug of slugs) {
      for (const other of slugs) {
        if (other === slug) continue;
        if (!dupesByPage.has(slug)) dupesByPage.set(slug, []);
        dupesByPage.get(slug).push({ otherSlug: other, snippet });
      }
    }
  }
  for (const r of perPage) {
    const dupes = dupesByPage.get(r.slug);
    if (!dupes || !dupes.length) continue;
    // De-duplicate by (otherSlug, snippet) so the same fact pair isn't
    // listed twice when more than 2 pages share it.
    const seen = new Set();
    const unique = [];
    for (const d of dupes) {
      const k = `${d.otherSlug}||${d.snippet}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(d);
    }
    // Fix: when ≥3 facts shared with one specific other page, suggest merge
    // (pick smaller-body slug to absorb into larger); else per-fact supersede.
    const byOther = new Map();
    for (const d of unique) byOther.set(d.otherSlug, (byOther.get(d.otherSlug) || 0) + 1);
    let fix;
    let densest = null;
    for (const [other, count] of byOther.entries()) {
      if (!densest || count > densest.count) densest = { other, count };
    }
    if (densest && densest.count >= 3) {
      const a = pageBySlug.get(r.slug);
      const b = pageBySlug.get(densest.other);
      const [smaller, larger] = ((a && a.body) || '').length <= ((b && b.body) || '').length
        ? [r.slug, densest.other]
        : [densest.other, r.slug];
      fix = `wiki merge ${smaller} ${larger}`;
    } else {
      fix = `wiki patch ${r.slug} --supersede "${unique[0].snippet.replace(/"/g, '\\"')}"`;
    }
    const otherList = [...byOther.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `[[${s}]] (${c})`)
      .join(', ');
    r.issues.push({
      rule: 'duplicate-fact',
      severity: 'medium',
      detail: `${unique.length} fact(s) duplicated on: ${otherList}`,
      fix,
    });
    r.score += 2;
  }

  return { perPage, hotMentions };
}

module.exports = {
  AUDIT_RULES,
  STRICT_CROSS_PAGE_RULES,
  auditPage,
  auditVault,
  strictRuleErrors,
  ironcladRuleErrors,
  strictCrossPageErrors,
  severityScore,
};
