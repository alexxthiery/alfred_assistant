# Conventions

Project-wide conventions for `bin/wiki` and the `bin/lib/*.js` modules. Read this before adding a new verb, error message, exit code, or closed-set value. New code that doesn't match a convention here should either follow it or be explicit about why it doesn't.

## Naming

| Kind | Convention | Examples |
|---|---|---|
| Verb dispatch functions | `cmd<Verb>` | `cmdWrite`, `cmdIngest`, `cmdAudit`, `cmdGroom` |
| Parsers (string -> structured) | `parseX` | `parseFrontmatter`, `parseObservations`, `parseRelations`, `parseArgs` |
| Loaders (fs -> structured) | `loadX` | `loadSchema`, `loadConfig`, `loadVaultDb` |
| Extractors (text -> tokens) | `extractX` | `extractWikilinks`, `extractProvenanceMarkers` |
| Validators (input -> errors) | `validateX` | `validateSlug`, `validateBody`, `validateIngestSpec` |
| Closed-set constants | `UPPERCASE_SNAKE`, defined once in their owning module | `WRITE_VERBS` (in `bin/lib/verb-metadata.js`); `KNOWN_TYPES` / `ENTITY_KIND_TAGS` (in `bin/lib/schema.js`); `FLAG_ALIASES` (in `bin/lib/flag-aliases.js`) |
| Verbs (CLI surface) | kebab-case for multi-word | `sync-ids`, `persona-lint`, `email-digest` |

Counterexamples to avoid: don't define a closed-set inline at the call site (the audit-flagged `EXTERNAL_LINK_FIELDS` was the prior anti-pattern). Hoist once to the top of the file or to `bin/lib/<area>.js`.

## Doc citations

Cite code by symbol + file, never by line number. Line numbers rot every time the file shifts; symbols survive refactors.

- Bad: `loadSchema at bin/wiki:180`.
- Good: `` `loadSchema()` in `bin/lib/schema.js` ``.
- Good: `` grep for `const cmds = {` in `bin/wiki` ``.

The runbooks in `AGENTS.md` follow this convention. New docs must too.

## Error format

Four genres, four shapes.

- Terminal errors (the CLI cannot proceed): `error: <message>`, stderr, non-zero exit.
- Deliberate refusals (the CLI saw a valid request and intentionally won't perform it, e.g. deleting a page with backlinks): `Refusing: <message>`, stderr, non-zero exit. Distinct from `error:` because the request itself was well-formed — the CLI is enforcing a policy. The `--force` flag is the usual escape hatch.
- Non-fatal warnings (work continues): `warning: <message>`, stderr.
- Usage errors (missing/bad invocation): `Usage: wiki <verb> [args]`, stderr, exit 1.

Deprecation warnings are a sub-genre of warning: `[deprecated] wiki <verb>: --old is deprecated; use --new instead` (emitted by the flag-alias hook).

Avoid bare strings like `Page X does not exist.` for terminal errors. Prefer `error: page X does not exist`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error: missing/bad flag, no positional, unknown verb |
| 2 | Runtime / file-state error: page not found, fuzzy match required, IO failure, JSON parse error |
| 3 | Validation rejection: schema, body, type, tag, or relation-verb check failed |

Known drift: `cmdIngest` exits 2 on audit-dirty (a successful write with non-blocking quality issues). That is not yet a distinct code; future work may reserve 4 for "succeeded with non-blocking issues". Until then, callers that need to distinguish should parse stdout for the per-page audit summary.

Health-check verbs overload exit 1 as "checks failed" (not a usage error): `preflight` exits 1 if any check FAILed, and `jobs --check` exits 1 on schedule drift (an installed job pointing at the wrong target). `missing`/`custom` job states are informational and exit 0.

## Schema as contract

Closed sets live in `docs/SCHEMA.md` and are parsed at runtime by `bin/lib/schema.js`. The parser is the sole source of truth for what's allowed.

- Tag taxonomy, relation-verb verb set, symmetric verbs, inverse-pair verbs, and forbidden aggregator slugs: all live in `SCHEMA.md` and are loaded by `loadSchema()` on every invocation.
- Never hardcode a tag/relation-verb list in code. If a CLI feature needs to know "which tags are entity-kind tags," that list belongs in `SCHEMA.md` and is read at runtime.
- The `KNOWN_TYPES` constant in `bin/lib/schema.js` is the one exception: page-type names are stable and reading them from `SCHEMA.md` would create a cold-start chicken-and-egg. `wiki persona-lint` cross-checks types vs `SCHEMA.md` headings to catch drift.

## Where things live

| Concern | Module | Notes |
|---|---|---|
| Frontmatter parse/serialize/migrate | `bin/lib/frontmatter.js` | Pure; no fs. `serializeFrontmatter` stamps `schema_version`. |
| Schema parse + closed-set load | `bin/lib/schema.js` | Pure parser + thin fs wrapper `loadSchema(path)`. |
| Wikilink / observation / relation / fuzzy helpers | `bin/lib/graph.js` | Pure text helpers. |
| Ingest-spec + body validators | `bin/lib/ingest.js` | Pure; injects deps. |
| Shared audit rule table | `bin/lib/audit.js` | One source for write-time strict subset + audit-time scored set. |
| Vault constants + page iteration | `bin/lib/vault.js` | `VAULT_ROOT`, `WIKI_DIR`, `forEachPage`. The controlled fs boundary. |
| CLI flag-rename / removal policy | `bin/lib/flag-aliases.js` | Pure; consulted at dispatch. |
| Verb metadata | `bin/lib/verb-metadata.js` | Declarative help table, help-section order, and write-class/tamper-check set. No dispatch logic. |
| Runtime persona template assembly | `bin/lib/persona-template.js`, `docs/persona/*.template.md` | Fragment source is assembled into `docs/PERSONA.template.md`; `tools/render-persona.sh` renders from fragments. |
| Read-only verbs (`list`, `print`, `search`, ...) | `bin/verbs/read.js` | Extracted from `bin/wiki`. |
| Verb handlers (write, edit, ingest, hygiene, sql, review, ...) | `bin/commands/<group>.js` | Thin handlers exporting `cmdXxx`. All verbs now live here; `persona-lint` is the lone inline exception in `bin/wiki`. |
| Dispatch, argv parse, help rendering, tamper/auto-commit gating | `bin/wiki` | Top-level CLI; imports handlers from `bin/commands/*` + `bin/verbs/*` and helpers from `bin/lib/*`. |

Iteration of every page goes through `forEachPage` (from `bin/lib/vault.js`), not raw `for (const f of listWikiPages())`. The single helper is the spot to add per-process caching later, once mutation-during-iteration sites are audited.

## Validator timing

There are two layers of validation, distinguished by when they fire.

- Write-time strict subset (`validateBody` / `strictRuleErrors` in `bin/lib/ingest.js` and `bin/lib/audit.js`): runs before a `wiki write` / `wiki patch` / `wiki ingest` writes to disk. Blocks the write on any rule whose `strict: true` flag is set. Ordinary strict rules are bypassable with `--soft` during migrations; `ironclad: true` rules are not bypassable because they protect schema syntax or destructive empty-page writes. Strict rules are a minimal subset of all audit rules.
- Audit-time scored set (`auditPage` / `auditSlug` / `auditAll`): runs after a write (the write/patch/ingest handlers call `postWriteAudit` -> `auditSlug` in `bin/lib/audit-runtime.js` on touched pages and print a score) and on demand (`wiki audit <slug>` / `wiki audit --all`). Reports all rules with severity, never blocks. The full set is the source of truth for "what counts as quality".

The two share one rule table (`AUDIT_RULES` in `bin/lib/audit.js`). Adding a new rule means adding one entry with `{name, severity, strict, check}`; both call sites pick it up automatically.

Ingest-spec validation (`validateIngestSpec`) is a third, separate layer that runs upfront on the whole spec before any execute-phase work. It must catch all-or-nothing rules (slug collisions, target-page existence, fuzzy-duplicate suspects) so the staged-write execute phase can assume the spec is well-formed.

## Deprecation policy

Verbs, flags, and closed-set values follow a two-release cycle.

- vX.Y: deprecated thing still works, prints a warning.
- vX.(Y+1): deprecated thing is removed, calling it produces an "unknown ..." error.

Renamed flags are wired through the `FLAG_ALIASES` table in `bin/wiki` and the pure `applyFlagAliases` helper in `bin/lib/flag-aliases.js`. The same machinery handles removals (set the new name to `null`). See `CONTRIBUTING.md` for the policy and `flag-aliases.js` for the mechanics.

## Auto-commit and tamper-check

Every write-class verb (`write`, `patch`, `ingest`, `predict`, `hypothesize`, `capture`, `mv`, `delete`, `merge`, `link`, `autolink`, `groom`, `todo`) auto-commits its changes to the vault's git repo. Behavior:

- Default: a single commit per CLI invocation, batching all staged changes.
- Opt-out: `--no-auto-commit` flag, or `WIKI_NO_AUTO_COMMIT=1` env var.
- Failure mode: a multi-line stderr block names the recovery steps. Verb exit code is not affected by git failure (the work is done; only the commit was missed).

Tamper-check runs once at the start of every write-class verb. It refuses to proceed if `wiki/`, `raw/`, `SCHEMA.md`, or `.bin/` files have been edited outside the CLI since the last auto-commit. The race between the tamper-check and the very write that follows is documented in `AGENTS.md § safe-edit invariants`.

## Output directory (`output/`)

`output/` at the vault root is untracked free-form space for Alfred-authored deliverables: one-off summaries, exports, generated reports. It is gitignored by convention. `examples/example-vault/.gitignore` ships the entry, and every vault's own `.gitignore` should carry it too.

The single writer for `output/` is the `wiki export` verb (`bin/commands/export.js`), not raw `fs` writes — consistent with "the CLI is the only writer." It sanitizes the filename via `bin/lib/output-export.js` (no separators, no `..` traversal, no hidden files, so the file always stays inside `output/`), refuses empty bodies, and resolves collisions. It is intentionally **not** a write-class verb: `output/` is gitignored, so the verb does not auto-commit and is not tamper-checked.

Why gitignored, not merely left untracked:

- Auto-commit stages only `wiki/` and `raw/`, so it would never commit `output/` on its own. But a later `wiki bless` or `--accept-tamper` runs `git add -A`. Git honors `.gitignore`, so a gitignored `output/` cannot be swept into a wiki commit. That is the safety guarantee.
- It is outside the tamper-check filter (`wiki/`, `raw/`, `SCHEMA.md`, `.bin/`), so writing there never blocks the next write-class verb.

Consequences: files in `output/` have no git history and are not indexed by `wiki search` / `wiki sql`. Durable knowledge belongs in the graph (`wiki write`, e.g. a `type=synthesis` page), not here. `output/` is for artifacts that are genuinely not graph-shaped.

## Documentation pointers

| Audience | Read |
|---|---|
| New contributor (human) | `README.md`, then `CONTRIBUTING.md` |
| Agent developer | `AGENTS.md`, then this file, then `docs/SCHEMA.md` |
| Adding a verb | `AGENTS.md § runbook 1` |
| Adding a tag/type | `AGENTS.md § runbook 2`, `docs/SCHEMA.md` |
| Adding a fixture | `AGENTS.md § runbook 3`, `tests/fixtures/README.md` |
| Persona/CLI drift | `wiki persona-lint`, `docs/persona/*.template.md`, `docs/PERSONA.template.md` |
