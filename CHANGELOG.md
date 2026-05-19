# Changelog

All notable changes to alfred_assistant are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Persona (Phase 11 — mission + reflex 1 verbs)
- New top-level `## Mission — why this vault exists` section (~170 words) inserted between the atomicity rule and the operating loop. Five commitments make alfred's purpose explicit: (1) push back don't mirror, (2) find connections via `wiki related --unconnected` + `wiki unlinked-mentions`, (3) calibrate predictions via supersede, (4) organize life through one graph, (5) support introspection (sensitive pages, IFS proactive trigger). Sets the WHY before the operating loop sets the HOW.
- Updated Reflex 1: renamed to "Search before answering, surface connections after". After answering topical questions, alfred runs `wiki related <slug> --unconnected` and `wiki unlinked-mentions <slug>` and surfaces 1-2 non-obvious hits in one line.
- Deleted now-redundant `### Mission notes — what the vault is for` subsection (its substance is absorbed into the new top-level Mission with cleaner framing).
- Net persona delta: +120 words (7181 → 7301). Persona-lint clean. The published template uses `{{USER_NAME}}` placeholders; deploy.sh renders into target vaults with per-vault personalisation preserved.

### Added (Phase 11 — connection-finding)
- **`wiki related <slug> --unconnected`** — zk-style "shared-neighbor, not yet connected" filter. Without the flag the existing scoring boosts already-linked pages; with it, those are *excluded*, surfacing only candidates worth a new wikilink/relation. Operationalises Reflex 1's connection-finding trigger deterministically (no embeddings).
- **`wiki unlinked-mentions <slug>`** — find pages whose body mentions `<slug>`'s title or aliases (word-boundary, length ≥4) but lacks a `[[wikilink]]`. Read-only discovery sibling to `wiki autolink --dry-run`. Surfaces graph-density promotion opportunities so Alfred can ask "promote to wikilink?" at conversation time.
- **Boolean tag filter on `wiki search`** — `--tag "X OR Y, NOT Z"` syntax. Comma = AND between clauses; `OR` within a clause; `NOT` excludes. Pure parser in new `bin/lib/tag-filter.js` (16 unit tests covering grammar, validation, SQL compilation, custom column). Single-tag back-compat preserved.
- New `stdoutNotContains` assertion in `bin/wiki-test` runner.

### Persona (Phase 10)
- New top-level `## Operating loop` section in `PERSONA.template.md`: three reflexes (search before answering, volunteer captures at breakpoints, surface contradictions before proposing) hoisted above the ingestion protocol. Closes a measured ~100% capture-leak rate observed over a 2-day audit window of live conversations (May 18-19, 2026). Pure persona change, no CLI work.
- Deleted overlapping `### Retrieval reflexes` subsection (absorbed into Reflex 1). The previous "ONLY IF BM25 >= 1.0 AND ..." conjunction gave the LLM permission to skip both search and surfacing; new section separates *always search* from *conditionally surface* with no hedge conjunction. Obs-id citation convention preserved at the bottom of the boundary-rules subsection.
- Trimmed `### Red-teaming — wiki challenge` to a 2-line cross-reference of Reflex 3 (same goal, broader trigger).
- Net persona length change: **−53 words** (7234 → 7181). Persona-lint clean.
- New `tools/audit-conversation-leak.md`: parameterized subagent prompt for re-measuring leak rate after persona changes. Manual rerun only.

### Added (Phase 9)
- **`wiki capture <slug> "<utterance>"`** — classify-and-route verb. Deterministic shape lexicon (regex-based, no NLP) maps utterance shape to category + confidence + date, then delegates to `cmdPatch` for the actual write. Reduces LLM judgment load: Alfred passes faithful user speech, the classifier picks the category. Refuses on ambiguity, prediction-without-date, or bracket-in-body. Override via `--as <category>` when classifier and agent disagree.
- New pure module `bin/lib/capture-classifier.js` covering question, decision, claim (with source extraction), prediction (with date + confidence inference), hypothesis, opinion, idea, and fact-fallback. 27 unit tests cover each shape, confidence inference, date extraction, precedence resolution, refusal modes, and roundtrip through `parseObservations`.
- Three "boundary rules" subsection in `PERSONA.template.md`: preserve hedges verbatim, decompose multi-clause turns, inject third-party attribution. These are the agent's contract with the classifier.
- `speculative-shape-fact` audit rule now imports its lexicon (`FUTURE_TENSE_RE`, `EPISTEMIC_RE`) from `capture-classifier.js`. Single source of truth for shape vocabulary across detection and routing.

### Fixed (Phase 8.1)
- **`--soft` no longer bypasses ironclad schema-vocabulary rules.** `uncategorized-bullets` (unknown `[category]` prefix) and `invented-verb` (unknown relation verb) now flag with `ironclad: true` and are checked in `cmdWrite` / `cmdPatch` BEFORE the `--soft` short-circuit. Previously, `wiki patch <slug> --observation "[issue] ..." --soft` would silently land an unparseable line (observed in `_AI_box`). New module export `ironcladRuleErrors`; error message stream changed from `error: validation failed for <slug>` to `error: ironclad validation failed for <slug> (... --soft does NOT bypass)`.

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
