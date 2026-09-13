// commands/sql.js — `wiki sql`: run SQL against the DuckDB analytical view.
//
// Read-only. Delegates to the duckdb binary; the three tables (vault,
// observations, relations) are materialized by lib/duckdb.js. Output modes:
// box-drawing table (default), --tsv / --csv / --json (machine-parseable),
// --schema (DESCRIBE + column gloss), --explore (open the REPL).

'use strict';

const { loadVaultDb, ensureDuckdbAvailable, resolveDuckdbBin } = require('../lib/duckdb.js');

function cmdSql(args) {
  const { spawnSync } = require('child_process');
  ensureDuckdbAvailable();
  const dbPath = loadVaultDb();

  if (args.schema) {
    console.log("Three tables. Columns:");
    for (const t of ['vault', 'observations', 'relations']) {
      console.log(`\n--- ${t} ---`);
      spawnSync(resolveDuckdbBin(), ['-readonly', dbPath, '-c', `DESCRIBE ${t};`], { stdio: 'inherit' });
    }
    console.log('\nNotes:');
    console.log('  - `vault`: one row per page (slug, type, tags, frontmatter fields, n_* counts).');
    console.log('  - `observations`: one row per categorized body bullet ([fact]/[hypothesis]/[prediction]/etc).');
    console.log('  - `relations`: one row per "- verb [[target]]" typed relation.');
    console.log('  - Joins: observations.slug = vault.slug; relations.slug = vault.slug; relations.target = vault.slug.');
    console.log('');
    console.log('Column semantics worth knowing:');
    console.log('  - vault.when_         renamed from `when` frontmatter (SQL reserves `when`).');
    console.log('  - vault.confidence    page-level "how sure am I this page is right" (0..1).');
    console.log('  - vault.sensitive     true → assistant must exclude from any LLM context (CLI does not enforce).');
    console.log('  - vault.n_*           denormalized counts; derivable from observations table, kept for cheap WHERE.');
    console.log('  - observations.id          6-char base36 handle minted at write time (<!--obs:XXXXXX--> marker).');
    console.log('  - observations.obs_uid     monotonic row counter; the FTS index unique key (not user-facing).');
    console.log('  - observations.by_date     [by YYYY-MM-DD] resolution date for predictions (and any other observation).');
    console.log('  - observations.confidence  [confidence: 0..1] inline tag, primarily for [prediction] rows.');
    console.log('  - observations.superseded  true when the bullet is wrapped in ~~ strikethrough.');
    console.log('  - observations.supersede_reason  [reason: token] explaining why a superseded row retired.');
    console.log('  - observations.replaced_by       VARCHAR[] handles from [replaced_by: ...].');
    console.log('');
    console.log('BM25 full-text search:');
    console.log('  SELECT slug, fts_main_observations.match_bm25(obs_uid, \'query\') AS score');
    console.log('  FROM observations WHERE score IS NOT NULL ORDER BY score DESC LIMIT 10;');
    return;
  }
  if (args.explore) {
    console.error(`(opening DuckDB REPL on ${dbPath}; three tables: vault, observations, relations)`);
    spawnSync(resolveDuckdbBin(), ['-readonly', dbPath], { stdio: 'inherit' });
    return;
  }
  const query = args._.length ? args._.join(' ') : '';
  if (!query) {
    console.error('Usage:');
    console.error('  wiki sql "<query>"            run query, print as table');
    console.error('  wiki sql "<query>" --tsv      tab-separated (no box-drawing) — easy to parse');
    console.error('  wiki sql "<query>" --csv      comma-separated');
    console.error('  wiki sql "<query>" --json     JSON array of row objects');
    console.error('  wiki sql --schema             DESCRIBE all three tables + column gloss');
    console.error('  wiki sql --explore            open the DuckDB REPL on the DB');
    process.exit(1);
  }
  // F1: machine-parseable output modes. The default box-drawing table has
  // borders, a truncation footer ("40 shown") and `·` ellipsis rows that break
  // naive grep/awk parsing of scalars. --tsv/--csv/--json stream all rows with
  // no decoration.
  let modeArgs = [];
  if (args.json) modeArgs = ['-json'];
  else if (args.csv) modeArgs = ['-csv'];
  else if (args.tsv) modeArgs = ['-c', '.mode tabs'];
  const res = spawnSync(resolveDuckdbBin(), ['-readonly', dbPath, ...modeArgs, '-c', query], { stdio: 'inherit' });
  process.exit(res.status || 0);
}

module.exports = { cmdSql };
