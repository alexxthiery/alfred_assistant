// frontmatter.js — pure helpers for the wiki page frontmatter contract.
//
// Exports: parseFrontmatter, serializeFrontmatter, migratePage,
//          CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS.
//
// No fs, no process, no other globals. Safe to require() from unit tests.
// The shape of the parsed object and the serializer's field ordering form
// the stable contract documented in docs/SCHEMA.md under "Stable frontmatter
// contract" and "Frontmatter ordering."

'use strict';

// Bump when the wiki page schema (frontmatter shape or body conventions) changes
// in a way that older pages can't be read cleanly. Each entry transforms a page
// from version N to N+1. `wiki migrate` walks all pages and applies pending
// transforms. Pages without a schema_version field are treated as v1 (the shape
// at the time this versioning was introduced - H07).
const CURRENT_SCHEMA_VERSION = 1;
const SCHEMA_MIGRATIONS = {
  // Example for future use:
  // 1: ({ fm, body }) => { fm.someNewField = []; return { fm, body }; },  // 1 → 2
};

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    // HR06: distinguish "no frontmatter at all" (legal: bare-body page) from
    // "frontmatter started but never closed" (data hazard: a write-path
    // caller that re-serializes silently drops the original metadata). The
    // marker is "content starts with --- and a newline" — if it does and we
    // failed to match, we have an opened-but-never-closed block. See
    // audit/12 § parser-robustness.
    const malformed = /^---\r?\n/.test(content);
    return { fm: {}, body: content, malformed };
  }
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1];
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }
    fm[k] = v;
  }
  return { fm, body: m[2], malformed: false };
}

function serializeFrontmatter(fm, body) {
  // Stamp schema_version on every write. Invariant: any page the CLI writes
  // carries the version it was written under, so `wiki migrate` knows what
  // transforms to apply later. Pre-versioning pages (missing the field) are
  // treated as v1 by the migration walker.
  if (fm.schema_version == null) fm.schema_version = CURRENT_SCHEMA_VERSION;
  const ordered = ['id', 'title', 'type', 'created', 'updated', 'tags', 'schema_version'];
  const lines = ['---'];
  for (const k of ordered) {
    if (!(k in fm)) continue;
    const v = fm[k];
    lines.push(Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(fm)) {
    if (ordered.includes(k)) continue;
    lines.push(Array.isArray(v) ? `${k}: [${v.join(', ')}]` : `${k}: ${v}`);
  }
  lines.push('---');
  // Body: strip leading newlines (parseFrontmatter may leave one) AND trailing
  // whitespace, then re-append exactly one newline if body is non-empty.
  // Prevents trailing blank lines from accumulating across patch operations
  // (every patch re-serializes the file; without trimming, slack compounds).
  const trimmedBody = body.replace(/^\n+/, '').replace(/\s*$/, '');
  const normalizedBody = trimmedBody ? trimmedBody + '\n' : '';
  return lines.join('\n') + '\n' + normalizedBody;
}

// Apply migrations to a single parsed page. Returns { fm, body, fromVersion, toVersion }
// where fromVersion is the page's pre-migration version (missing field → 1), and
// toVersion is the target currentVersion. Throws if fromVersion > current (with
// .code='NEWER_CLI'), or if a needed migration is missing.
//
// HR08: accepts explicit `opts.currentVersion` and `opts.migrations` overrides so
// unit tests can exercise the full migration chain without bumping the module's
// CURRENT_SCHEMA_VERSION constant. Production callers (cmdMigrate) pass no opts;
// behavior is unchanged.
function migratePage(fm, body, opts = {}) {
  const currentVersion = opts.currentVersion != null ? opts.currentVersion : CURRENT_SCHEMA_VERSION;
  const migrations = opts.migrations || SCHEMA_MIGRATIONS;
  const fromVersion = fm.schema_version == null ? 1 : Number(fm.schema_version);
  if (!Number.isFinite(fromVersion) || fromVersion < 1) {
    throw new Error(`bad schema_version: ${fm.schema_version}`);
  }
  if (fromVersion > currentVersion) {
    const err = new Error(`schema_version ${fromVersion} > current ${currentVersion} (page written by a newer CLI)`);
    err.code = 'NEWER_CLI';
    throw err;
  }
  let v = fromVersion;
  let curFm = fm;
  let curBody = body;
  while (v < currentVersion) {
    const xform = migrations[v];
    if (!xform) {
      throw new Error(`no migration registered for schema_version ${v} → ${v + 1}`);
    }
    const out = xform({ fm: curFm, body: curBody });
    curFm = out.fm;
    curBody = out.body;
    v++;
  }
  curFm.schema_version = currentVersion;
  return { fm: curFm, body: curBody, fromVersion, toVersion: currentVersion };
}

module.exports = {
  parseFrontmatter,
  serializeFrontmatter,
  migratePage,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
};
