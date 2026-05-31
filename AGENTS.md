# AGENTS.md — orientation for LLM agents working on alfred_assistant

This file is the entry point for any coding agent dropped into this repo, whatever drives it (Codex, Claude Code, Cursor, or a terminal session). Read it before reading anything else. It will not change often; the file map below tells you where to go next based on the task.

This is the provider-agnostic name (`AGENTS.md`). Claude Code is pointed here via a one-line `CLAUDE.md` that imports this file, so both conventions resolve to the same orientation.

> Two different `AGENTS.md` exist, and they do not conflict (the convention is directory-scoped):
> - **This file** (repo root) is *developer* orientation: how to change this codebase.
> - The **vault's** `AGENTS.md` is the *runtime persona*: how the assistant behaves when driving a vault. It is rendered from `docs/persona/*.template.md`; `docs/PERSONA.template.md` is the assembled compatibility aggregate. If you want runtime behavior, read the relevant fragment first.

## What this is

Single-user, self-hosted personal-knowledge agent. The "vault" is a typed graph of markdown pages with a closed-set schema; `bin/wiki` is the only writer. Everything else (the Telegram-driven LLM driver, the inbox triage, the weekly digest) flows from that single-writer constraint. Zero runtime dependencies — Node stdlib only.

The repo is *the published surface* (CLI + docs + tests). The user's actual vault lives elsewhere on their machine and is mounted into the agent container at runtime via `.alfred.yml`.

**Read `docs/PHILOSOPHY.md` once.** It states the design principles (CLI-only writes, zero deps, the vault outlives the tool, small blast radius, fail-to-safe-state, drift guards, …) that the rules in this file flow from. A change that passes every test but quietly breaks one of those principles is still a regression.

## Starting cold — which runbook?

Match your task to one of these and jump to the linked section:

- Editing or adding a verb in `bin/wiki` → **Runbook 1** below.
- Adding a closed-set tag, page type, or relation verb → **Runbook 2** below.
- Adding a fixture or smoke test → **Runbook 3** below.
- Extracting a pure helper into `bin/lib/` → **Runbook 4** below.
- Adding an audit rule → **Runbook 5** below.
- Adding or re-splitting a verb group in `bin/commands/` → **Runbook 6** below.

If your task does not fit any of these, read the file map next.

## File map (where to look, by task)

No file sizes here on purpose: they rot. The durable signal is *which file owns what*. The one rule that matters for token cost: **never read `bin/wiki` end-to-end. Open the verb's command module, or grep for the verb and read ±100 lines plus a sibling verb.**

| Path                                | When to read                                              |
|-------------------------------------|-----------------------------------------------------------|
| `AGENTS.md`                         | First. Always. (this file)                                |
| `bin/wiki`                          | The CLI entrypoint: argv parse, help rendering, the `cmds` dispatch map, tamper/auto-commit gating. Read to wire a verb, not to read a verb's logic. |
| `bin/commands/<group>.js`           | A verb's actual handler (`cmdXxx`). **All** verb logic lives here now; open the group that owns the verb (see the verb→module index below). The one exception is `persona-lint`, which stays inline in `bin/wiki` because it reads the live `cmds` map. |
| `bin/verbs/read.js`                 | Read-only verbs (`list`, `print`, `context`, ...).        |
| `bin/lib/*.js`                      | Pure / shared logic, unit-tested. `frontmatter` (parse/serialize/migration), `schema` (SCHEMA.md parsing + closed-set constants), `graph` (wikilink/observation/relation/fuzzy), `ingest` (JSON-ingest validation), `audit` (`AUDIT_RULES`), `vault` (constants + `forEachPage`), `autolink`, `flag-aliases`, `flag-spec`, `verb-metadata`, `persona-template`, `config`, plus the write-side helpers. Open the one whose name matches your concern. |
| `bin/inbox`                         | Raw-content triage.                                       |
| `bin/wiki-test`                     | The fixture runner; **assertion vocabulary lives here** (but read `tests/fixtures/README.md` first). |
| `bin/email-digest`, `bin/daily-brief` | SMTP send / morning brief.                             |
| `docs/SCHEMA.md`                    | Tag/type/verb/microsyntax questions. **The contract.**    |
| `docs/persona/*.template.md`        | Source fragments for the runtime persona. Edit these, then reassemble/check the aggregate. |
| `docs/PERSONA.template.md`          | Assembled compatibility aggregate for the runtime persona; must equal the fragments. |
| `docs/CONVENTIONS.md`               | Naming, error format, exit codes, where-things-live.      |
| `docs/WEEKLY-DIGEST.md`, `docs/DAILY-BRIEF.md` | Cron + SMTP pipelines.                         |
| `docs/NANOCLAW-PATCHES.md`          | Host-side patches; out of agent's normal scope.           |
| `schemas/wiki-ingest.schema.json`   | JSON-spec field shapes (the input to `wiki ingest`).      |
| `tests/fixtures/*.json` + `README.md` | Test-by-analogy. Read the README before writing a fixture. |
| `tests/unit/*.test.js`              | Unit tests on pure helpers in `bin/lib/`.                 |
| `tests/vault/`                      | Seed vault, **copied fresh per fixture** (hidden coupling). |
| `audit/*.md` (gitignored)           | Local audit findings; not in the published tree.          |

### Verb → module index

Every verb's handler lives in exactly one module. To change a verb's behavior, open its module directly; `bin/wiki` only wires the dispatch, so grepping it for the logic is a dead end.

| Module | Verbs |
|--------|-------|
| `bin/verbs/read.js` | list, search, recent, print, preview, sources, related, unlinked-mentions, render, context, agenda, day, challenge |
| `bin/commands/write.js` | write |
| `bin/commands/edit.js` | link, mv, delete, merge |
| `bin/commands/patch.js` | patch |
| `bin/commands/ingest.js` | ingest |
| `bin/commands/epistemic.js` | predict, hypothesize, capture |
| `bin/commands/todo.js` | todo |
| `bin/commands/graph.js` | links, backlinks, relations, observations, autolink, resolve, path, hubs, hooks, process, timeline, stubs, place |
| `bin/commands/measure.js` | measure |
| `bin/commands/replay.js` | replay |
| `bin/commands/sql.js` | sql |
| `bin/commands/lint.js` | lint |
| `bin/commands/review.js` | review |
| `bin/commands/git.js` | diff, revert |
| `bin/commands/hygiene.js` | bless, audit, fix-links, groom, size, sync-ids, reindex, preflight, migrate |
| `bin/commands/jobs.js` | jobs (`--check` validates installed launchd/cron vs the manifest in `bin/lib/jobs.js`) |
| `bin/wiki` (inline) | persona-lint |

**Token-economics rule of thumb.** `bin/wiki` is now the ~690-line dispatch/help/gating layer (down from ~5,000); even so, to change a verb you open its command module above, not `bin/wiki`. Read the handler plus a sibling verb that already does something similar.

## Hard rules (never violate)

1. **Never edit `wiki/*.md` files in any vault outside `bin/wiki`.** The CLI enforces invariants (auto-commit, audit, autolink, schema validation). Touching files directly bypasses all of that and leaves the vault inconsistent.
2. **Zero runtime dependencies.** No `npm install` of anything that lands in production code. Node stdlib only. (Dev tooling can shell out to `curl`, `git`, `duckdb` — those are runtime requirements of the host environment, not npm deps.)
3. **`./bin/wiki-test` must stay green.** Run it (or `npm test` for unit + fixtures) before claiming any code change is done. Pre-commit hook also enforces this.
4. **Never commit secrets.** The pre-commit hook scans staged files via `tools/scan-pii.sh` and refuses on hits. If a real PII match shows up, redact it; don't suppress the scanner.
5. **`docs/SCHEMA.md` is canonical.** A copy lives in `tests/vault/SCHEMA.md` and in `examples/example-vault/SCHEMA.md` — those are mirrors. Edit `docs/SCHEMA.md`, then mirror.
6. **No `_AI_box` codename in committed code.** It was the project's internal name during development; cleared in B01. If you see it, that's a regression.
7. **No emojis in code, commits, or docs** unless the user explicitly requests them.
8. **Auto-commit is ON during audit-remediation sessions.** Outside those sessions, commits require explicit user authorization (see `~/.claude/CLAUDE.md` global rules). Inside, follow the per-item commit discipline documented in `audit/README.md`.

## Safe-edit invariants (the system relies on these being true)

These aren't rules that bite you with an error — they're contracts that other code assumes. Break one and the breakage surfaces somewhere unexpected.

- **SCHEMA.md closed-set taxonomy.** `loadSchema()` in `bin/lib/schema.js` parses the tag/type/forbidden/verb lists out of SCHEMA.md at every CLI invocation. Adding a tag = edit SCHEMA.md, done. Adding a *kind* of taxonomy = also touch the parser in `bin/lib/schema.js`.
- **Frontmatter serialization chokepoint.** All page-write call-sites in `bin/wiki` funnel through `serializeFrontmatter` in `bin/lib/frontmatter.js`. Adding a new always-stamped FM field (like `schema_version` was in H07) means editing exactly one function. Don't write FM by hand at call-sites.
- **Write-validation triad.** All write verbs route through `validateForWrite` in `bin/lib/write-validate.js` (for slug/type/tag/derived_from) + `validateBody` in `bin/lib/ingest.js` (body-level rules, delegates to `strictRuleErrors` in `bin/lib/audit.js`) + `postWriteAudit` in `bin/lib/audit-runtime.js` (per-page audit afterward, invoked by the write/patch/ingest handlers). New write paths should follow the same sequence or document why they don't.
- **Auto-commit + auto-audit + auto-autolink.** Every successful write triggers (a) an auto-commit (atomic per write), (b) a post-write audit hook, and (c) bidirectional autolink resolution. `wiki revert <sha>` undoes one. Don't try to batch writes; the system is designed for one-write-one-commit. Opt out per invocation with `--no-auto-commit` or globally with `WIKI_NO_AUTO_COMMIT=1` — useful for CI runs and for "stage many edits, then commit by hand." Auto-commit failures print a loud multi-line stderr block but never crash the verb.
- **Tamper-detection race (known limitation).** `tamperCheck()` runs *before* the verb writes and flags any pre-existing uncommitted vault state. But there's a small window between that check and `git add -A` inside `autoCommit()`. If a concurrent process modifies the vault during that window, those changes get folded into the verb's commit indistinguishably from the verb's own writes. Mitigation: don't run the CLI concurrently against the same vault. Detection: a `wiki revert` of an auto-commit will undo more than just the verb's writes if this race fires. Real fix is a vault-level lock — deferred until the race is observed in practice.
- **`schema_version` stamping.** Every page write stamps `schema_version: <current>` via the serializer. Pages without the field are treated as v1 by `wiki migrate`. Bumping the schema version means: define the migration in `SCHEMA_MIGRATIONS` in `bin/lib/frontmatter.js`, run `wiki migrate`, ship.
- **Replay-spec versioning.** `captureReplaySpec` (`bin/lib/replay-capture.js`) stamps `spec_version` onto every captured Telegram-driven ingest spec. `wiki replay` dispatches through `REPLAY_SPEC_MIGRATIONS`. Symmetric with the page-schema versioning.
- **Search has two FTS indexes.** `bin/lib/duckdb.js` builds `fts_main_observations` (over `observations.body`, content ranking) AND `fts_main_vault` (over `vault.label_text` = title + aliases, alias resolution). `wiki search` queries both and prints alias-resolved pages under a `matched by title/alias:` section. If you change the snapshot schema, keep both indexes and bump `SNAPSHOT_SCHEMA_VERSION` so caches rebuild.
- **Persona-lint catches verb drift.** `wiki persona-lint` greps `SCHEMA.md`, `docs/PERSONA.template.md`, `docs/persona/*.template.md`, `docs/SCHEMA.md`, `docs/NANOCLAW-PATCHES.md`, `docs/WEEKLY-DIGEST.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` for backtick-wrapped `` `wiki <verb>` `` and refuses verbs not in the dispatch map. If you rename a verb, run persona-lint or expect doc drift.

## Tests

```sh
npm test               # unit (node:test) + fixture suite (bin/wiki-test)
npm run test:unit      # just unit tests
npm run test:fixtures  # just bin/wiki-test
```

Unit tests live in `tests/unit/*.test.js` and exercise pure helpers from `bin/lib/`. Fixture tests live in `tests/fixtures/*.json` and exercise the real CLI against a fresh copy of `tests/vault/` per test. **The tests/vault/ template is implicit state** — read `tests/fixtures/README.md` before adding a fixture.

## Recent state (post-audit)

The audit has been substantially worked down. Tracker in `audit/WORKPLAN.md` (gitignored — local only): all BLOCKER, HIGH, NIT cleared; MEDIUM at 18/19 (only M13 deferred — DuckDB incremental rebuild, revisit at 1K+ pages); LOW tier (7 items) open. Concrete state that affects daily work:

- Pure/shared helpers live under `bin/lib/` (`frontmatter`, `schema`, `graph`, `ingest`, `audit`, `vault`, `autolink`, `flag-aliases`, `flag-spec`, `verb-metadata`, `persona-template`, `config`, `jobs`, plus the write-side helpers `page-io`, `write-validate`, `audit-runtime`, `autolink-runtime`, `ingest-body`, `resolve`, `replay-capture`); unit-tested. **The verb-handler split is complete**: every handler lives in `bin/commands/<group>.js` or `bin/verbs/read.js`, and `bin/wiki` is now the dispatch/help/gating layer (argv parse + flag validation + `cmds` dispatch + tamper/auto-commit). `persona-lint` is the sole inline handler. `tests/unit/dispatch-parity.test.js` and `tests/unit/verb-metadata.test.js` fail loudly if dispatch, help metadata, or write-class metadata drift out of sync.
- `wiki persona-lint` (H09) — catches verb drift in repo docs and persona fragments.
- `wiki migrate` (H07) — frontmatter schema versioning. Every page write stamps `schema_version`.
- `wiki preflight` (M12) — one-shot env/dependency check. Run first when dropping into an unfamiliar vault.
- `email-digest --dry-run` (H10) — SMTP pre-flight.
- Verb metadata table + per-verb `--help` (M10+M11) — `wiki ingest --help` etc. ship long-form usage for ingest/write/patch/audit/lint.
- `forEachPage` helper (M06) in `bin/lib/vault.js` — used at 20+ iteration sites; the spot to add per-process caching later.
- Staged-write atomicity in `wiki ingest` (M08) — pre-flush staging means crashes mid-execute leave the vault untouched.
- `tests/fixtures/README.md` (M18) — fixture format + tests/vault coupling.
- `docs/CONVENTIONS.md` (M16) — naming, error format, exit codes, where-things-live module map.

If you find yourself reading code that the audit has already analysed, check `audit/00-summary.md` for the high-level findings first.

## Runbooks

### Runbook 1: Add a new verb to `wiki`

Worked example: a hypothetical `next-up` verb that lists `type=event` pages with `when` in the next 7 days. (The verb doesn't exist; we're walking through adding it. The full invocation would be **wiki next-up** — written without backticks here so `wiki persona-lint` doesn't flag a doc-vs-dispatch-map mismatch.)

1. **Confirm the verb name is free.** Grep `bin/wiki` for `const cmds = {`. The dispatch map is the canonical list.
2. **Read the closest sibling verb.** For `next-up`, that's `cmdAgenda` — grep the repo for `function cmdAgenda` (read verbs live in `bin/verbs/read.js`; every other verb lives in its `bin/commands/<group>.js` — see the verb→module index). Read it end-to-end; it's the template you'll copy.
3. **Add `cmdNextUp(args)`** in the `bin/commands/` module that owns its group (alongside the sibling), and `module.exports` it. Pattern for this example: walk pages via `forEachPage` (from `bin/lib/vault.js`), filter for `fm.type === 'event'` with `fm.when` within today + 7 days, sort by `when`, print one line per event.
4. **Register in the dispatch map.** Grep `const cmds = {` in `bin/wiki`; `require` the handler from its command module and add the entry. Match the existing comment-cluster convention (read, write, graph, todo, hygiene, etc.). Kebab-case verbs use string keys (`'sync-ids': cmdSyncIds`); single-word verbs use bare identifiers. The parity test (`tests/unit/dispatch-parity.test.js`) will fail loudly if a metadata entry, a `cmds` entry, or an exported `cmd` is missing its counterpart.
5. **Add an entry to the metadata table** in `bin/lib/verb-metadata.js`. Each entry has `{ name, section, lines: ['  <synopsis>'] }` and optionally `longHelp: '...'` for the most-complex verbs. If normal invocation writes to the vault, add it to `WRITE_VERB_NAMES` in that file. The table feeds both the global help banner and `wiki <verb> --help`.
6. **Update `docs/persona/*.template.md`** if the persona should know to invoke it. Grep for the closest existing verb in the fragments (`` `wiki agenda` ``, `` `wiki audit` ``, etc.), add yours nearby, then run `tools/assemble-persona-template.js > docs/PERSONA.template.md` or `tools/assemble-persona-template.js --check` if the aggregate is already current.
7. **Add a fixture.** `tests/fixtures/next-up-window.json` + `.expected.json`. CLI-fixture shape (`{cmd: [...]}`). Optional `setup` to arrange vault state. Read `tests/fixtures/README.md` for the assertion vocabulary.
8. **Run `npm test`.** Unit + fixture suite must all pass.
9. **Run `node bin/wiki persona-lint`.** Catches dangling verb refs in docs.
10. **Commit atomically.** `[<ID-if-from-audit>] <imperative>`.

Grep anchors: `const cmds = {` (dispatch), `RAW_VERBS` / `WRITE_VERB_NAMES` in `bin/lib/verb-metadata.js` (help/write-class metadata), `function cmdAgenda` (a typical read verb), `function cmdPatch` (a write verb).

### Runbook 2: Add a closed-set tag

Worked example: add `audio` as a tag.

1. **Read `docs/SCHEMA.md § Tag taxonomy (closed set, CLI-enforced)`.** The list lives in a fenced code block; `loadSchema()` in `bin/lib/schema.js` parses it by regex.
2. **Add `audio`** to the fenced block. Convention is loose-alphabetical; match the section it belongs in (content modality, entity kind, etc.).
3. **Check for hardcoded uses.** Two constants in `bin/lib/schema.js` hardcode tag subsets:
   - `ENTITY_KIND_TAGS` — the tags that mark a page as an "entity kind" (person/org/tool/paper/media).
   - `STALE_THRESHOLDS` — per-tag staleness windows.
   Adding a tag does **not** require editing either of these unless the tag is conceptually an entity-kind or wants a non-default staleness threshold.
4. **Mirror SCHEMA.md to `tests/vault/SCHEMA.md` and `examples/example-vault/SCHEMA.md`.** Run `diff docs/SCHEMA.md tests/vault/SCHEMA.md` to spot which sections are mirrors.
5. **No new fixture needed** for a pure inclusion case — the existing closed-set rejection fixtures cover the negative path.
6. **`npm test`** + **`wiki audit --all`** on the live vault — should stay clean if no existing page used the tag illegally before.

### Runbook 3: Add a fixture / smoke test

Worked example: add a fixture for `wiki todo done`.

1. **Pick a template.** For CLI-shape fixtures, `tests/fixtures/merge-simple.{json,expected.json}` is a clean two-liner. For ingest-shape fixtures (top-level `source` field), `tests/fixtures/new-person-with-stubs.json`.
2. **Copy + rename** to your new fixture name. Both files: `<name>.json` and `<name>.expected.json`.
3. **Write the spec.** CLI-shape: `{cmd: [...], setup?: [[...]]}`. The seed vault (`tests/vault/wiki/`) already has a handful of pages — `ls tests/vault/wiki/` to see what's there before assuming you need to add one.
4. **Write the expected.** Assertion vocabulary (from `bin/wiki-test`):
   - `exitCode: <number>` — required.
   - `stdoutContains: [substr, ...]`, `stderrContains: [substr, ...]` — substring, not regex.
   - `wikiAssertions.<slug>.fileExists: false` — refused-create check.
   - `wikiAssertions.<slug>.bodyContains: [substr, ...]`, `.bodyMissing: [substr, ...]`.
5. **Run `bin/wiki-test`.** Your fixture appears in the output. If a fixture you didn't touch breaks, you probably added vault state another fixture depended on — see `tests/fixtures/README.md § Hidden coupling`.
6. **Commit.**

You do not need to read `bin/wiki-test` internals beyond what `tests/fixtures/README.md` lists. The fixture API surface is small and stable.

### Runbook 4: Extract a pure helper into `bin/lib/`

When inline logic in `bin/wiki` gets duplicated, grows fiddly enough to deserve unit tests, or starts looking like a reusable primitive, pull it into a `bin/lib/<name>.js` module. The current set of `bin/lib/` modules (audit, autolink, frontmatter, graph, ingest, maintenance, schema, staged-writes, vault, …) is the cumulative result of doing exactly this.

Worked example: extracting `autolinkBody` into `bin/lib/autolink.js` (commit 4cfa380).

1. **Identify the pure core.** The function should depend only on its arguments — no `fs`, no `process`, no module-scope state. If it currently reads files, the call site (in `bin/wiki`) is the fs-touching wrapper; the lib gets the post-read inputs as parameters.
2. **Create `bin/lib/<name>.js`** with a short header comment naming the contract: what the function takes, what it returns, what it does NOT do (no fs, no globals, re-entrant). Use `'use strict';`. Export named functions via `module.exports`.
3. **Write `tests/unit/<name>.test.js`** with `node:test` + `node:assert/strict`. Cover the happy path, every documented branch, and the boundary cases the function actually has (regex specials, empty inputs, missing optional fields). Anywhere from 5 to 20 tests is normal; the autolink module has 15, staged-writes has 6.
4. **Replace the inline copy in `bin/wiki`** with `const { fn } = require('./lib/<name>.js')`. If multiple call sites had duplicated the logic, sweep them all — the value of extraction is one source of truth.
5. **Run `npm test`**. Both legs must pass: unit (`node --test 'tests/unit/*.test.js'`) and the existing fixture suite (`bin/wiki-test`). If only the unit suite passes, the call-site rewiring missed something — a `git diff bin/wiki` against the pre-extraction state usually shows it.

Keep the extracted lib pure. Do not start adding fs reads or env-var lookups later. If a new caller needs that, build a second fs-touching wrapper (e.g., `bin/lib/schema.js::loadSchema` wraps `parseSchemaContent`), don't pollute the pure core.

### Runbook 5: Add an audit rule

The audit machinery has two surfaces: per-page rules in `bin/lib/audit.js::AUDIT_RULES` (one entry shared by `wiki audit` and write-time strict mode), and cross-page rules in `bin/lib/audit.js::auditVault` (need a vault-wide view). The AUDIT_RULES table is the easier one and where most rules belong.

Worked example: an `aliases-empty-string` rule that flags `aliases:` arrays containing `""`.

1. **Append an entry to `AUDIT_RULES`** in `bin/lib/audit.js`:
   ```js
   {
     name: 'aliases-empty-string',
     severity: 'medium',
     strict: false,
     check: ({ fm }) => {
       const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
       const bad = aliases.filter((a) => a === '' || /^\s*$/.test(a));
       if (!bad.length) return null;
       return { detail: `aliases contains ${bad.length} empty string(s); remove or fill in` };
     },
   },
   ```
   `severity` is `'high'` / `'medium'` / `'low'` (scoring weights 3 / 2 / 1). `strict: true` means the rule blocks at write time via `validateBody` — only use for true correctness failures, not for stylistic nudges. Most new rules are `strict: false`.
2. **Add a unit test** in `tests/unit/audit.test.js`. The pattern: a positive case (rule fires with the expected `detail`), a negative case (rule does not fire on clean input), and one edge case (e.g., aliases-as-string-not-array doesn't crash). Existing tests in that file are a template.
3. **Add an integration fixture** under `tests/fixtures/<rule-name>.{json,expected.json}`. The fixture exercises the rule end-to-end via a `wiki audit <slug>` command. See Runbook 3.

For cross-page rules (hot-text-mention, lonely), extend `auditVault` in `bin/lib/audit.js` directly — they need the full pages snapshot. Same test pattern, but the unit test calls `auditVault({pages, …})` instead of `auditPage`.

After landing, the rule shows up automatically in `wiki audit` (which iterates AUDIT_RULES) and — if `strict: true` — in `wiki write` strict mode. No dispatch wiring; the table is the dispatch.

### Runbook 6: Add or re-split a verb group in `bin/commands/`

`bin/wiki` has been fully decomposed: every verb handler lives in `bin/commands/<group>.js` (read-only verbs in `bin/verbs/read.js`), shared helpers in `bin/lib/`, and `bin/wiki` keeps only argv-parse + help rendering + the `cmds` dispatch map + tamper/auto-commit gating. This runbook records the pattern for adding a brand-new verb group (or re-splitting an oversized one). It is behavior-preserving; each move ships green.

1. **Pick a group** (e.g. read-only analysis: `sql`, `lint`, `review`). Confirm none of its handlers call another `cmdXxx` directly — they shouldn't; coupling is only via shared helpers.
2. **Create `bin/commands/<group>.js`.** `'use strict';`, `require` the libs and shared helpers the handlers need, define the `cmdXxx` functions, `module.exports` each.
3. **If a handler used an inline `bin/wiki` helper** (`appendLog`, `autoCommit`, `regenerateIndex`, `readPageForWrite`, `validateForWrite`, `validateBody`, `postWriteAudit`, …), first extract that helper to a `bin/lib/` module (Runbook 4) so both `bin/wiki` and the new command module import it from one place. Do the helper extraction as its own step/commit.
4. **Rewire `bin/wiki`:** delete the moved functions, `require` them from `./commands/<group>.js`, keep the `cmds` entries pointing at the imported names.
5. **Relative requires survive deployment** — `require('./commands/x.js')` resolves the same from `bin/wiki` and a deployed `.bin/wiki`. `tools/deploy.sh` copies `bin/commands/` because `commands` is in its `BIN_DIRS`.
6. **Run `npm test`** (unit + fixtures) and `node bin/wiki persona-lint`. The dispatch-parity and verb-metadata tests guard that nothing fell out of dispatch/help wiring.

## Pointers

- **Why the codebase looks the way it does (design principles)** → `docs/PHILOSOPHY.md`
- **What an agent should do at runtime** → `docs/persona/*.template.md` (source) and `docs/PERSONA.template.md` (assembled compatibility aggregate)
- **The vault contract** → `docs/SCHEMA.md`
- **The four host-side patches Alfred needs from nanoclaw** → `docs/NANOCLAW-PATCHES.md`
- **Cron + SMTP weekly digest** → `docs/WEEKLY-DIGEST.md`
- **Fixture format and the hidden tests/vault coupling** → `tests/fixtures/README.md`
- **Pre-existing audit findings (gitignored)** → `audit/00-summary.md`, then specific file by tier
- **Audit remediation tracking (gitignored)** → `audit/WORKPLAN.md` + `audit/sessions/<date>.md`
