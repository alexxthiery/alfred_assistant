// ingest.js — pure write-time validators.
//
// Two surfaces, both lifted out of bin/wiki for unit-testability:
//
//   validateIngestSpec(spec, deps)
//     The top-level JSON-spec validator used by `wiki ingest`. Caller injects
//     schema + vault state + a fuzzy resolver; gets back errors + parsed
//     sections (stubs/entities/events/patches/createdSlugs).
//
//   validateBody({slug,title,type,tags,body,fm}, deps)
//     The per-page body validator used by `wiki write` and `wiki audit`.
//     Caller injects schema + knownVerbs; gets back a list of {rule, message}
//     entries (empty list = clean). Rules: mislabeled-event, event-tag,
//     event-when, uncategorized-bullets, invented-verb, missing-provenance.

'use strict';

const { validSlug, isReserved, KNOWN_TYPES, ENTITY_KIND_TAGS } = require('./schema.js');
const { strictRuleErrors, strictCrossPageErrors, STRICT_CROSS_PAGE_RULES } = require('./audit.js');

const FUZZY_DUP_THRESHOLD = 0.7;

// Types accepted in a spec's `entities[]`: the idea/knowledge-card subset of
// KNOWN_TYPES. Excludes the types with a dedicated path — `event` (use the
// `events[]` array), `todo` (use `wiki todo`), and `source`/`view` (auto-
// managed from raw_path / measurements). Kept in sync with `wiki write`, which
// accepts these same card types.
const INGEST_ENTITY_TYPES = new Set(['entity', 'concept', 'decision', 'question', 'synthesis', 'note']);

// The observation categories a spec entity/patch may carry, as
// [categoryTag, specField] pairs (e.g. a `facts` array renders `- [fact] ...`).
// SINGLE SOURCE OF TRUTH for this mapping: bin/wiki's buildBodyFromSpec renders
// from it, and the validator's hasContent check below recognizes the same set.
// Keeping both off one list prevents the drift that let a `questions`-only card
// render but be rejected as "empty" (and a question type be forbidden).
const OBSERVATION_CATEGORIES = [
  ['fact', 'facts'],
  ['hypothesis', 'hypotheses'],
  ['opinion', 'opinions'],
  ['claim', 'claims'],
  ['quote', 'quotes'],
  ['question', 'questions'],
  ['decision', 'decisions'],
  ['idea', 'ideas'],
];
const OBSERVATION_FIELDS = OBSERVATION_CATEGORIES.map(([, field]) => field);

// Date format the validator accepts on event.when: YYYY, YYYY-MM, YYYY-MM-DD,
// or full ISO-8601 with optional time zone.
const WHEN_RE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

function validateIngestSpec(spec, deps) {
  const {
    schema,
    knownVerbs,
    existingSlugs,                   // Set<string> — slugs whose page is already on disk
    fuzzyMatchFn = () => [],         // (query, opts) => [{slug, confidence, reason}]
    allowDuplicates = false,
    allowDuplicateSlugs = new Set(), // B2: per-slug opt-out (from --allow-duplicate-slug)
  } = deps;

  const errors = [];

  // ─── top-level shape ────────────────────────────────────────────────────
  if (!spec || typeof spec !== 'object') {
    return { errors: ['top-level: spec must be an object'], stubs: [], entities: [], events: [], patches: [], createdSlugs: new Set() };
  }
  if (!spec.source || typeof spec.source !== 'string') {
    errors.push('top-level: "source" string is required (e.g. "telegram:2026-05-17")');
  }
  const stubs    = Array.isArray(spec.stubs)    ? spec.stubs    : [];
  const entities = Array.isArray(spec.entities) ? spec.entities : [];
  const events   = Array.isArray(spec.events)   ? spec.events   : [];
  const patches  = Array.isArray(spec.patches)  ? spec.patches  : [];
  if (stubs.length + entities.length + events.length + patches.length === 0) {
    errors.push('spec is empty: provide at least one of stubs/entities/events/patches');
  }

  // ─── slug uniqueness within spec + created-slugs set ────────────────────
  const createdSlugs = new Set();
  const slugSeen = new Map();
  const addSlug = (slug, section) => {
    if (!slug) return;
    createdSlugs.add(slug);
    if (!slugSeen.has(slug)) slugSeen.set(slug, []);
    slugSeen.get(slug).push(section);
  };
  for (const s of stubs)    if (s) addSlug(s.slug, 'stubs');
  for (const e of entities) if (e) addSlug(e.slug, 'entities');
  for (const e of events)   if (e) addSlug(e.slug, 'events');
  for (const [slug, locs] of slugSeen.entries()) {
    if (locs.length > 1) {
      errors.push(`duplicate slug "${slug}" appears in: ${locs.join(', ')} — each slug can only be written once per spec`);
    }
  }

  // ─── fuzzy duplicate check against existing vault ───────────────────────
  if (!allowDuplicates) {
    // B2: per-entity opt-out. A single false positive no longer forces the
    // all-or-nothing --allow-duplicates on the whole batch: set
    // `"allow_duplicate": true` on the spec item, or pass its slug via
    // --allow-duplicate-slug, to wave through just that one.
    const checkNewSlug = (slug, title, section, perItemAllow) => {
      if (perItemAllow || allowDuplicateSlugs.has(slug)) return;
      if (!slug || !title || title.length < 3) return;
      if (existingSlugs.has(slug)) return;
      const matches = fuzzyMatchFn(title, { excludeSlug: slug }) || [];
      const hit = matches.find((m) => m.confidence >= FUZZY_DUP_THRESHOLD && m.slug !== slug);
      if (hit) {
        errors.push(`${section} "${slug}" (title "${title}") may duplicate existing [[${hit.slug}]] (confidence ${hit.confidence.toFixed(2)}, ${hit.reason}). Use \`wiki resolve "${title}"\` first, set "allow_duplicate": true on this item, pass --allow-duplicate-slug ${slug}, or --allow-duplicates for the whole batch.`);
      }
    };
    for (const s of stubs)    if (s) checkNewSlug(s.slug, s.title, 'stubs', s.allow_duplicate);
    for (const e of entities) if (e) checkNewSlug(e.slug, e.title, 'entities', e.allow_duplicate);
    for (const e of events)   if (e) checkNewSlug(e.slug, e.title, 'events', e.allow_duplicate);
  }

  // ─── shared helpers (closed over schema + errors) ───────────────────────
  const validateSlugStrict = (s) => validSlug(s) && !isReserved(s) && !schema.forbidden.has(s);

  const validateRelations = (rels, ctx, selfSlug) => {
    if (!Array.isArray(rels)) return;
    for (const r of rels) {
      if (!r || !r.verb || !r.target) {
        errors.push(`${ctx}: relation needs {verb, target}, got ${JSON.stringify(r)}`);
        continue;
      }
      if (!knownVerbs.has(r.verb) && !/\s/.test(r.verb)) {
        errors.push(`${ctx}: invented verb "${r.verb}" — not in SCHEMA registries`);
      }
      if (selfSlug && r.target === selfSlug) {
        errors.push(`${ctx}: self-relation not allowed (target "${r.target}" equals page slug)`);
        continue;
      }
      if (!validateSlugStrict(r.target)) {
        errors.push(`${ctx}: relation target "${r.target}" is not a valid slug`);
      } else if (!createdSlugs.has(r.target) && !existingSlugs.has(r.target)) {
        errors.push(`${ctx}: relation target [[${r.target}]] does not exist — add a stub or create the page`);
      }
    }
  };

  const validateTags = (tags, ctx) => {
    if (!Array.isArray(tags)) { errors.push(`${ctx}: tags must be an array`); return; }
    if (schema.tags) {
      const unknown = tags.filter((t) => !schema.tags.has(t));
      if (unknown.length) {
        errors.push(`${ctx}: unknown tag(s) ${unknown.map((t) => `"${t}"`).join(', ')} — add to SCHEMA.md first`);
      }
    }
  };

  // ─── per-section validation ─────────────────────────────────────────────
  for (const [i, s] of stubs.entries()) {
    const ctx = `stubs[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${ctx}: must be object`); continue; }
    if (!s.slug || !validateSlugStrict(s.slug)) errors.push(`${ctx}: invalid slug "${s.slug}"`);
    if (!s.title) errors.push(`${ctx}: title required`);
    if (s.type && !KNOWN_TYPES.has(s.type)) errors.push(`${ctx}: unknown type "${s.type}"`);
    validateTags(s.tags || [], ctx);
  }

  for (const [i, e] of entities.entries()) {
    const ctx = `entities[${i}] (${e && e.slug ? e.slug : '?'})`;
    if (!e || typeof e !== 'object') { errors.push(`${ctx}: must be object`); continue; }
    if (!e.slug || !validateSlugStrict(e.slug)) errors.push(`${ctx}: invalid slug`);
    if (!e.title) errors.push(`${ctx}: title required`);
    if (e.type && !INGEST_ENTITY_TYPES.has(e.type)) {
      errors.push(`${ctx}: type must be one of ${[...INGEST_ENTITY_TYPES].join('/')} (or omit for entity); use the events[] array for events and \`wiki todo\` for todos`);
    }
    validateTags(e.tags || [], ctx);
    const type = e.type || 'entity';
    if (type === 'entity') {
      const ek = (e.tags || []).find((t) => ENTITY_KIND_TAGS.has(t));
      if (!ek) errors.push(`${ctx}: type=entity requires one of tags: ${[...ENTITY_KIND_TAGS].join('/')}`);
    }
    const hasContent = OBSERVATION_FIELDS.some((f) => Array.isArray(e[f]) && e[f].length)
      || (e.relations && e.relations.length);
    if (!hasContent) errors.push(`${ctx}: entity needs ≥1 observation (${OBSERVATION_FIELDS.join('/')}) or relation`);
    validateRelations(e.relations || [], ctx, e.slug);
  }

  for (const [i, e] of events.entries()) {
    const ctx = `events[${i}] (${e && e.slug ? e.slug : '?'})`;
    if (!e || typeof e !== 'object') { errors.push(`${ctx}: must be object`); continue; }
    if (!e.slug || !validateSlugStrict(e.slug)) errors.push(`${ctx}: invalid slug`);
    if (!e.title) errors.push(`${ctx}: title required`);
    if (!e.when) {
      errors.push(`${ctx}: "when" required (YYYY-MM-DD or ISO8601)`);
    } else if (!WHEN_RE.test(String(e.when))) {
      errors.push(`${ctx}: "when" must be YYYY-MM-DD or ISO8601; got "${e.when}"`);
    }
    validateTags(e.tags || [], ctx);
    if (!Array.isArray(e.tags) || !e.tags.includes('event')) errors.push(`${ctx}: tags must include "event"`);
    if (Array.isArray(e.attendees)) {
      for (const a of e.attendees) {
        if (!validateSlugStrict(a)) errors.push(`${ctx}: attendee "${a}" is not a valid slug`);
        else if (!createdSlugs.has(a) && !existingSlugs.has(a)) {
          errors.push(`${ctx}: attendee [[${a}]] does not exist — add as stub or create the page`);
        }
      }
    }
    if (e.location && /^[a-z0-9][a-z0-9-]*$/.test(e.location)) {
      if (!createdSlugs.has(e.location) && !existingSlugs.has(e.location)) {
        errors.push(`${ctx}: location "${e.location}" looks like a slug but page does not exist — add as stub or use free text`);
      }
    }
    validateRelations(e.relations || [], ctx, e.slug);
  }

  for (const [i, p] of patches.entries()) {
    const ctx = `patches[${i}] (${p && p.slug ? p.slug : '?'})`;
    if (!p || typeof p !== 'object') { errors.push(`${ctx}: must be object`); continue; }
    if (!p.slug || !validateSlugStrict(p.slug)) errors.push(`${ctx}: invalid slug`);
    else if (!existingSlugs.has(p.slug) && !createdSlugs.has(p.slug)) {
      errors.push(`${ctx}: target page does not exist (and is not being created in this spec)`);
    }
    const hasOps = (p.add_facts && p.add_facts.length) || (p.add_hypotheses && p.add_hypotheses.length)
      || (p.add_opinions && p.add_opinions.length) || (p.add_claims && p.add_claims.length)
      || (p.add_relations && p.add_relations.length)
      || (p.supersede && p.supersede.length) || (p.add_hooks && p.add_hooks.length);
    if (!hasOps) errors.push(`${ctx}: patch needs ≥1 operation`);
    validateRelations(p.add_relations || [], ctx, p.slug);
  }

  return { errors, stubs, entities, events, patches, createdSlugs };
}

// ─── per-page body validator ───────────────────────────────────────────────
// validateBody iterates the `strict: true` subset of AUDIT_RULES (defined in
// ./audit.js). Single source of truth shared with `wiki audit` — only the
// output shape differs (validateBody emits {rule, message}; auditPage emits
// {rule, severity, detail}).

// HR-OOB-B: when deps.allPages is provided, also runs the cross-page strict
// rules (STRICT_CROSS_PAGE_RULES) and concatenates errors. Callers without
// a snapshot get per-page-only checks, same as before.
function validateBody(input, deps) {
  const perPage = strictRuleErrors(input, deps);
  if (!deps || !deps.allPages) return perPage;
  const crossPage = strictCrossPageErrors(input, deps);
  return perPage.concat(crossPage);
}

module.exports = {
  validateIngestSpec,
  validateBody,
  STRICT_CROSS_PAGE_RULES,
  FUZZY_DUP_THRESHOLD,
  OBSERVATION_CATEGORIES,
};
