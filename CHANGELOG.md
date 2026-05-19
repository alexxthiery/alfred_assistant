# Changelog

All notable changes to alfred_assistant are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (Phase 8)
- **`wiki predict <slug> "..." --by YYYY-MM-DD [--confidence N]`** and **`wiki hypothesize <slug> "..." [--confidence N]`** — low-friction verbs that wrap `wiki patch --observation` with auto-constructed lines, default provenance, and confidence-bounded validation. New pure module `bin/lib/epistemic-verbs.js` (unit-testable line builders).
- **Advisory audit rule `speculative-shape-fact`**: flags `[fact]` lines starting with future-tense ("will", "going to") or epistemic-uncertainty ("might", "I think", "likely") shape words; suggests `[prediction]` or `[hypothesis]` conversion. Surfaced via `wiki audit --all`, not blocking. Run on `_AI_box` after install to triage existing facts.

### Changed (Phase 8)
- **`wiki search --tag X --limit N`**: tag filter now runs server-side (`list_contains(v.tags, 'X')` in the SQL WHERE), so LIMIT applies after the tag filter. Previously the JS-side post-pass silently undercounted (e.g., `--limit 3 --tag person` could return 1 when 24 matches existed). Correctness bug fix.

### Persona (Phase 8)
- New **"Retrieval reflexes"** section in `PERSONA.template.md` operationalizes smart-trigger proactive retrieval: query the vault before answering topical questions, surface results only when substantive (BM25 ≥ 1.0 AND contradicts training-data answer OR is non-obvious). Push-back, connection-finding, and obs-id citation patterns documented.
- New **"Epistemic discipline during ingest"** section with a routing table: when to construct `[hypothesis]` vs `[prediction]` vs `[fact]` based on the shape of user input. Promotes the new verbs.
- Anti-patterns mini-table; chained-workflow example; realistic Layer-1 example.

### Added
- **Stable observation IDs** (`<!--obs:XXXXXX-->` markers). Every categorized observation line gains a 6-char base36 marker minted at write time, idempotent across rewrites. Surfaced in `observations.id`. New module `bin/lib/obsid.js`.
- **BM25 + synonyms retrieval**. `wiki search <query>` now runs DuckDB FTS over `observations.body`, ranking by BM25 with optional synonym expansion from `<vault-root>/SYNONYMS.md`. New flags: `--literal` (substring fallback), `--regex`, `--limit N`. New module `bin/lib/synonyms.js`. See `docs/SYNONYMS.example.md` for the file format.
- **`type: view` pages**. A saved DuckDB query persists as a page whose body holds a fenced ```` ```sql ```` block; `wiki render <slug>` executes it. Replaces hand-maintained aggregator pages. New audit rule `view-needs-query` advisorily flags view pages without a query block.
- **Write-time exact-duplicate refusal**. Strict audit rule `exact-duplicate-observation` rejects byte-equal (same category, same canonical body) observation duplicates on the same page. Narrow escape hatch: `--force-duplicate` on `cmdWrite` / `cmdPatch`.
- New library module `bin/lib/duckdb.js` (extracted from `bin/wiki`): centralised cache bootstrap so `wiki sql`, `wiki search`, and `wiki render` share one lazy-rebuild path.
- New verb `wiki render <slug>`.

### Changed
- **`wiki sync-ids` extended** (one-time migration step). The existing verb that aligned frontmatter `id:` with filename now ALSO mints `<!--obs:XXXXXX-->` markers on legacy observation lines in the same walk. Idempotent. Run once per vault after upgrading:
  ```
  wiki sync-ids --dry-run   # preview
  wiki sync-ids             # apply
  ```
- DuckDB snapshot schema bumped to `v3-2026-05-19-fts`: adds `observations.id` and a BM25 FTS index keyed on a synthetic `observations.obs_uid` row counter. Stale `.cache/vault.duckdb` is auto-rebuilt on first `wiki sql` after upgrade.
- `wiki sql --schema` now documents `observations.id`, `obs_uid`, and includes a BM25 query template.
- `view` added to `KNOWN_TYPES`.

### Persona
- New "Query-first retrieval" section in `docs/PERSONA.template.md`: teaches the three-layer access pattern (filter → BM25 → saved-view) and demotes `wiki print` to last-resort.

## [0.1.0] - 2026-05-17 - Initial public release

First publishable cut. The single-user vault CLI (`bin/wiki`), the raw-content
triage CLI (`bin/inbox`), the Gmail SMTP wrapper (`bin/email-digest`), and the
fixture test runner (`bin/wiki-test`) are all stable. The host-side patches for
running Alfred himself live in `docs/NANOCLAW-PATCHES.md`.

See the README for setup and `docs/SCHEMA.md` for the vault contract.
