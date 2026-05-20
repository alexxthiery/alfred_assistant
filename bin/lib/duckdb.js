// duckdb.js — vault analytical view backed by DuckDB.
//
// Rebuilds `.cache/vault.duckdb` lazily when any wiki/*.md is newer than the
// DB, or when the persisted SNAPSHOT_SCHEMA_VERSION sidecar disagrees with
// the constant baked into the CLI. Three tables (vault / observations /
// relations) come from NDJSON files written atomically alongside the DB.
//
// Centralised here so `wiki sql`, `wiki search` (BM25), and future verbs like
// `wiki render` (saved queries) share the same cache + bootstrap path.
//
// Why an `obs_uid` synthetic column: DuckDB's FTS requires a UNIQUE key. The
// user-facing `id` (6-char base36) is probabilistically unique, not strict —
// fine as a human handle but not safe as a SQL index key. `obs_uid` is a
// monotonic row counter added at CREATE TABLE time; `id` stays as the stable
// user-facing identifier.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { detectVaultRoot } = require('./vault-root.js');
const { listWikiPages, forEachPage } = require('./vault.js');
const { parseObservations, parseRelations, extractWikilinks } = require('./graph.js');

const VAULT_ROOT = detectVaultRoot();
const WIKI_DIR = path.join(VAULT_ROOT, 'wiki');

// Resolve the duckdb binary once and reuse across loadVaultDb / probe / etc.
// Order: $DUCKDB_BIN override → bare `duckdb` on PATH → well-known install
// locations. Some agent harnesses (and some shells started without a login
// rc) invoke node with a stripped PATH that omits /opt/homebrew/bin or
// /usr/local/bin, so a host-installed duckdb is invisible to spawnSync.
// Falling back to known absolute paths makes the CLI robust to that.
let _duckdbBinCached = null;
function resolveDuckdbBin() {
  if (_duckdbBinCached) return _duckdbBinCached;
  const candidates = [
    process.env.DUCKDB_BIN,
    'duckdb',
    '/opt/homebrew/bin/duckdb',
    '/usr/local/bin/duckdb',
    '/opt/local/bin/duckdb',
    '/usr/bin/duckdb',
  ].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-version'], { stdio: 'pipe' });
    if (!r.error && r.status === 0) {
      _duckdbBinCached = bin;
      return bin;
    }
  }
  return null;
}

const CACHE_DIR = path.join(VAULT_ROOT, '.cache');
const DB_PATH = path.join(CACHE_DIR, 'vault.duckdb');
const DB_NDJSON_PATH = path.join(CACHE_DIR, 'vault.ndjson');
const OBS_NDJSON_PATH = path.join(CACHE_DIR, 'observations.ndjson');
const REL_NDJSON_PATH = path.join(CACHE_DIR, 'relations.ndjson');
const SNAPSHOT_SCHEMA_PATH = path.join(CACHE_DIR, '.snapshot-schema');

// Bump SNAPSHOT_SCHEMA_VERSION whenever the column shape of any NDJSON file
// changes (new column, removed column, renamed column). loadVaultDb compares
// it to the value persisted on disk and forces rebuild on mismatch, so a CLI
// upgrade automatically refreshes stale .duckdb files without manual
// intervention.
const SNAPSHOT_SCHEMA_VERSION = 'v3-2026-05-19-fts'; // bumped: observations.id added + BM25 FTS index on observations.body

function buildVaultNdjson() {
  // mention_count = distinct inbound wikilinks per source page (graph edges),
  // via the shared extractWikilinks (deduped per page). Reuses graph.js so the
  // slug pattern can't drift from the rest of the system.
  const mentions = new Map();
  const pages = [];
  const obsRows = [];
  const relRows = [];
  const arr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
  forEachPage(({ slug, fm, body }) => {
    const obs = parseObservations(body);
    const rels = parseRelations(body);
    const counts = { fact: 0, hypothesis: 0, opinion: 0, claim: 0, prediction: 0, question: 0, decision: 0, todo: 0, idea: 0, quote: 0 };
    for (const o of obs) if (counts[o.category] !== undefined) counts[o.category]++;
    for (const o of obs) {
      obsRows.push({
        slug,
        id: o.id || null,
        category: o.category,
        body: o.body,
        superseded: !!o.superseded,
        since: o.dates && o.dates.since || null,
        until: o.dates && o.dates.until || null,
        as_of: o.dates && o.dates.asOf || null,
        on_date: o.dates && o.dates.on || null,
        by_date: o.dates && o.dates.by || null,
        confidence: typeof o.confidence === 'number' ? o.confidence : null,
        provenance: arr(o.provenance),
      });
    }
    for (const r of rels) {
      relRows.push({ slug, verb: r.verb, target: r.target });
    }
    for (const target of extractWikilinks(body)) {
      if (target !== slug) mentions.set(target, (mentions.get(target) || 0) + 1);
    }
    pages.push({
      slug,
      title: String(fm.title || ''),
      type: String(fm.type || 'note'),
      created: fm.created || null,
      updated: fm.updated || null,
      tags: arr(fm.tags),
      aliases: arr(fm.aliases),
      n_facts: counts.fact,
      n_hypotheses: counts.hypothesis,
      n_opinions: counts.opinion,
      n_claims: counts.claim,
      n_predictions: counts.prediction,
      n_questions: counts.question,
      n_relations: rels.length,
      raw_path: fm.raw_path || null,
      decided_on: fm.decided_on || null,
      supersedes: arr(fm.supersedes),
      derived_from: arr(fm.derived_from),
      source_file: fm.source_file || null,
      status: fm.status || null,
      due: fm.due || null,
      when_: fm.when || null,  // `when` is a SQL reserved word in some contexts
      born: fm.born || null,
      visibility: fm.visibility || null,
      sensitive: fm.sensitive === true || fm.sensitive === 'true' ? true : false,
      confidence: fm.confidence != null && fm.confidence !== '' ? Number(fm.confidence) : null,
      body_chars: body ? body.length : 0,
    });
  });
  for (const p of pages) p.mention_count = mentions.get(p.slug) || 0;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Atomic write: temp file → fsync-ish (writeFileSync is synchronous) → rename.
  // Prevents a concurrent reader from seeing an internally-inconsistent
  // snapshot (e.g. fresh pages but stale observations).
  const atomicWrite = (finalPath, content) => {
    const tmp = `${finalPath}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, finalPath);
  };
  atomicWrite(DB_NDJSON_PATH, pages.map((p) => JSON.stringify(p)).join('\n') + '\n');
  atomicWrite(OBS_NDJSON_PATH, obsRows.map((o) => JSON.stringify(o)).join('\n') + (obsRows.length ? '\n' : ''));
  atomicWrite(REL_NDJSON_PATH, relRows.map((r) => JSON.stringify(r)).join('\n') + (relRows.length ? '\n' : ''));
  return { pages: pages.length, observations: obsRows.length, relations: relRows.length };
}

function loadVaultDb() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let needRebuild = !fs.existsSync(DB_PATH);
  if (!needRebuild) {
    // Schema-version sidecar: if the recorded version doesn't match the
    // current SNAPSHOT_SCHEMA_VERSION, the .duckdb has the old column shape
    // and a query against a new column would error. Force rebuild.
    const recorded = fs.existsSync(SNAPSHOT_SCHEMA_PATH)
      ? fs.readFileSync(SNAPSHOT_SCHEMA_PATH, 'utf-8').trim()
      : '';
    if (recorded !== SNAPSHOT_SCHEMA_VERSION) needRebuild = true;
  }
  if (!needRebuild) {
    const dbMtime = fs.statSync(DB_PATH).mtimeMs;
    for (const f of listWikiPages()) {
      if (fs.statSync(path.join(WIKI_DIR, f)).mtimeMs > dbMtime) { needRebuild = true; break; }
    }
  }
  if (!needRebuild) return DB_PATH;

  const counts = buildVaultNdjson();
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  // SQL is piped via stdin (one statement per line) rather than passed as a
  // single argv blob: DuckDB's argv-form batch-parses the whole string before
  // execution, so a later PRAGMA referencing a CREATE-TABLE-in-the-same-batch
  // would fail catalog lookup. stdin processes each line as its own batch.
  const esc = (p) => p.replace(/'/g, "''");
  const sql = [
    "INSTALL fts; LOAD fts;",
    `CREATE TABLE vault AS SELECT * FROM read_json_auto('${esc(DB_NDJSON_PATH)}', format='newline_delimited');`,
    // Pin the nullable date columns to VARCHAR. read_json_auto infers a column
    // as JSON (not VARCHAR) when every row is null — e.g. a vault with no dated
    // observations — which then breaks `WHERE on_date = '...'` comparisons. The
    // `* REPLACE (TRY_CAST(...))` forces VARCHAR regardless of data, so query
    // sites never need a per-call CAST. TRY_CAST yields NULL (not the string
    // 'null') for JSON-null, preserving correct filtering on all-null vaults.
    `CREATE TABLE observations AS SELECT row_number() OVER () AS obs_uid, * REPLACE (TRY_CAST(since AS VARCHAR) AS since, TRY_CAST(until AS VARCHAR) AS until, TRY_CAST(as_of AS VARCHAR) AS as_of, TRY_CAST(on_date AS VARCHAR) AS on_date, TRY_CAST(by_date AS VARCHAR) AS by_date) FROM read_json_auto('${esc(OBS_NDJSON_PATH)}', format='newline_delimited');`,
    `CREATE TABLE relations AS SELECT * FROM read_json_auto('${esc(REL_NDJSON_PATH)}', format='newline_delimited');`,
    "CREATE INDEX vault_slug ON vault(slug);",
    "CREATE INDEX observations_slug ON observations(slug);",
    "CREATE INDEX observations_id ON observations(id);",
    "CREATE INDEX relations_slug ON relations(slug);",
    "CREATE INDEX relations_target ON relations(target);",
    "PRAGMA create_fts_index('observations', 'obs_uid', 'body', stemmer='english', stopwords='english', overwrite=1);",
  ].join('\n');
  const bin = resolveDuckdbBin();
  if (!bin) {
    console.error('error: duckdb binary not found. Tried $DUCKDB_BIN, `duckdb` on PATH, and /opt/homebrew/bin, /usr/local/bin, /opt/local/bin, /usr/bin.');
    console.error('  If installed: set DUCKDB_BIN=/full/path/to/duckdb. Otherwise: `brew install duckdb` (host) or apt-install (container).');
    process.exit(2);
  }
  const r = spawnSync(bin, [DB_PATH], { input: sql, encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    const msg = (r.stderr || '').split('\n')[0] || (r.error && r.error.message) || `exit ${r.status}`;
    console.error(`error: failed to build DuckDB at ${DB_PATH}: ${msg}`);
    process.exit(2);
  }
  fs.writeFileSync(SNAPSHOT_SCHEMA_PATH, SNAPSHOT_SCHEMA_VERSION + '\n');
  console.error(`(rebuilt vault.duckdb: ${counts.pages} pages, ${counts.observations} observations, ${counts.relations} relations)`);
  return DB_PATH;
}

// Verify the duckdb binary is on PATH; abort with a clear hint otherwise.
// Shared so `wiki sql`, `wiki search` (BM25 mode), and `wiki render` all
// surface the same install message.
function ensureDuckdbAvailable() {
  // Resolves via PATH first, then well-known install paths. Caches.
  // Distinguishes "not on PATH but installed" from "actually missing"
  // because a subprocess with a stripped PATH (some agent harnesses) is
  // a common case and the previous message led agents to mis-diagnose
  // installed-but-invisible as not-installed.
  if (resolveDuckdbBin()) return;
  console.error('error: duckdb binary not found. Tried $DUCKDB_BIN, `duckdb` on PATH, and /opt/homebrew/bin, /usr/local/bin, /opt/local/bin, /usr/bin.');
  console.error('  If installed: set DUCKDB_BIN=/full/path/to/duckdb. Otherwise: `brew install duckdb` (host) or apt-install (container).');
  process.exit(2);
}

module.exports = {
  CACHE_DIR,
  DB_PATH,
  DB_NDJSON_PATH,
  OBS_NDJSON_PATH,
  REL_NDJSON_PATH,
  SNAPSHOT_SCHEMA_PATH,
  SNAPSHOT_SCHEMA_VERSION,
  buildVaultNdjson,
  loadVaultDb,
  ensureDuckdbAvailable,
  resolveDuckdbBin,
};
