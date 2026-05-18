# CLAUDE.md — orientation for LLM agents working on alfred_assistant

This file is the entry point for any agent dropped into this repo. Read it before reading anything else. It will not change often; the file map below tells you where to go next based on the task.

## What this is

Single-user, self-hosted personal-knowledge agent. The "vault" is a typed graph of markdown pages with a closed-set schema; `bin/wiki` is the only writer. Everything else (the Telegram-driven LLM driver, the inbox triage, the weekly digest) flows from that single-writer constraint. Zero runtime dependencies — Node stdlib only.

The repo is *the published surface* (CLI + docs + tests). The user's actual vault lives elsewhere on their machine and is mounted into the agent container at runtime via `.alfred.yml`.

## File map (with token budget)

Approximate token counts assume ~4 chars/token. Sizes accurate as of the latest commit on `main`.

| Path                                | Size  | ~tokens | When to read                                              |
|-------------------------------------|-------|---------|-----------------------------------------------------------|
| `CLAUDE.md`                         | this  | <1k     | First. Always.                                            |
| `bin/wiki`                          | 184K  | ~46k    | Adding/editing a verb. **Always grep first** — never read end-to-end. |
| `bin/lib/frontmatter.js`            | 4K    | <1k     | Touching frontmatter parse/serialize/migration            |
| `bin/lib/config.js`                 | 6K    | 1.5k    | Touching `.alfred.yml` handling                           |
| `bin/inbox`                         | 16K   | 4k      | Touching raw-content triage                               |
| `bin/wiki-test`                     | 7K    | 1.7k    | Reading the fixture runner; **assertion vocabulary lives here** |
| `bin/email-digest`                  | 3K    | <1k     | Touching SMTP send / weekly digest                        |
| `docs/SCHEMA.md`                    | 40K   | ~10k    | Tag/type/verb/microsyntax questions. **The contract.**    |
| `docs/PERSONA.template.md`          | 28K   | ~7k     | What the LLM agent is expected to do at runtime           |
| `docs/WEEKLY-DIGEST.md`             | 4K    | <1k     | Cron + SMTP pipeline                                      |
| `docs/NANOCLAW-PATCHES.md`          | 4K    | <1k     | Host-side patches; out of agent's normal scope            |
| `schemas/wiki-ingest.schema.json`   | 5K    | 1.2k    | JSON-spec field shapes (the input to `wiki ingest`)       |
| `tests/fixtures/*.json`             | 0.3-2K | <1k    | Test-by-analogy. See `tests/fixtures/README.md`.          |
| `tests/unit/*.test.js`              | 5K    | 1.2k    | Unit tests on pure helpers (currently: frontmatter only)  |
| `tests/vault/`                      | dir   | varies  | Seed vault, **copied fresh per fixture** (hidden coupling) |
| `tests/fixtures/README.md`          | 4K    | <1k     | Read before writing a new fixture                         |
| `audit/*.md` (gitignored)           | 6-14K | 2-4k    | Local audit findings; not in published tree               |

**Token-economics rule of thumb.** Reading `bin/wiki` end-to-end costs ~46k tokens. Don't. Instead: grep for the verb you care about, read ±100 lines around it, and read the sibling verbs that already do something similar.

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

- **SCHEMA.md closed-set taxonomy.** `loadSchema()` at `bin/wiki:180` parses the tag/type/forbidden/verb lists out of SCHEMA.md at every CLI invocation. Adding a tag = edit SCHEMA.md, done. Adding a *kind* of taxonomy = also touch loadSchema.
- **Frontmatter serialization chokepoint.** All 20 page-write call-sites in `bin/wiki` funnel through `serializeFrontmatter` in `bin/lib/frontmatter.js`. Adding a new always-stamped FM field (like `schema_version` was in H07) means editing exactly one function. Don't write FM by hand at call-sites.
- **Write-validation triad.** All write verbs route through `validateForWrite` (`bin/wiki:339`) for slug/type/tag/derived_from + `validateBody` for body-level rules + `postWriteAudit` (`bin/wiki:2492`) for per-page audit afterward. New write paths should follow the same sequence or document why they don't.
- **Auto-commit + auto-audit + auto-autolink.** Every successful write triggers (a) an auto-commit (atomic per write), (b) a post-write audit hook, and (c) bidirectional autolink resolution. `wiki revert <sha>` undoes one. Don't try to batch writes; the system is designed for one-write-one-commit. Opt out per invocation with `--no-auto-commit` or globally with `WIKI_NO_AUTO_COMMIT=1` — useful for CI runs and for "stage many edits, then commit by hand." Auto-commit failures print a loud multi-line stderr block but never crash the verb.
- **Tamper-detection race (known limitation).** `tamperCheck()` runs *before* the verb writes and flags any pre-existing uncommitted vault state. But there's a small window between that check and `git add -A` inside `autoCommit()`. If a concurrent process modifies the vault during that window, those changes get folded into the verb's commit indistinguishably from the verb's own writes. Mitigation: don't run the CLI concurrently against the same vault. Detection: a `wiki revert` of an auto-commit will undo more than just the verb's writes if this race fires. Real fix is a vault-level lock — deferred until the race is observed in practice.
- **`schema_version` stamping.** Every page write stamps `schema_version: <current>` via the serializer. Pages without the field are treated as v1 by `wiki migrate`. Bumping the schema version means: define the migration in `SCHEMA_MIGRATIONS` in `bin/lib/frontmatter.js`, run `wiki migrate`, ship.
- **Replay-spec versioning.** `captureReplaySpec` (`bin/wiki`) stamps `spec_version` onto every captured Telegram-driven ingest spec. `wiki replay` dispatches through `REPLAY_SPEC_MIGRATIONS`. Symmetric with the page-schema versioning.
- **Persona-lint catches verb drift.** `wiki persona-lint` greps `SCHEMA.md`, `docs/PERSONA.template.md`, `docs/SCHEMA.md`, `docs/NANOCLAW-PATCHES.md`, `docs/WEEKLY-DIGEST.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` for backtick-wrapped `` `wiki <verb>` `` and refuses verbs not in the dispatch map. If you rename a verb, run persona-lint or expect doc drift.

## Tests

```sh
npm test               # unit (node:test) + fixture suite (bin/wiki-test)
npm run test:unit      # just unit tests
npm run test:fixtures  # just bin/wiki-test
```

Unit tests live in `tests/unit/*.test.js` and exercise pure helpers from `bin/lib/`. Fixture tests live in `tests/fixtures/*.json` and exercise the real CLI against a fresh copy of `tests/vault/` per test. **The tests/vault/ template is implicit state** — read `tests/fixtures/README.md` before adding a fixture.

## Recent state (post-audit)

The repo is currently in audit-remediation mode. Tracker in `audit/WORKPLAN.md` (gitignored — local only). The audit identified items across BLOCKER → NIT severity; ~half are closed as of session 7. Concrete state that affects daily work:

- `wiki persona-lint` (H09) — catches verb drift in docs.
- `wiki migrate` (H07) — frontmatter schema versioning.
- `email-digest --dry-run` (H10) — SMTP pre-flight.
- `bin/lib/frontmatter.js` (partial H04) — frontmatter helpers extracted from `bin/wiki`, paired with `tests/unit/frontmatter.test.js`.
- `docs/WEEKLY-DIGEST.md` (H01) — pipeline documentation that was previously a dangling reference.
- `tests/fixtures/README.md` (M18) — fixture format + tests/vault coupling.
- `wiki preflight` (M12) — one-shot env/dependency check. Run first when dropping into an unfamiliar vault.

If you find yourself reading code that the audit has already analysed, check `audit/00-summary.md` for the high-level findings first.

## Runbooks

### Runbook 1: Add a new verb to `wiki`

Worked example: a hypothetical `next-up` verb that lists `type=event` pages with `when` in the next 7 days. (The verb doesn't exist; we're walking through adding it. The full invocation would be **wiki next-up** — written without backticks here so `wiki persona-lint` doesn't flag a doc-vs-dispatch-map mismatch.)

1. **Confirm the verb name is free.** Grep `bin/wiki` for `const cmds = {` (currently `:4189`). The dispatch map is the canonical list.
2. **Read the closest sibling verb.** For `next-up`, that's `cmdAgenda` (`:542`, `function cmdAgenda(args) {`). Read end-to-end — it's the template you'll copy.
3. **Add `cmdNextUp(args)`** near the sibling. Pattern for this example: filter `listWikiPages()` for `fm.type === 'event'` with `fm.when` within today + 7 days, sort by `when`, print one line per event in the agenda format.
4. **Register in the dispatch map** (`:4189`). Match the existing comment-cluster convention (read, write, graph, todo, hygiene, etc.). Kebab-case verbs use string keys (`'sync-ids': cmdSyncIds`, `'persona-lint': cmdPersonaLint`). Single-word verbs use bare identifiers.
5. **Add a one-liner to the help banner** (grep `// ─── argparse + dispatch`, currently `:4163`). Put it under the right section header.
6. **Update `docs/PERSONA.template.md`** if the persona should know to invoke it. Grep for the closest existing verb in that doc (`wiki agenda`, `wiki audit`, etc.) and add yours nearby.
7. **Add a fixture.** `tests/fixtures/next-up-window.json` + `.expected.json`. CLI-fixture shape (`{cmd: [...]}`). Optional `setup` to arrange vault state. Read `tests/fixtures/README.md` for the assertion vocabulary.
8. **Run `npm test`.** 18+ unit + 18+ fixtures must all pass.
9. **Run `node bin/wiki persona-lint`.** Catches dangling verb refs in docs.
10. **Commit atomically.** `[<ID-if-from-audit>] <imperative>`.

Grep anchors: `const cmds = {` (dispatch), `function cmdAgenda` (a typical read verb), `function cmdPatch` (a write verb), `// ─── argparse + dispatch` (help banner).

### Runbook 2: Add a closed-set tag

Worked example: add `audio` as a tag.

1. **Read `docs/SCHEMA.md § Tag taxonomy (closed set, CLI-enforced)`** (`docs/SCHEMA.md:78`). The list lives in a fenced code block; `loadSchema()` (`bin/wiki:180`) parses it by regex.
2. **Add `audio`** to the fenced block. Convention is loose-alphabetical; match the section it belongs in (content modality, entity kind, etc.).
3. **Check for hardcoded uses.** Two spots in `bin/wiki` hardcode tag subsets:
   - `ENTITY_KIND_TAGS` (`:57`) — the 5 tags that mark a page as an "entity kind" (person/org/tool/paper/media).
   - `STALE_THRESHOLDS` (`:59`) — per-tag staleness windows.
   Adding a tag does **not** require editing either of these unless the tag is conceptually an entity-kind or wants a non-default staleness threshold.
4. **Mirror SCHEMA.md to `tests/vault/SCHEMA.md` and `examples/example-vault/SCHEMA.md`.** Run `diff docs/SCHEMA.md tests/vault/SCHEMA.md` to spot which sections are mirrors.
5. **No new fixture needed** for a pure inclusion case — the existing closed-set rejection fixtures cover the negative path.
6. **`npm test`** + **`wiki audit --all`** on the live vault — should stay clean if no existing page used the tag illegally before.

### Runbook 3: Add a fixture / smoke test

Worked example: add a fixture for `wiki todo done`.

1. **Pick a template.** For CLI-shape fixtures, `tests/fixtures/merge-simple.{json,expected.json}` is a clean two-liner. For ingest-shape fixtures (top-level `source` field), `tests/fixtures/new-person-with-stubs.json`.
2. **Copy + rename** to your new fixture name. Both files: `<name>.json` and `<name>.expected.json`.
3. **Write the spec.** CLI-shape: `{cmd: [...], setup?: [[...]]}`. The seed vault (`tests/vault/wiki/`) already has 12 pages — `ls tests/vault/wiki/` to see what's there before assuming you need to add one.
4. **Write the expected.** Assertion vocabulary (from `bin/wiki-test`):
   - `exitCode: <number>` — required.
   - `stdoutContains: [substr, ...]`, `stderrContains: [substr, ...]` — substring, not regex.
   - `wikiAssertions.<slug>.fileExists: false` — refused-create check.
   - `wikiAssertions.<slug>.bodyContains: [substr, ...]`, `.bodyMissing: [substr, ...]`.
5. **Run `bin/wiki-test`.** Your fixture appears in the output. If a fixture you didn't touch breaks, you probably added vault state another fixture depended on — see `tests/fixtures/README.md § Hidden coupling`.
6. **Commit.**

You do not need to read `bin/wiki-test` internals beyond what `tests/fixtures/README.md` lists. The fixture API surface is small and stable.

## Pointers

- **What an agent should do at runtime** → `docs/PERSONA.template.md`
- **The vault contract** → `docs/SCHEMA.md`
- **The four host-side patches Alfred needs from nanoclaw** → `docs/NANOCLAW-PATCHES.md`
- **Cron + SMTP weekly digest** → `docs/WEEKLY-DIGEST.md`
- **Fixture format and the hidden tests/vault coupling** → `tests/fixtures/README.md`
- **Pre-existing audit findings (gitignored)** → `audit/00-summary.md`, then specific file by tier
- **Audit remediation tracking (gitignored)** → `audit/WORKPLAN.md` + `audit/sessions/<date>.md`
