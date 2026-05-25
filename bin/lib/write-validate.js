// write-validate.js — the pre-write validation cluster shared by every write
// verb (write/patch/ingest/merge).
//
// Two layers, both extracted verbatim from bin/wiki:
//   - validateForWrite: slug/type/tag/derived_from gate (returns an errors[]).
//   - validateBody: the schema-fetching wrapper over lib/ingest.js's pure
//     validator; lazily builds a vault snapshot when cross-page strict rules
//     are active.
// Plus buildAllPagesSnapshot (the snapshot builder, also used by the audit
// path) and warnHooks (soft near-duplicate-hook hints to stderr).
//
// No process.exit, no shared mutable state: the callers decide what to do with
// the returned errors. Mirrors the repo convention that validation logic is
// pure-ish and unit-testable.

'use strict';

const {
  validSlug, isReserved, KNOWN_TYPES, ENTITY_KIND_TAGS,
  loadSchema: _loadSchema, knownRelationVerbs,
} = require('./schema.js');
const { SCHEMA_PATH, forEachPage } = require('./vault.js');
const { validateBody: _validateBody } = require('./ingest.js');
const { STRICT_CROSS_PAGE_RULES } = require('./audit.js');
const { hookWarnings } = require('./maintenance.js');

// A single CLI invocation parses SCHEMA.md once (lib/schema.js memoizes on mtime).
const loadSchema = () => _loadSchema(SCHEMA_PATH);

function validateForWrite({ slug, type, tags, derivedFrom }, { isAppend }) {
  const errors = [];
  if (!validSlug(slug)) errors.push(`Invalid slug: "${slug}" (lowercase, alphanumeric, hyphens; must start with letter or digit)`);
  if (isReserved(slug)) errors.push(`Slug "${slug}" is reserved (auto-maintained file).`);

  const schema = loadSchema();

  // Forbidden aggregator slug — refuse on create/replace, allow append for migration
  if (!isAppend && schema.forbidden.has(slug)) {
    errors.push(
      `Slug "${slug}" is a forbidden aggregator slug (see SCHEMA.md). ` +
      `Atomicity rule: one entity per page. Create atomic pages and link them with relations instead.`
    );
  }

  // Validate type
  if (!isAppend && type && !KNOWN_TYPES.has(type)) {
    errors.push(`Unknown type "${type}". Must be one of: ${[...KNOWN_TYPES].join(', ')}`);
  }

  // Validate tags against SCHEMA taxonomy
  if (!isAppend && schema.tags && Array.isArray(tags)) {
    const unknown = tags.filter((t) => !schema.tags.has(t));
    if (unknown.length) {
      errors.push(
        `Unknown tag(s): ${unknown.map((t) => `"${t}"`).join(', ')}. ` +
        `Add to SCHEMA.md tag taxonomy first, or use an existing tag. ` +
        `Known: ${[...schema.tags].slice(0, 15).join(', ')}...`
      );
    }
  }

  // Reject type:note for entity-kind-tagged pages
  if (!isAppend && type === 'note' && Array.isArray(tags)) {
    const entityKindMatch = tags.find((t) => ENTITY_KIND_TAGS.has(t));
    if (entityKindMatch) {
      errors.push(
        `Page is tagged "${entityKindMatch}" — use type=entity, not type=note. ` +
        `(See SCHEMA.md page types table.)`
      );
    }
  }

  // synthesis requires derived_from with ≥2 entries
  if (!isAppend && type === 'synthesis') {
    const df = Array.isArray(derivedFrom) ? derivedFrom : (typeof derivedFrom === 'string' && derivedFrom ? derivedFrom.split(',').map((s) => s.trim()).filter(Boolean) : []);
    if (df.length < 2) {
      errors.push(`type=synthesis requires --derived_from with at least 2 slugs (the atomic pages this synthesis is built from).`);
    }
  }

  // decision requires decided_on
  // (skipped here — handled by warning in lint, not hard-rejected, to keep flow flexible)

  return errors;
}

// Strict body+frontmatter validators (run on full intended page content).
// Returns array of {rule, message, fix?} error objects.
// Thin wrapper over ./lib/ingest.js's validateBody — fetches schema +
// knownVerbs from the live SCHEMA.md and delegates to the pure core.
// HR-OOB-B: when STRICT_CROSS_PAGE_RULES is non-empty, builds a vault
// snapshot lazily (cached) and passes it as allPages so cross-page strict
// rules can fire. Writes invalidate the cache via invalidatePageCache().
function validateBody(args) {
  const schema = loadSchema();
  const knownVerbs = knownRelationVerbs(schema);
  const deps = { schema, knownVerbs };
  if (STRICT_CROSS_PAGE_RULES.length > 0) {
    deps.allPages = buildAllPagesSnapshot();
  }
  return _validateBody(args, deps);
}

function buildAllPagesSnapshot() {
  const pages = [];
  forEachPage(({ slug, fm, body }) => {
    pages.push({
      slug,
      fm,
      body,
      type: fm.type || 'note',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      title: String(fm.title || slug),
    });
  }, { cache: true });
  return pages;
}

// Print soft hints (stderr, non-blocking) for sentence-like hooks. Accepts a
// comma-string (from --hooks) or an array (from ingest specs).
function warnHooks(hooks, vocab) {
  const list = typeof hooks === 'string'
    ? hooks.split(',').map((s) => s.trim()).filter(Boolean)
    : (Array.isArray(hooks) ? hooks : []);
  for (const w of hookWarnings(list, vocab)) console.error(`[hint] ${w}`);
}

module.exports = { validateForWrite, validateBody, buildAllPagesSnapshot, warnHooks };
