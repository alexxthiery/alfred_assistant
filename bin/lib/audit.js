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
const { parseRelations, parseObservations, extractWikilinks, aliasesOf, stripSupersededObservationLines } = require('./graph.js');
const { detectSecrets } = require('./secrets.js');
const { FUTURE_TENSE_RE, EPISTEMIC_RE } = require('./capture-classifier.js');
const { isISODate, isISO8601DateTime } = require('./date.js');

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

// Shell-expanded currency artifacts: Bash turns "$400M" inside double quotes
// into "00M" (positional parameter $4 + literal "00M"), and "~$400M" into
// "~00M". Catch the corrupted token on write so bad shell quoting cannot land
// silently in the vault.
function findShellExpandedCurrencyArtifact(text) {
  const s = String(text || '');
  const patterns = [
    /(^|[^0-9A-Za-z$])(~(?:0{0,2})[KMBT])\b/g,   // ~M, ~0M, ~00M
    /(^|[^0-9A-Za-z$])(0{1,2}[KMBT])\b/g,        // 0M, 00M
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(s)) !== null) {
      const token = m[2];
      if (!token) continue;
      return token;
    }
  }
  return null;
}

const CONCEPT_FACT_ROLE_LABEL_RE = /^\[(?:connection|extension|instance|mechanism|refinement|resolution|tension)\]\s+/i;

function firstSpeculativeMatch(text, re, options = {}) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const global = new RegExp(re.source, flags);
  for (const m of String(text || '').matchAll(global)) {
    const token = m[0] || '';
    if (options.skipCapitalizedMonthMay && token === 'May') continue;
    return m;
  }
  return null;
}

function transientInboxProvenancePaths({ body, fm }) {
  const hits = new Set();
  const text = String(body || '');
  const markerRe = /\^\[(inbox\/[^\]]+)\]/g;
  let m;
  while ((m = markerRe.exec(text)) !== null) hits.add(m[1]);

  for (const key of ['raw_path', 'source_path']) {
    const value = fm && fm[key];
    if (typeof value === 'string' && value.startsWith('inbox/')) hits.add(value);
  }

  return [...hits].sort();
}

const STRICT_PROV_TYPES = new Set(['entity', 'event', 'concept', 'synthesis']);
// Some schema event keywords are intentionally broad. On todos, words like
// "review" and "holiday" often describe the action target rather than a
// scheduled event ("finish the review", "submit holiday request"). Keep the
// todo guard for unambiguous event words like meeting/appointment.
const TODO_EVENT_KEYWORD_EXEMPTIONS = new Set(['holiday', 'review']);
// SUBSTANTIVE_TYPES drives the `empty-page` rule: pages of these types are
// expected to carry at least one observation or relation.
// `question` is included because an empty question page is just a title with
// no thinking — the whole point of the type is to accrete hypotheses /
// evidence over time. But `question` is intentionally NOT in
// STRICT_PROV_TYPES: a fresh `[hypothesis]` on a question page may
// legitimately have no provenance yet (it's a candidate answer awaiting
// evidence).
const SUBSTANTIVE_TYPES = new Set(['entity', 'event', 'concept', 'question']);

// Tags that mark a concept page as a distilled idea / opinion / principle —
// the reformulated higher-level cards that must record which work they came
// from (intellectual attribution, distinct from the ^[...] capture-provenance
// enforced by `missing-provenance`). Drives the `unattributed-idea` strict
// gate and the `idea-attribution-pending` backlog rule.
const IDEA_TAGS = new Set(['idea', 'opinion', 'principle']);
const ORIGIN_CONTROL_WORDS = new Set(['original', 'unattributed']);

// Provenance-marker prefixes that are pure capture / internal-synthesis, i.e.
// they record WHERE a fact was captured, not WHICH external work it names.
// Any other `^[...]` marker (arxiv:, doi:, web:, http, an author-year slug like
// `frazzini-pedersen-2014`, ...) is treated as naming the originating work and
// therefore counts as intellectual attribution for the unattributed-idea gate.
const CAPTURE_MARKER_PREFIXES = /^(raw|telegram|lab|inbox|maintenance|vault-synthesis|conversation|external)\b/i;

// True iff the body carries a provenance marker that names an external work
// (as opposed to a pure-capture marker). One such marker is enough.
function namesExternalWork(body) {
  const marks = [...String(body || '').matchAll(/\^\[([^\]]+)\]/g)].map((m) => m[1]);
  return marks.some((m) => !CAPTURE_MARKER_PREFIXES.test(m));
}

// Normalize the tag list from either the top-level `tags` input (array, as
// write.js passes it) or `fm.tags` (array on disk, comma-string from raw args).
// Rules that key off tags must tolerate both call paths.
function tagListOf(tags, fm) {
  if (Array.isArray(tags)) return tags;
  if (fm && Array.isArray(fm.tags)) return fm.tags;
  if (fm && typeof fm.tags === 'string') return fm.tags.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function ideaAttributionSubject(page) {
  if (!page || page.type !== 'concept') return null;
  const tagList = tagListOf(page.tags, page.fm);
  const ideaTags = tagList.filter((t) => IDEA_TAGS.has(t));
  if (ideaTags.length === 0) return null;
  const body = page.body || '';
  const obs = parseObservations(body);
  if (obs.length === 0) return null;
  return { ideaTags, obs, body, fm: page.fm || {} };
}

function sourceReferenceMetadataProblem(page) {
  if (!page || page.type !== 'source') return null;
  const fm = page.fm || {};
  const hasReferenceLocator = ['url', 'doi', 'arxiv'].some((k) => typeof fm[k] === 'string' && fm[k].trim());
  if (!hasReferenceLocator) return null;

  const author = fm.author;
  const hasAuthor = Array.isArray(author)
    ? author.some((a) => typeof a === 'string' && a.trim())
    : (typeof author === 'string' && author.trim());
  const year = fm.year;
  const hasYear = (typeof year === 'number' && year >= 100 && year <= 9999)
    || (typeof year === 'string' && /^\d{3,4}$/.test(year.trim()));

  const missing = [];
  if (!hasAuthor) missing.push('author');
  if (!hasYear) missing.push('year');
  if (!missing.length) return null;

  const slug = page.slug || fm.id || '<source-slug>';
  return {
    missing,
    detail: `reference source missing structured metadata: missing ${missing.join(', ')}`,
    message: `Source page ${slug} has a bibliographic locator (url/doi/arxiv) but lacks structured ${missing.join(' and ')} metadata. ` +
      `Do not bury source identity only in prose observations; Alfred needs frontmatter to audit and retrieve provenance.`,
    fix: `wiki patch ${slug} --author "<author>" --year <year>`,
  };
}

function sourceAttributionProblem(thisPage, allPages) {
  const subject = ideaAttributionSubject(thisPage);
  if (!subject) return null;

  const bySlug = new Map((allPages || []).map((p) => [p.slug, p]));
  if (!bySlug.has(thisPage.slug)) bySlug.set(thisPage.slug, thisPage);
  const origin = typeof subject.fm.origin === 'string' ? subject.fm.origin.trim() : '';

  if (origin && !ORIGIN_CONTROL_WORDS.has(origin)) {
    const target = bySlug.get(origin);
    if (!target) {
      return {
        detail: `origin [[${origin}]] does not exist; origin must point to a type=source page`,
        message: `Idea page ${thisPage.slug} sets origin: ${origin}, but [[${origin}]] does not exist. ` +
          `Create a type=source page for the work, set --origin original if this is genuinely your own thought, or set --origin unattributed if the source is unknown.`,
        fix: `wiki write ${origin} --type source --kind <kind> --title "<source title>" --url <url>`,
      };
    }
    if (target.type !== 'source') {
      return {
        detail: `origin [[${origin}]] is type=${target.type || 'note'}, not type=source`,
        message: `Idea page ${thisPage.slug} sets origin: ${origin}, but [[${origin}]] is type=${target.type || 'note'}. ` +
          `origin must be a type=source page, or the control word original/unattributed.`,
        fix: `wiki patch ${thisPage.slug} --origin <source-slug>`,
      };
    }
    return null;
  }

  if (origin || (subject.fm && Array.isArray(subject.fm.derived_from) && subject.fm.derived_from.length > 0) || namesExternalWork(subject.body)) {
    return null;
  }

  const cites = parseRelations(subject.body).filter((r) => r.verb === 'cites');
  if (cites.length === 0) return null; // per-page unattributed-idea owns this case.
  if (cites.some((r) => (bySlug.get(r.target) || {}).type === 'source')) return null;

  const described = cites
    .slice(0, 4)
    .map((r) => {
      const target = bySlug.get(r.target);
      return `[[${r.target}]] is ${target ? `type=${target.type || 'note'}` : 'missing'}`;
    })
    .join('; ');
  return {
    detail: `cites relation(s) do not point to a source page: ${described}`,
    message: `Idea page ${thisPage.slug} uses cites relation(s), but none point to a type=source page (${described}). ` +
      `Concept-to-concept cites can express related ideas, but they do not identify the work this idea came from. ` +
      `Create/cite a source page, set --origin <source-slug>, set --origin original, or set --origin unattributed if unknown.`,
    fix: `wiki patch ${thisPage.slug} --origin <source-slug>`,
  };
}

// Observation count at which a page is flagged as bloated. A high count of
// active categorized observations on one page is structural drift away from
// atomic-concept-per-page: the card has become a log of disparate sub-topics
// that should each live on their own page. Surfaced via the `bloated-card`
// audit rule (which fires in every post-write summary), the `wiki review`
// section, and the rubric's append-time check in `persona/pipeline.md`.
const OBSERVATION_BLOAT_THRESHOLD = 20;

const AUDIT_RULES = [
  {
    // Shell quoting footgun: `wiki patch --observation "... ~$400M ..."` run
    // through Bash expands `$4` before the CLI sees it, yielding `~00M`.
    // This is data corruption, not a style issue, so treat it as ironclad.
    name: 'shell-expanded-currency-artifact',
    severity: 'high',
    strict: true,
    ironclad: true,
    check: ({ body }) => {
      if (!body) return null;
      const token = findShellExpandedCurrencyArtifact(body);
      if (!token) return null;
      return {
        detail: `suspicious zero-only magnitude token "${token}" (shell-expanded currency artifact)`,
        message: `Found suspicious token "${token}". This often comes from passing a literal dollar amount through Bash double quotes, e.g. "$400M" -> "00M" or "~$400M" -> "~00M". Escape literal dollars as \\$400M, single-quote the observation/content text, or use a single-quoted heredoc before retrying.`,
      };
    },
  },

  {
    name: 'mislabeled-event',
    severity: 'high',
    strict: true,
    check: ({ title, type }, { schema }) => {
      // C1: idea-card types are NEVER events — exempt them. "visit count",
      // "literature review", "policy launch" are domain terms on concept/
      // synthesis pages, not mislabeled events. This also makes `wiki ingest`
      // and `wiki write` agree (neither flags a concept), removing the
      // ingest-lenient / write-strict inconsistency. The rule still fires on
      // note / entity / untyped titles, where an event keyword is a real smell.
      if (type === 'event' || type === 'concept' || type === 'synthesis' || !title) return null;
      if (!schema || !schema.eventKeywords || !schema.eventKeywords.size) return null;
      const titleLower = String(title).toLowerCase();
      const hits = [];
      for (const kw of schema.eventKeywords) {
        const re = new RegExp(`\\b${kw}\\b`, 'i');
        if (re.test(titleLower)) hits.push(kw);
      }
      if (type === 'todo') {
        for (let i = hits.length - 1; i >= 0; i--) {
          if (TODO_EVENT_KEYWORD_EXEMPTIONS.has(hits[i])) hits.splice(i, 1);
        }
      }
      if (!hits.length) return null;
      return {
        detail: `title contains: ${hits.join(', ')} but type=${type}`,
        message: `Title "${title}" contains event keyword(s) (${hits.join(', ')}) but type=${type}. Use --type event. (Override with --soft if intentional.)`,
      };
    },
  },

  {
    name: 'sectioned-idea-page',
    severity: 'high',
    strict: true,
    // Forces atomic decomposition of IDEA cards. An idea card (`type: concept`)
    // is ONE self-contained idea: a flat list of categorized observations +
    // relations. Markdown `##` sub-headers mean it bundles several ideas (the
    // fat-page / source-anchored anti-pattern, e.g. a "Topic" page with Static /
    // Dynamic / ... sections). A deliberate multi-section overview is
    // `type: synthesis`, which is exempt. Only `concept` is targeted; person/org
    // entities have their own (sectioned) conventions and are out of scope.
    check: ({ type, body, fm }) => {
      if (type !== 'concept') return null;
      if (!body || !/^\s{0,3}#{2,}\s+\S/m.test(body)) return null;
      return {
        detail: `concept page has '##' sub-headers (article-shaped — bundles multiple ideas)`,
        message: `This concept page is article-shaped (## sub-headers): it bundles multiple ideas into one page. Decompose it into atomic instance cards via \`wiki ingest\` — one concept per card, each self-contained (use the fivo-* / sixo-* / actsmc cards as the template). If it is a deliberate cross-cutting overview, use --type synthesis instead. (Override with --soft only if you are certain.)`,
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
    check: ({ type, body }) => {
      if (!body) return null;
      const obs = parseObservations(body);
      // Lexicon shared with bin/lib/capture-classifier.js — single source of
      // truth across detection (this audit rule) and routing (wiki capture).
      const FUTURE = FUTURE_TENSE_RE;
      const EPISTEMIC = EPISTEMIC_RE;
      const offenders = [];
      for (const o of obs) {
        if (o.category !== 'fact') continue;
        if (o.superseded) continue;
        const fm = firstSpeculativeMatch(o.body, FUTURE);
        let em = firstSpeculativeMatch(o.body, EPISTEMIC, { skipCapitalizedMonthMay: true });
        if (type === 'concept' && CONCEPT_FACT_ROLE_LABEL_RE.test(o.body)) em = null;
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
    check: ({ type, body, fm }) => {
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
    // Bibliographic source pages must expose source identity in structured
    // frontmatter, not only as prose in the body. This keeps downstream
    // concept cards auditable: Alfred can tell who/what a source is without
    // re-reading or re-scraping the page. Advisory, not strict — old/source-
    // poor pages are backfill work, and unknown metadata should be surfaced
    // rather than fabricated.
    name: 'source-reference-metadata',
    severity: 'medium',
    strict: false,
    check: (page) => sourceReferenceMetadataProblem(page),
  },

  {
    // Ironclad: --soft cannot bypass this. Closed-set category vocabulary is
    // schema-syntax, not a discretionary quality nag. Without ironclad, a
    // user writing `wiki patch <slug> --observation "[issue] ..." --soft`
    // would silently land an unparseable observation line — this happened
    // in a live vault before this rule was tightened. See audit findings.
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
    // `inbox/` is a transient drop zone. Once content is cited from wiki pages,
    // the underlying source must live under raw/ so provenance survives triage,
    // cleanup, and git history. This is strict because accepting inbox paths
    // creates exactly the stale-reference failure mode the inbox pipeline is
    // meant to prevent.
    name: 'transient-inbox-provenance',
    severity: 'high',
    strict: true,
    check: ({ body, fm }) => {
      const hits = transientInboxProvenancePaths({ body, fm });
      if (!hits.length) return null;
      const shown = hits.slice(0, 3).join(', ');
      const suffix = hits.length > 3 ? `, ... (${hits.length} total)` : '';
      return {
        detail: `transient inbox path(s) used as durable provenance: ${shown}${suffix}`,
        message: `inbox/ is transient staging, not durable provenance. ` +
          `Move the source into raw/<kind>/... and cite ^[raw/<kind>/...]. ` +
          `For referenced legacy inbox files, run wiki migrate-inbox-sources --prefix inbox/<dir> --kind <kind>.`,
      };
    },
  },

  {
    // Intellectual attribution for distilled ideas. `missing-provenance`
    // records WHERE a fact was captured (^[raw/...], ^[telegram:...]); this
    // records WHICH WORK an idea came from. An idea/opinion/principle card
    // reformulated from a book/paper/blog must point at its origin so
    // `wiki backlinks <source>` can answer "all ideas from that work".
    //
    // Satisfied (not blocked) when the page has any of:
    //   - fm.origin: a source slug, or the control word `original`
    //     (genuinely the user's own) or `unattributed` (known-external,
    //     backfill queued — see idea-attribution-pending),
    //   - fm.derived_from: the instance/principle trail to an attributed page,
    //   - a `- cites [[...]]` relation: graph-edge attribution (also the
    //     backward-compatible path for the ~300 pages already using cites),
    //   - a provenance marker that NAMES an external work (^[arxiv:...],
    //     ^[doi:...], ^[web:...], ^[author-year], ...). A pure-capture marker
    //     (^[raw/...], ^[telegram:...]) does not count — it records where the
    //     fact was captured, not which work the idea came from.
    //
    // The per-page rule can only see that `cites` exists. The cross-page
    // `idea-source-attribution` rule below verifies that at least one cited
    // target is actually type=source, and that origin slugs resolve to sources.
    name: 'unattributed-idea',
    severity: 'high',
    strict: true,
    check: ({ type, tags, body, fm }) => {
      if (type !== 'concept') return null;
      const tagList = tagListOf(tags, fm);
      const ideaTags = tagList.filter((t) => IDEA_TAGS.has(t));
      if (ideaTags.length === 0) return null;
      if (!body) return null;
      const obs = parseObservations(body);
      if (obs.length === 0) return null;
      const origin = fm && typeof fm.origin === 'string' ? fm.origin.trim() : '';
      const hasOrigin = origin.length > 0;
      const hasDerived = fm && Array.isArray(fm.derived_from) && fm.derived_from.length > 0;
      const hasCites = parseRelations(body).some((r) => r.verb === 'cites');
      const hasWorkMarker = namesExternalWork(body);
      if (hasOrigin || hasDerived || hasCites || hasWorkMarker) return null;
      return {
        detail: `${ideaTags.join('/')} page has ${obs.length} observation(s) but no source attribution`,
        message: `Idea page (tags: ${ideaTags.join(', ')}) has ${obs.length} observation(s) but records no source. ` +
          `Set --origin <source-slug> (the work it came from), --origin original (genuinely your own), ` +
          `or --origin unattributed (known-external, identify later); add a "- cites [[source]]" relation; ` +
          `or cite the work inline via a ^[arxiv:...] / ^[doi:...] provenance marker. ` +
          `Never fabricate an attribution — mark unattributed and ask.`,
        fix: `wiki patch ${fm && fm.id ? fm.id : '<slug>'} --origin unattributed`,
      };
    },
  },

  {
    // Backlog surface for the escape valve above. `origin: unattributed` is a
    // legitimate, non-blocking state (an idea known to be external whose
    // originating work is not yet identified), but it is debt: this medium
    // finding lists such pages so `wiki audit` becomes the backfill worklist.
    name: 'idea-attribution-pending',
    severity: 'medium',
    strict: false,
    check: ({ type, tags, fm }) => {
      if (type !== 'concept') return null;
      const tagList = tagListOf(tags, fm);
      if (!tagList.some((t) => IDEA_TAGS.has(t))) return null;
      const origin = fm && typeof fm.origin === 'string' ? fm.origin.trim() : '';
      if (origin !== 'unattributed') return null;
      return {
        detail: `origin: unattributed — originating work not yet identified`,
        fix: `wiki patch ${fm && fm.id ? fm.id : '<slug>'} --origin <source-slug>`,
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
    name: 'multi-fact-observation',
    severity: 'low',
    strict: false,
    // Targets CRAMMING (several INDEPENDENT facts in one observation), not
    // length or sentence count. This rule is for biographical/event/note debt
    // where multiple addressable facts get buried in one bullet. It deliberately
    // skips concept pages: a dense atomic concept card may need definition,
    // equation, intuition, consequence, and example in one [claim].
    //
    // We also skip superseded observations; strikethrough lines are history, not
    // current cleanup work.
    check: ({ type, body }) => {
      if (!body) return null;
      if (type === 'concept' || type === 'source') return null;
      const CONTINUATION = /^(this|these|those|that|it|its|they|such|therefore|thus|hence|so|because|since|which|where|when|while|as|then|here|also|moreover|furthermore|equivalently|in other words|in particular|for example|e\.g\.|i\.e\.|that is)\b/i;
      const crammed = [];
      for (const o of parseObservations(body)) {
        if (o.superseded) continue;
        const segs = o.body
          .split(/[.;]\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 15);
        if (segs.length < 4) continue; // not even long enough to suspect cramming
        const independent = segs.filter((s, idx) => idx === 0 || !CONTINUATION.test(s));
        if (independent.length >= 4) crammed.push(o.body.slice(0, 60) + '…');
      }
      if (!crammed.length) return null;
      return {
        detail: `${crammed.length} observation(s) pack >=4 independent assertions (multi-fact suspect)`,
        message: `${crammed.length} observation(s) look multi-fact (>=4 independent assertions) — split so each idea is independently addressable. A single long, self-contained idea (sentences that elaborate one point) is fine.`,
      };
    },
  },

  {
    // Flags cards whose accumulated, currently-active categorized observations
    // exceed OBSERVATION_BLOAT_THRESHOLD. The atomicity rule catches the
    // *structural* form of "one big page" (entity-grouping, ##-sectioned
    // concepts), but cards started atomic and silently grew a log of disparate
    // sub-topics need their own signal. Non-scoring and advisory — same posture
    // as multi-fact-observation — because the right fix is a per-cluster
    // promotion ritual (the agent's judgment), not auto-action. Discoverable
    // via three orthogonal surfaces that all point at the same playbook:
    //   1. the post-write audit summary the CLI prints after every write,
    //   2. `wiki audit --all --rule bloated-card` (this rule),
    //   3. the `## Bloated cards` section in `wiki review`.
    name: 'bloated-card',
    severity: 'low',
    strict: false,
    check: ({ body }) => {
      if (!body) return null;
      const obs = parseObservations(body);
      const active = obs.filter((o) => !o.superseded).length;
      if (active < OBSERVATION_BLOAT_THRESHOLD) return null;
      return {
        detail: `${active} active observations on one page (>= ${OBSERVATION_BLOAT_THRESHOLD})`,
        message: `page has ${active} active observations (>= ${OBSERVATION_BLOAT_THRESHOLD}); ` +
          `inspect for sub-topic clusters that should be promoted to their own pages ` +
          `(time-series → \`wiki measure\`, qualitative cluster → \`type: concept\`, ` +
          `events → \`type: event\`, sub-facets of a hub → sub-page with \`part_of\`). ` +
          `See the bloat remediation playbook in \`persona/pipeline.md\`.`,
      };
    },
  },

  {
    name: 'empty-page',
    severity: 'medium',
    strict: true,
    ironclad: true,
    check: ({ type, body, fm }) => {
      if (!SUBSTANTIVE_TYPES.has(type)) return null;
      if (type === 'event' && (!body || !body.trim()) && fm && fm.when) return null;
      if (!body) {
        return {
          detail: `has no body; type=${type} expected to have at least one [fact] or typed relation`,
          message: `type=${type} page has no body; expected at least one [fact] or typed relation`,
        };
      }
      // Stub template (`Stub. ^[source]`) is exempt — intentionally minimal.
      // C2: greedy `.+` (not `[^\]]+`) so a provenance marker containing a
      // wikilink — e.g. `^[gmail:...:[[someone]]-x]` — whose `]]` would
      // otherwise end the bracket class early still matches and stays exempt.
      if (/^\s*Stub\.\s*\^\[.+\]\s*$/.test(body.trim())) return null;
      const obsCount = parseObservations(body).filter((o) => !o.superseded).length;
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
    name: 'todo-status-required',
    severity: 'high',
    strict: true,
    check: ({ type, fm }) => {
      if (type !== 'todo') return null;
      if (fm && fm.status) return null;
      return {
        detail: `type=todo but status missing`,
        message: `type=todo requires status: open|doing|done|abandoned`,
        fix: `wiki todo update <slug> --status open`,
      };
    },
  },

  {
    name: 'todo-status-value',
    severity: 'high',
    strict: true,
    check: ({ type, fm }) => {
      if (type !== 'todo' || !fm || !fm.status) return null;
      const v = String(fm.status);
      if (['open', 'doing', 'done', 'abandoned'].includes(v)) return null;
      return {
        detail: `todo status "${v}" is not open|doing|done|abandoned`,
        message: `todo status must be open|doing|done|abandoned (got "${v}")`,
        fix: `wiki todo update <slug> --status open`,
      };
    },
  },

  {
    name: 'todo-due-date',
    severity: 'high',
    strict: true,
    check: ({ type, fm }) => {
      if (type !== 'todo' || !fm || !fm.due) return null;
      if (isISODate(String(fm.due))) return null;
      return {
        detail: `todo due "${fm.due}" is not YYYY-MM-DD`,
        message: `todo due must be YYYY-MM-DD (got "${fm.due}")`,
        fix: `wiki todo update <slug> --clear-due   # or --due YYYY-MM-DD`,
      };
    },
  },

  {
    name: 'todo-priority-value',
    severity: 'medium',
    strict: true,
    check: ({ type, fm }) => {
      if (type !== 'todo' || !fm || !fm.priority) return null;
      const v = String(fm.priority);
      if (['high', 'med', 'low'].includes(v)) return null;
      return {
        detail: `todo priority "${v}" is not high|med|low`,
        message: `todo priority must be high|med|low (got "${v}")`,
        fix: `wiki todo classify <slug> --clear-priority   # or --priority high|med|low`,
      };
    },
  },

  {
    name: 'todo-reminder-datetime',
    severity: 'high',
    strict: true,
    check: ({ type, fm }) => {
      if (type !== 'todo' || !fm) return null;
      const bad = [];
      if (fm.remind_at && !isISO8601DateTime(String(fm.remind_at))) bad.push(`remind_at=${fm.remind_at}`);
      if (fm.reminded_at && !isISO8601DateTime(String(fm.reminded_at))) bad.push(`reminded_at=${fm.reminded_at}`);
      if (!bad.length) return null;
      return {
        detail: `todo reminder datetime invalid: ${bad.join(', ')}`,
        message: `todo reminder fields must be ISO8601 datetimes: ${bad.join(', ')}`,
        fix: `wiki todo update <slug> --clear-remind   # or --remind_at YYYY-MM-DDTHH:MM+08:00`,
      };
    },
  },

  {
    name: 'todo-date-in-title-without-due',
    severity: 'low',
    strict: false,
    check: ({ title, type, fm }) => {
      if (type !== 'todo' || !title || !fm) return null;
      if ((fm.status || 'open') !== 'open') return null;
      if (fm.due) return null;
      const s = String(title);
      const looksDated =
        /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i.test(s) ||
        /\b\d{4}-\d{2}-\d{2}\b/.test(s) ||
        /\b\d{1,2}\/\d{4}\b/.test(s) ||
        /\bQ[1-4]\s+\d{4}\b/i.test(s);
      if (!looksDated) return null;
      return {
        detail: `open todo title looks date-bearing but has no structured due date`,
        message: `Open todo title appears to contain a date, but frontmatter has no due. Add one with \`wiki todo defer <slug> --to YYYY-MM-DD\` if this is actionable.`,
      };
    },
  },

  {
    name: 'todo-open-untagged',
    severity: 'low',
    strict: false,
    check: ({ type, tags, fm }) => {
      if (type !== 'todo' || !fm) return null;
      if ((fm.status || 'open') !== 'open') return null;
      if (Array.isArray(tags) && tags.length) return null;
      return {
        detail: `open todo has no classification tag`,
        message: `Open todo has no tag. Use \`wiki todo classify <slug> --add-tag <existing-tag>\` so views can slice it.`,
      };
    },
  },

  {
    name: 'todo-done-without-done-at',
    severity: 'low',
    strict: false,
    check: ({ type, fm }) => {
      if (type !== 'todo' || !fm) return null;
      if (fm.status !== 'done') return null;
      if (fm.done_at) return null;
      return {
        detail: `done todo has no done_at timestamp`,
        message: `Done todo has no done_at timestamp. This is legacy data; no action needed unless timeline precision matters.`,
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
    name: 'idea-source-attribution',
    severity: 'high',
    strict: true,
    // Per-page `unattributed-idea` distinguishes capture provenance from
    // intellectual attribution, but it cannot inspect relation targets.
    // This cross-page rule closes that gap: a concept-to-concept `cites` edge
    // is allowed as a semantic relation, but it does not satisfy source
    // attribution. Likewise, `origin: some-slug` must resolve to type=source.
    check: ({ thisPage, allPages }) => sourceAttributionProblem(thisPage, allPages),
  },

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
    error.severity = rule.severity || 'high';
    if (out.detail) error.detail = out.detail;
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

  const pageBySlug = new Map(pages.map((p) => [p.slug, p]));
  for (const r of perPage) {
    const p = pageBySlug.get(r.slug);
    const problem = sourceAttributionProblem(p, pages);
    if (!problem) continue;
    r.issues.push({
      rule: 'idea-source-attribution',
      severity: 'high',
      detail: problem.detail,
      fix: problem.fix,
    });
    r.score += severityScore('high');
  }

  for (const r of perPage) {
    const p = pageBySlug.get(r.slug);
    const subject = ideaAttributionSubject(p);
    if (!subject) continue;
    const targets = new Set();
    const origin = typeof subject.fm.origin === 'string' ? subject.fm.origin.trim() : '';
    if (origin && !ORIGIN_CONTROL_WORDS.has(origin)) targets.add(origin);
    for (const rel of parseRelations(subject.body)) {
      if (rel.verb === 'cites') targets.add(rel.target);
    }
    const weak = [];
    for (const target of targets) {
      const source = pageBySlug.get(target);
      if (!source || source.type !== 'source') continue;
      const problem = sourceReferenceMetadataProblem(source);
      if (problem) weak.push({ target, problem });
    }
    if (!weak.length) continue;
    r.issues.push({
      rule: 'idea-cites-weak-source',
      severity: 'medium',
      detail: `idea cites weakly specified source(s): ${weak.slice(0, 3).map((w) => `[[${w.target}]] (${w.problem.detail})`).join('; ')}`,
      fix: weak[0].problem.fix,
    });
    r.score += severityScore('medium');
  }

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
    const stripped = stripSupersededObservationLines(p.body).replace(/\[\[[^\]]+\]\]/g, '');
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

  // C1: edge-aptness — a NON-SCORING, query-only advisory. A LINEAGE relation
  // (extends / instance_of / depends_on / refines) asserts a strong semantic
  // claim, and a wrong one is a valid wikilink nothing else flags (the
  // relation-level analogue of the silent autolink/alias over-linking).
  // Heuristic: a lineage edge where both endpoints carry hooks but share NONE
  // is *possibly* loose. But hooks are sparse (1-3/card), so genuinely-related
  // cards often share none too — this fires on ~1/4 of real lineage edges, far
  // too noisy to SCORE (it would drown the audit like multi-fact once did).
  // So it does NOT add to r.score and is NOT shown in the default audit; it is
  // surfaced ONLY via `wiki audit --all --rule edge-aptness` as a deliberate
  // "show me suspect lineage edges to eyeball" review pass. The durable fix for
  // wrong edges is the persona guidance (default cross-domain links to cites);
  // this rule is a coarse net for a manual sweep, nothing more.
  const LINEAGE_VERBS = new Set(['extends', 'instance_of', 'depends_on', 'refines']);
  const hooksOf = (slug) => {
    const p = pageBySlug.get(slug);
    const h = p && p.fm && Array.isArray(p.fm.hooks) ? p.fm.hooks : [];
    return new Set(h.filter((x) => typeof x === 'string' && x));
  };
  for (const r of perPage) {
    const myHooks = hooksOf(r.slug);
    if (myHooks.size === 0) continue;
    const p = pageBySlug.get(r.slug);
    const suspect = [];
    for (const rel of parseRelations(p.body)) {
      if (!LINEAGE_VERBS.has(rel.verb)) continue;
      if (!slugSet.has(rel.target)) continue; // stub target → can't judge
      const tHooks = hooksOf(rel.target);
      if (tHooks.size === 0) continue; // target hookless → don't judge
      if (![...myHooks].some((h) => tHooks.has(h))) suspect.push(`${rel.verb} [[${rel.target}]]`);
    }
    if (suspect.length) {
      // Advisory only: recorded as an issue (so --rule edge-aptness can list it)
      // but NOT added to r.score, so it never affects blocking, top-offenders,
      // or the default audit noise floor.
      r.issues.push({
        rule: 'edge-aptness',
        severity: 'advisory',
        detail: `${suspect.length} lineage edge(s) to a card sharing no hook (loose? prefer cites): ${suspect.slice(0, 3).join('; ')}`,
      });
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
  OBSERVATION_BLOAT_THRESHOLD,
  auditPage,
  auditVault,
  strictRuleErrors,
  ironcladRuleErrors,
  strictCrossPageErrors,
  severityScore,
};
