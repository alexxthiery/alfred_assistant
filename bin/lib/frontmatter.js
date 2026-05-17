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
  if (!m) return { fm: {}, body: content };
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
  return { fm, body: m[2] };
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
  return lines.join('\n') + '\n' + body.replace(/^\n+/, '');
}

// Apply SCHEMA_MIGRATIONS to a single parsed page. Returns { fm, body, fromVersion, toVersion }
// where fromVersion is the page's pre-migration version (missing field → 1), and
// toVersion is CURRENT_SCHEMA_VERSION (or the highest reachable version if a transform
// fails). Throws if fromVersion > CURRENT (with .code='NEWER_CLI').
function migratePage(fm, body) {
  const fromVersion = fm.schema_version == null ? 1 : Number(fm.schema_version);
  if (!Number.isFinite(fromVersion) || fromVersion < 1) {
    throw new Error(`bad schema_version: ${fm.schema_version}`);
  }
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    const err = new Error(`schema_version ${fromVersion} > current ${CURRENT_SCHEMA_VERSION} (page written by a newer CLI)`);
    err.code = 'NEWER_CLI';
    throw err;
  }
  let v = fromVersion;
  let curFm = fm;
  let curBody = body;
  while (v < CURRENT_SCHEMA_VERSION) {
    const xform = SCHEMA_MIGRATIONS[v];
    if (!xform) {
      throw new Error(`no migration registered for schema_version ${v} → ${v + 1}`);
    }
    const out = xform({ fm: curFm, body: curBody });
    curFm = out.fm;
    curBody = out.body;
    v++;
  }
  curFm.schema_version = CURRENT_SCHEMA_VERSION;
  return { fm: curFm, body: curBody, fromVersion, toVersion: CURRENT_SCHEMA_VERSION };
}

module.exports = {
  parseFrontmatter,
  serializeFrontmatter,
  migratePage,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
};
