// schema.js — closed-set vocabulary for the vault contract, plus the parser
// that lifts that vocabulary out of SCHEMA.md at runtime.
//
// Exports: KNOWN_TYPES, ENTITY_KIND_TAGS, STALE_THRESHOLDS, STALE_DEFAULT_DAYS,
//          SLUG_RE, validSlug, isReserved, parseSchemaContent, loadSchema,
//          knownRelationVerbs.
//
// parseSchemaContent is pure (string → object). loadSchema layers a file read
// on top. The rest are constants or pure predicates. Safe to require() from
// unit tests; only loadSchema touches fs.

'use strict';

const fs = require('node:fs');

// ─── closed-set constants ──────────────────────────────────────────────────

const KNOWN_TYPES = new Set(['entity', 'concept', 'decision', 'source', 'synthesis', 'todo', 'note', 'event']);
const ENTITY_KIND_TAGS = new Set(['person', 'org', 'tool', 'paper', 'media']);

const STALE_THRESHOLDS = [
  { days: 180, tags: ['paper', 'tool', 'research', 'reading'] },
  { days: 365, tags: ['project', 'recurring', 'meta'] },
  { days: 730, tags: ['person', 'org', 'family', 'health', 'principle', 'decision'] },
];
const STALE_DEFAULT_DAYS = 365;

// ─── slug helpers ──────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const validSlug = (s) => SLUG_RE.test(s);
const isReserved = (slug) => slug === 'index' || slug === 'log';

// ─── SCHEMA.md parser ──────────────────────────────────────────────────────

// Pure: given the text contents of a SCHEMA.md, return the closed-set
// vocabulary the CLI enforces. Returns the same shape loadSchema returns
// when SCHEMA.md is missing — caller can rely on `tags` being null vs Set
// to distinguish "no schema configured" from "schema declares no tags."
function parseSchemaContent(content) {
  if (typeof content !== 'string' || content.length === 0) {
    // Match the empty-shape that bin/wiki's loadSchema returned pre-extraction
    // when SCHEMA.md was missing. Callers handle tags===null as "no schema."
    return { tags: null, forbidden: new Set(), symmetric: new Set(), inverses: new Map() };
  }

  let tags = null;
  const tagM = content.match(/##\s+Tag taxonomy[\s\S]*?```\s*([\s\S]*?)```/);
  if (tagM) {
    const tokens = tagM[1].split(/\s+/).map((s) => s.trim())
      .filter((s) => s && /^[a-z][a-z0-9_-]*$/.test(s));
    tags = new Set(tokens);
  }

  let forbidden = new Set();
  const fbM = content.match(/##\s+Forbidden aggregator slugs[\s\S]*?```\s*([\s\S]*?)```/);
  if (fbM) {
    const tokens = fbM[1].split(/\s+/).map((s) => s.trim())
      .filter((s) => s && /^[a-z][a-z0-9_-]*$/.test(s));
    forbidden = new Set(tokens);
  }

  let symmetric = new Set();
  const symM = content.match(/###\s+Symmetric[\s\S]*?```\s*([\s\S]*?)```/);
  if (symM) {
    const tokens = symM[1].split(/\s+/).map((s) => s.trim())
      .filter((s) => s && /^[a-z][a-z_]+$/.test(s));
    symmetric = new Set(tokens);
  }

  // Inverse pairs: code block under "### Inverse pairs", two verbs per line.
  // Map is bidirectional: a -> b AND b -> a.
  const inverses = new Map();
  const invM = content.match(/###\s+Inverse pairs[\s\S]*?```\s*([\s\S]*?)```/);
  if (invM) {
    for (const line of invM[1].split('\n')) {
      const parts = line.trim().split(/\s+/).filter(Boolean);
      if (parts.length !== 2) continue;
      const [a, b] = parts;
      if (!/^[a-z][a-z_]+$/.test(a) || !/^[a-z][a-z_]+$/.test(b)) continue;
      inverses.set(a, b);
    }
  }

  let oneWay = new Set();
  const owM = content.match(/###\s+One-way verbs[\s\S]*?```\s*([\s\S]*?)```/);
  if (owM) {
    const tokens = owM[1].split(/\s+/).map((s) => s.trim())
      .filter((s) => s && /^[a-z][a-z_]+$/.test(s));
    oneWay = new Set(tokens);
  }

  let eventKeywords = new Set();
  const ekM = content.match(/##\s+Event-keyword title regex[\s\S]*?```\s*([\s\S]*?)```/);
  if (ekM) {
    const tokens = ekM[1].split(/\s+/).map((s) => s.trim().toLowerCase())
      .filter((s) => s && /^[a-z][a-z-]+$/.test(s));
    eventKeywords = new Set(tokens);
  }

  return { tags, forbidden, symmetric, inverses, oneWay, eventKeywords };
}

// File-reading wrapper. Returns the same shape as parseSchemaContent. If the
// path doesn't exist, returns an empty-schema sentinel (tags === null), which
// callers interpret as "no schema configured — accept everything." See
// validateForWrite for how that fallback is handled.
function loadSchema(schemaPath) {
  if (!fs.existsSync(schemaPath)) {
    return { tags: null, forbidden: new Set(), symmetric: new Set(), inverses: new Map() };
  }
  return parseSchemaContent(fs.readFileSync(schemaPath, 'utf-8'));
}

// Combined set of all legitimate relation verbs (used for invented-verb
// detection in validation paths).
function knownRelationVerbs(schema) {
  const all = new Set();
  for (const v of schema.symmetric) all.add(v);
  for (const v of schema.oneWay) all.add(v);
  for (const [a, b] of schema.inverses) { all.add(a); all.add(b); }
  return all;
}

module.exports = {
  KNOWN_TYPES,
  ENTITY_KIND_TAGS,
  STALE_THRESHOLDS,
  STALE_DEFAULT_DAYS,
  SLUG_RE,
  validSlug,
  isReserved,
  parseSchemaContent,
  loadSchema,
  knownRelationVerbs,
};
