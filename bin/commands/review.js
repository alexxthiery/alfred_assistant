// commands/review.js — `wiki review`: periodic cross-vault discovery digest.
//
// Read-only. Surfaces opportunities (independent mentions, missing edges,
// concept/hook anchors) and health gaps (stale markers, missing rationale,
// orphan sources, stale todos) plus a re-encounter sample. Outputs Markdown;
// no auto-fixes. Run weekly-ish.

'use strict';

const fs = require('fs');
const { forEachPage, wikiPath, SCHEMA_PATH } = require('../lib/vault.js');
const { aliasesOf, parseRelations, parseObservations, stripSupersededObservationLines } = require('../lib/graph.js');
const { loadSchema: _loadSchema } = require('../lib/schema.js');
const { OBSERVATION_BLOAT_THRESHOLD } = require('../lib/audit.js');

const loadSchema = () => _loadSchema(SCHEMA_PATH);

function reviewIdSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function stableReviewHash(value) {
  let h = 2166136261;
  const s = String(value || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function parseReviewDate(args) {
  if (!args.asof) return new Date();
  const s = String(args.asof);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    console.error('error: --asof must be YYYY-MM-DD');
    process.exit(1);
  }
  const d = new Date(`${s}T00:00:00.000Z`);
  if (!isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    console.error('error: --asof must be a real YYYY-MM-DD date');
    process.exit(1);
  }
  return d;
}

const REVIEW_STOPWORDS = new Set([
  // Calendar
  'January','February','March','April','May','June','July','August','September','October','November','December',
  'Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Sept','Oct','Nov','Dec',
  'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday',
  'Mon','Tue','Tues','Wed','Thu','Thurs','Fri','Sat','Sun',
  'Spring','Summer','Autumn','Winter','Fall',
  // Sentence starters / common English caps
  'The','This','That','These','Those','There','Their','They','Them','Then','Than','Thus','Therefore','However','Moreover','Its',
  'Now','Today','Yesterday','Tomorrow','First','Second','Third','Last','Next','Final','Latest',
  'Note','See','Also','And','But','Or','For','From','With','Without','While','When','Where','After','Before','During','Until','Since',
  'Yes','No','Maybe','Probably','Likely','Both','Either','Neither','Each','Every','Many','Most','Some','Few','All','None','Any',
  'New','Old','Good','Bad','Big','Small','Large','High','Low','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
  // Channel + agent names that appear in provenance/log churn
  'Telegram','WhatsApp','Twitter','Slack','Email','SMS','Discord',
  'Alfred','Claude','GPT','LLM','AI','API','CLI','URL','PDF','HTML','JSON','TSV','CSV',
  // Common nouns that are often capitalized at start of bullet
  'Stub','Page','Note','Source','Event','Decision','Synthesis','Todo','Concept','Entity',
  'Status','Open','Done','Doing','Abandoned','Pending','Closed',
  'Reason','Why','How','What','Who','Whom','Whose','Which','Will','Would','Should','Could','Can','May','Must',
  // Verbs/predicates frequently starting `[fact]` bullets
  'Lives','Lived','Living','Born','Works','Worked','Working','Studies','Studied','Studying',
  'Teaches','Taught','Teaching','Knows','Known','Knew','Met','Meeting','Plans','Planned','Going',
  'Wrote','Writes','Writing','Read','Reads','Reading','Speaks','Spoke','Speaking',
  'Has','Had','Have','Is','Was','Were','Will','Got','Get','Goes','Went','Said','Says','Saying',
  // Role/descriptor words that show up capitalized but generic
  'Associate','Assistant','Adjunct','Full','Visiting','Honorary','Emeritus',
  'Professor','Lecturer','Reader','Researcher','Director','Founder','Editor','Chair',
  'University','College','School','Institute','Department','Faculty','Center','Centre','Lab','Laboratory',
  'Research','Group','Team','Office','Course','Class','Conference','Seminar','Workshop','Talk',
  // Page-section markers + measurements
  'Height','Weight','Age','Date','Time','Year','Month','Week','Day','Hour','Minute',
  'Birthday','Birth','Death','Marriage','Anniversary','Address',
  'Current','Previous','Past','Future','Recent','Latest','Same','Other','Another',
  'Wife','Husband','Father','Mother','Son','Daughter','Brother','Sister','Parent','Child','Cousin','Uncle','Aunt','Grandfather','Grandmother',
  // Geographic generics often present in bodies (NOT proper place names)
  'France','French','Vietnam','Vietnamese','Singapore','Singaporean','English','Chinese','Mandarin','Universit',
  'European','American','Asian','African','Australian',
]);

function cmdReview(args) {
  const today = parseReviewDate(args);
  const reviewDate = today.toISOString().slice(0, 10);
  const all = [];
  forEachPage(({ slug, fm, body }) => all.push({ slug, fm, body }));

  // Build known surface forms: every slug, every title, every alias, lowercased.
  // Also remember single-token components of multi-token known forms. A bare
  // surname-like token such as "Fisher" should not be proposed after
  // [[ronald-fisher]] / [[fisher-information]] exist, but the unsafe bare token
  // also should not need to live as an autolink alias.
  const known = new Set();
  const knownComponents = new Set();
  const addKnown = (s) => {
    if (!s) return;
    const raw = String(s);
    known.add(raw.toLowerCase());
    const tokens = raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter((t) => t.length >= 4);
    if (tokens.length >= 2) {
      for (const t of tokens) knownComponents.add(t.toLowerCase());
    }
  };
  for (const p of all) {
    addKnown(p.slug);
    addKnown(p.slug.replace(/-/g, ' '));
    addKnown(p.fm.title);
    const aliases = aliasesOf(p.fm);
    for (const a of aliases) addKnown(a);
  }
  const schema = loadSchema();
  for (const t of (schema.tags || [])) known.add(String(t).toLowerCase());

  const sections = [];

  // ── Section 1: independent mentions / promotion candidates ────────────────
  // Multi-word or 3+ char capitalized sequences appearing as plain text in
  // ≥2 distinct pages, not already a known slug/title/alias.
  const candidateMap = new Map(); // key: lower-cased form → { display, pageSnippets: Map<slug, sentence> }
  // Capitalized sequences, optionally connected by short lowercase joiners
  // ("of", "and", "for") so we can capture "University of Warwick" as one token.
  const CAND_RE = /\b([A-Z][a-zA-Z]{2,}(?:\s(?:of|and|for|de|du|la|le|von|van|der|des)\s[A-Z][a-zA-Z]{2,}|\s[A-Z][a-zA-Z]{2,})*)\b/g;

  for (const p of all) {
    // Strip wikilinks, code fences, frontmatter-like lines, and provenance markers.
    let text = stripSupersededObservationLines(p.body)
      .replace(/\[\[[^\]]+\]\]/g, ' ')                 // remove wikilinks
      .replace(/```[\s\S]*?```/g, ' ')                  // remove fenced code
      .replace(/`[^`]+`/g, ' ')                         // inline code
      .replace(/\^\[[^\]]+\]/g, ' ')                    // provenance
      .replace(/#[a-z][a-z-]*\b/g, ' ');                // tag tokens

    // Sentence segmentation for snippets (greedy on . ? ! \n).
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);

    for (const sentence of sentences) {
      // For each sentence, find the first non-marker text position so we can
      // detect "bullet-leading" capitalization (e.g. "- [fact] Lives in …").
      // We compute the *byte index* of the first content character after
      // optional "- ", "- [cat] ", "## ", etc.
      const lead = sentence.match(/^\s*(?:-\s*(?:~~)?\[[a-z]+\]\s*|-\s+|#+\s+|\d+\.\s+)?/);
      const contentStartIdx = lead ? lead[0].length : 0;

      let m;
      CAND_RE.lastIndex = 0;
      while ((m = CAND_RE.exec(sentence)) !== null) {
        const display = m[1];
        const matchIdx = m.index;
        // Strip possessive trailing 's.
        const cleaned = display.replace(/['’]s$/, '');
        const isMultiWord = /\s/.test(cleaned);
        const firstWord = cleaned.split(' ')[0];
        const key = cleaned.toLowerCase();
        if (cleaned.length < 4) continue;
        if (REVIEW_STOPWORDS.has(cleaned) || REVIEW_STOPWORDS.has(firstWord)) continue;
        if (known.has(key) || known.has(firstWord.toLowerCase())) continue;
        if (!isMultiWord && knownComponents.has(key)) continue;
        // Skip if it's just a number/date-ish token.
        if (/^\d/.test(cleaned)) continue;
        // Skip if it's all-caps short (probably an acronym we can't disambiguate).
        if (cleaned === cleaned.toUpperCase() && cleaned.length < 5) continue;
        // POSITION GATE: if a SINGLE-WORD candidate appears at the very start
        // of the content (right after `[fact]`, `## `, etc.), it is almost
        // certainly a sentence-starting verb/noun, not a proper noun.
        // Multi-word sequences are allowed at the start because real names
        // do open many bullets ("John Smith joined the team").
        if (!isMultiWord && matchIdx <= contentStartIdx + 1) continue;

        if (!candidateMap.has(key)) candidateMap.set(key, { display: cleaned, pageSnippets: new Map() });
        const entry = candidateMap.get(key);
        if (!entry.pageSnippets.has(p.slug)) {
          // Save a trimmed snippet for the first occurrence on this page.
          const snip = sentence.trim().replace(/\s+/g, ' ').slice(0, 140);
          entry.pageSnippets.set(p.slug, snip);
        }
      }
    }
  }
  const promotionCandidates = [];
  for (const [, v] of candidateMap.entries()) {
    if (v.pageSnippets.size >= 2) promotionCandidates.push({ display: v.display, pages: [...v.pageSnippets.entries()] });
  }
  promotionCandidates.sort((a, b) => b.pages.length - a.pages.length || a.display.localeCompare(b.display));

  sections.push({
    title: 'Independent mentions — promotion candidates',
    note: 'Capitalized names/phrases appearing as plain text in ≥2 pages and not already a slug/title/alias. Likely a person/place/concept that should be its own atomic page.',
    items: promotionCandidates.slice(0, 20).map((c) => ({
      id: `mention:${reviewIdSegment(c.display)}`,
      head: `${c.display} (${c.pages.length} pages)`,
      lines: c.pages.slice(0, 4).map(([slug, snip]) => `    ${slug}: ${snip}`),
    })),
  });

  // ── Section 2: co-occurring slugs with no typed-edge ─────────────────────
  // Pairs of existing slugs co-mentioned via wikilinks in ≥3 pages but with
  // no relation in either direction.
  const wikilinkRe = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;
  const coCount = new Map(); // "a|b" (sorted) → count
  const relSet = new Set();  // "a|b" (sorted) for any direction
  for (const p of all) {
    const links = new Set();
    let lm;
    wikilinkRe.lastIndex = 0;
    while ((lm = wikilinkRe.exec(p.body)) !== null) {
      if (lm[1] !== p.slug) links.add(lm[1]);
    }
    const arr = [...links];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = [arr[i], arr[j]].sort().join('|');
        coCount.set(key, (coCount.get(key) || 0) + 1);
      }
    }
    for (const r of parseRelations(p.body)) {
      relSet.add([p.slug, r.target].sort().join('|'));
    }
  }
  const missingEdges = [];
  for (const [key, n] of coCount.entries()) {
    if (n >= 3 && !relSet.has(key)) {
      const [a, b] = key.split('|');
      if (fs.existsSync(wikiPath(a)) && fs.existsSync(wikiPath(b))) {
        missingEdges.push({ a, b, n });
      }
    }
  }
  missingEdges.sort((x, y) => y.n - x.n);
  sections.push({
    title: 'Co-occurring slugs with no typed relation',
    note: 'Pairs of existing pages that appear together via wikilinks in ≥3 pages but have no relation. Suggests a missing edge.',
    items: missingEdges.slice(0, 15).map((e) => ({
      id: `edge:${e.a}|${e.b}`,
      head: `${e.a} ↔ ${e.b} (co-mentioned in ${e.n} pages)`,
      lines: [],
    })),
  });

  // ── Section 3: concept anchors missing ───────────────────────────────────
  // Tags used heavily but with no canonical concept page slug=tagname.
  // Skip taxonomy tags (kind tags + roles + meta) — those are classifiers,
  // not concepts. Only surface tags that look like discipline/topic names.
  const NON_CONCEPT_TAGS = new Set([
    'person', 'org', 'tool', 'paper', 'media',                  // entity-kind
    'spouse', 'child', 'parent', 'sibling',                     // role
    'friend', 'colleague', 'client', 'household',               // social role
    'meta', 'family', 'work', 'recurring', 'decision', 'event', // structural
    'project', 'idea', 'opinion', 'pattern', 'principle',       // workflow/category
    'health', 'research', 'reading', 'finance', 'fitness',      // domain classifiers
    'travel', 'food', 'hobby',
  ]);
  const tagCount = new Map();
  for (const p of all) {
    const tags = Array.isArray(p.fm.tags) ? p.fm.tags : [];
    for (const t of tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  const missingAnchors = [];
  for (const [tag, n] of tagCount.entries()) {
    if (n < 8) continue;
    if (NON_CONCEPT_TAGS.has(tag)) continue;
    if (fs.existsSync(wikiPath(tag))) continue;
    if (fs.existsSync(wikiPath(`${tag}-overview`))) continue;
    missingAnchors.push({ tag, n });
  }
  missingAnchors.sort((x, y) => y.n - x.n);
  sections.push({
    title: 'Concept anchors missing',
    note: 'Topic/discipline tags used ≥ 8 times but no canonical concept page. Consider a `type: synthesis` or `type: concept` page tying them together. Closed-taxonomy classifier tags (person, family, work, …) are excluded.',
    items: missingAnchors.slice(0, 15).map((e) => ({
      id: `tag-anchor:${reviewIdSegment(e.tag)}`,
      head: `#${e.tag} (${e.n} pages)`,
      lines: [],
    })),
  });

  // ── Section 3b: hook promotion candidates ────────────────────────────────
  // Connective hooks (the sparse `hooks:` field on idea atoms) recurring across
  // >= HOOK_PROMOTE_THRESHOLD pages but not yet a concept page (and not already
  // an alias). These have earned promotion to a `type: concept` principle, with
  // the carrying atoms linked via instance_of/about. Mirrors the bottom-up
  // "promote on recurrence" discipline; the threshold is lower than the tag
  // anchor's (hooks are rarer and more specific than taxonomy tags).
  const HOOK_PROMOTE_THRESHOLD = 3;
  // Above this many carriers a hook is almost certainly over-applied: it has
  // drifted into a semi-stopword that bridges loosely-related cards across
  // domains (the failure mode behind spurious connections). Such a hook is NOT
  // a clean promotion candidate — its members must be audited and the inapt
  // ones pruned/split before it earns a principle page. In connection scoring
  // a hook this common is also weak evidence (see `related` IDF weighting).
  const HOOK_DILUTION_THRESHOLD = 12;
  const hookCount = new Map();
  const hookSamples = new Map();
  const aliasSet = new Set();
  for (const p of all) {
    const al = Array.isArray(p.fm.aliases) ? p.fm.aliases : [];
    for (const a of al) aliasSet.add(a);
  }
  for (const p of all) {
    const hooks = Array.isArray(p.fm.hooks) ? p.fm.hooks : [];
    for (const h of hooks) {
      if (typeof h !== 'string' || !h) continue;
      hookCount.set(h, (hookCount.get(h) || 0) + 1);
      if (!hookSamples.has(h)) hookSamples.set(h, []);
      const s = hookSamples.get(h);
      if (s.length < 6) s.push(p.slug);
    }
  }
  const hookCandidates = [];
  const dilutedHooks = [];
  for (const [hook, n] of hookCount.entries()) {
    if (n > HOOK_DILUTION_THRESHOLD) { dilutedHooks.push({ hook, n }); continue; }
    if (n < HOOK_PROMOTE_THRESHOLD) continue;
    if (fs.existsSync(wikiPath(hook))) continue; // already a page/principle
    if (aliasSet.has(hook)) continue;            // already represented via an alias
    hookCandidates.push({ hook, n });
  }
  hookCandidates.sort((x, y) => y.n - x.n || x.hook.localeCompare(y.hook));
  dilutedHooks.sort((x, y) => y.n - x.n || x.hook.localeCompare(y.hook));
  sections.push({
    title: 'Hook promotion candidates',
    note: `Connective hooks recurring across ${HOOK_PROMOTE_THRESHOLD}–${HOOK_DILUTION_THRESHOLD} atoms with no concept page yet. Promote each to a \`type: concept\` principle and link the carrying atoms via instance_of/about (canonical name + aliases synonym ring). Before promoting, reread the carriers and drop any whose own claim does not instantiate the hook.`,
    items: hookCandidates.slice(0, 15).map((e) => ({
      id: `hook:${reviewIdSegment(e.hook)}`,
      head: `${e.hook} (${e.n} atoms)`,
      lines: [`carried by: ${hookSamples.get(e.hook).join(', ')}`],
    })),
  });
  if (dilutedHooks.length) {
    sections.push({
      title: 'Diluted hooks (audit, do not promote as-is)',
      note: `Hooks carried by > ${HOOK_DILUTION_THRESHOLD} atoms. A hook this common has likely been over-applied into a semi-stopword and is bridging loosely-related cards. Audit each member for aptness; prune the inapt ones (or split the hook into specific sub-concepts) BEFORE promoting. Do not promote a diluted hook to a principle as-is.`,
      items: dilutedHooks.slice(0, 15).map((e) => ({
        id: `diluted-hook:${reviewIdSegment(e.hook)}`,
        head: `${e.hook} (${e.n} atoms)`,
        lines: [`sample: ${hookSamples.get(e.hook).join(', ')}`],
      })),
    });
  }

  // ── Bloated cards: too many active observations on one page ──────────────
  // The observation-level analogue of Diluted hooks. A card with many active
  // categorized observations has drifted from atomic-concept-per-page into a
  // log of disparate sub-topics that each deserve their own page. The fix is
  // the bloat remediation playbook in persona/pipeline.md — read the card,
  // cluster its observations by shape (time-series → wiki measure, qualitative
  // → type=concept, events → type=event, hub-facet → sub-page with part_of),
  // mint targets, and supersede on the source. Same `wiki audit --all --rule
  // bloated-card` shortlist surfaces here for the periodic review pass.
  const bloated = [];
  for (const p of all) {
    const active = parseObservations(p.body).filter((o) => !o.superseded).length;
    if (active >= OBSERVATION_BLOAT_THRESHOLD) bloated.push({ slug: p.slug, n: active });
  }
  bloated.sort((x, y) => y.n - x.n || x.slug.localeCompare(y.slug));
  if (bloated.length) {
    sections.push({
      title: 'Bloated cards (consider observation-level promotion)',
      note: `Pages with >= ${OBSERVATION_BLOAT_THRESHOLD} active categorized observations. Each is a candidate for the bloat remediation playbook (\`persona/pipeline.md\`): cluster the observations by shape and promote each cluster to its own page (time-series → \`wiki measure\`, qualitative cluster → \`type: concept\`, events → \`type: event\`, sub-facets of a hub → sub-page with \`part_of\`). Same shortlist as \`wiki audit --all --rule bloated-card\`.`,
      items: bloated.slice(0, 15).map((e) => ({
        id: `bloated:${e.slug}`,
        head: `${e.slug} (${e.n} active observations)`,
        lines: [],
      })),
    });
  }

  // ── Section 4: stale temporal markers ────────────────────────────────────
  const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;
  const staleTemporal = [];
  for (const p of all) {
    const observations = parseObservations(p.body);
    for (let obsIndex = 0; obsIndex < observations.length; obsIndex++) {
      const obs = observations[obsIndex];
      if (obs.superseded) continue;
      if (obs.dates.asOf) {
        // [as-of YYYY-MM] — assume 1st of month.
        const d = new Date(obs.dates.asOf.length === 7 ? `${obs.dates.asOf}-01` : obs.dates.asOf);
        if (isFinite(d.getTime()) && today.getTime() - d.getTime() > SIX_MONTHS_MS) {
          staleTemporal.push({ slug: p.slug, kind: 'as-of', when: obs.dates.asOf, body: obs.body, obsId: obs.id, obsIndex });
        }
      }
      // [until YYYY-MM-DD] on a non-superseded hypothesis is genuinely stale —
      // the hypothesis should have been promoted to fact or struck by now.
      // [until] on a [fact] line is a bounded historical record (CV entry,
      // past affiliation), NOT stale — skip those.
      if (obs.dates.until && !obs.superseded && obs.category === 'hypothesis') {
        const d = new Date(obs.dates.until.length === 7 ? `${obs.dates.until}-01` : obs.dates.until);
        if (isFinite(d.getTime()) && d.getTime() < today.getTime()) {
          staleTemporal.push({ slug: p.slug, kind: 'hypothesis past [until]', when: obs.dates.until, body: obs.body, obsId: obs.id, obsIndex });
        }
      }
    }
  }
  sections.push({
    title: 'Stale temporal markers',
    note: '`[as-of YYYY-MM]` markers > 6 months old (likely outdated) or unsuperseded `[until YYYY-MM-DD]` past today.',
    items: staleTemporal.slice(0, 20).map((e) => ({
      id: `temporal:${e.slug}:${reviewIdSegment(e.kind)}:${reviewIdSegment(e.when)}:${e.obsId || `${stableReviewHash(e.body)}-${e.obsIndex}`}`,
      head: `${e.slug} (${e.kind} ${e.when})`,
      lines: [`    ${e.body.slice(0, 140)}`],
    })),
  });

  // ── Section 5: type=decision without rationale ────────────────────────────
  const noRationale = [];
  for (const p of all) {
    if (p.fm.type !== 'decision') continue;
    const obs = parseObservations(p.body);
    const hasClaim = obs.some((o) => o.category === 'claim');
    const hasBecause = /\b(because|since|reason|rationale|so that|in order to)\b/i.test(p.body);
    const hasDerivedFrom = !!p.fm.derived_from;
    if (!hasClaim && !hasBecause && !hasDerivedFrom) noRationale.push(p.slug);
  }
  sections.push({
    title: 'Decisions without rationale',
    note: '`type: decision` pages with no `[claim]`, no "because"/"reason" prose, and no `derived_from` frontmatter. Decisions without a recorded *why* lose half their value when re-read.',
    items: noRationale.slice(0, 15).map((s) => ({ id: `decision-rationale:${s}`, head: s, lines: [] })),
  });

  // ── Section 6: orphan sources ─────────────────────────────────────────────
  const sourceSlugs = all.filter((p) => p.fm.type === 'source').map((p) => p.slug);
  const sourcePathMap = new Map();
  for (const p of all) {
    if (p.fm.type === 'source' && p.fm.raw_path) sourcePathMap.set(p.fm.raw_path, p.slug);
  }
  const referencedSources = new Set();
  for (const p of all) {
    // Wikilink reference
    let lm;
    wikilinkRe.lastIndex = 0;
    while ((lm = wikilinkRe.exec(p.body)) !== null) {
      if (sourceSlugs.includes(lm[1])) referencedSources.add(lm[1]);
    }
    // Provenance pointer matching a source raw_path
    const provRe = /\^\[([^\]]+)\]/g;
    let pm;
    while ((pm = provRe.exec(p.body)) !== null) {
      if (sourcePathMap.has(pm[1])) referencedSources.add(sourcePathMap.get(pm[1]));
    }
  }
  const orphanSources = sourceSlugs.filter((s) => !referencedSources.has(s));
  sections.push({
    title: 'Orphan sources',
    note: '`type: source` pages not referenced by any other page (no wikilink, no provenance pointer). Why was it ingested?',
    items: orphanSources.slice(0, 15).map((s) => ({ id: `orphan-source:${s}`, head: s, lines: [] })),
  });

  // ── Section 7: stale open todos ──────────────────────────────────────────
  const SIXTY_DAYS_MS = 1000 * 60 * 60 * 24 * 60;
  const staleTodos = [];
  for (const p of all) {
    if (p.fm.type !== 'todo' || p.fm.status !== 'open') continue;
    if (!p.fm.updated) continue;
    const d = new Date(p.fm.updated);
    if (!isFinite(d.getTime())) continue;
    const ageDays = Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (today.getTime() - d.getTime() > SIXTY_DAYS_MS) staleTodos.push({ slug: p.slug, ageDays });
  }
  staleTodos.sort((a, b) => b.ageDays - a.ageDays);
  sections.push({
    title: 'Stale open todos',
    note: '`type: todo` with `status: open` and `updated` > 60 days ago. Rotate forward or close.',
    items: staleTodos.slice(0, 15).map((e) => ({
      id: `stale-todo:${e.slug}`,
      head: `${e.slug} (${e.ageDays} days stale)`,
      lines: [],
    })),
  });

  // ── Section: Re-encounter (forcing function for retrieval) ────────────────
  // Most PKM failure mode is "capture works, retrieval doesn't." Surface a
  // small mixed sample to force re-reading even when nothing is broken.
  // Skip auto-files (index/log) and source pages (one-shot ingest).
  const SUBSTANTIVE = (p) => !['index', 'log'].includes(p.slug) && (p.fm.type || 'note') !== 'source';
  const withDate = all.filter(SUBSTANTIVE).map((p) => {
    const u = p.fm.updated || p.fm.created || null;
    return { slug: p.slug, type: p.fm.type || 'note', updated: u, ts: u ? Date.parse(u) : 0 };
  });
  withDate.sort((a, b) => b.ts - a.ts);
  const recent = withDate.slice(0, 5);
  const STALE_MS = 180 * 24 * 60 * 60 * 1000;
  const stale = withDate
    .filter((p) => p.ts > 0 && today.getTime() - p.ts > STALE_MS)
    .slice(-10) // oldest-touched: end of desc-sort
    .reverse()
    .slice(0, 5);
  // Deterministic-by-review-date random sample.
  const dayStr = reviewDate;
  let seed = 0;
  for (let i = 0; i < dayStr.length; i++) seed = ((seed << 5) - seed + dayStr.charCodeAt(i)) | 0;
  const rng = () => { seed = (seed * 1664525 + 1013904223) | 0; return ((seed >>> 0) / 0x100000000); };
  const pool = withDate.slice();
  const randomSample = [];
  for (let i = 0; i < 5 && pool.length; i++) {
    const idx = Math.floor(rng() * pool.length);
    randomSample.push(pool.splice(idx, 1)[0]);
  }
  const reEncounterItems = [];
  if (recent.length) {
    reEncounterItems.push({ id: 'reencounter:recent-heading', head: '*recently touched* — open these to remember what you just told yourself', lines: [] });
    for (const r of recent) reEncounterItems.push({ id: `reencounter:recent:${r.slug}`, head: `  ${r.slug} (${r.type}, updated ${(r.updated || '').slice(0, 10)})`, lines: [] });
  }
  if (stale.length) {
    reEncounterItems.push({ id: 'reencounter:stale-heading', head: '*stale long-tail* — untouched >6 months; revisit or retire', lines: [] });
    for (const s of stale) reEncounterItems.push({ id: `reencounter:stale:${s.slug}`, head: `  ${s.slug} (${s.type}, updated ${(s.updated || '').slice(0, 10)})`, lines: [] });
  }
  if (randomSample.length) {
    reEncounterItems.push({ id: 'reencounter:random-heading', head: '*random sample (seeded by review date)* — forced serendipity', lines: [] });
    for (const r of randomSample) reEncounterItems.push({ id: `reencounter:random:${r.slug}`, head: `  ${r.slug} (${r.type})`, lines: [] });
  }
  sections.push({
    title: 'Re-encounter (forcing function for retrieval)',
    note: 'A vault becomes write-only without scheduled re-reading. Open one or two of these. The random sample is deterministic per review date so revisits are stable.',
    items: reEncounterItems,
  });

  // ── Render ────────────────────────────────────────────────────────────────
  if (args.json) {
    console.log(JSON.stringify({ date: reviewDate, pages: all.length, sections }, null, 2));
    return;
  }

  console.log(`# Vault review — ${reviewDate}`);
  console.log('');
  console.log(`Pages: ${all.length}`);
  console.log('');
  for (const s of sections) {
    console.log(`## ${s.title}`);
    if (s.note) console.log(`_${s.note}_`);
    console.log('');
    if (s.items.length === 0) {
      console.log('(none)');
    } else {
      for (const it of s.items) {
        console.log(`- ${it.head}`);
        for (const l of (it.lines || [])) console.log(l);
      }
    }
    console.log('');
  }
}

module.exports = { cmdReview };
