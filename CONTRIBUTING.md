# Contributing to alfred_assistant

The project is single-user-by-design, but pull requests + forks + issue reports are welcome. This doc covers the mechanical workflow.

## Workflow

```sh
# 1. Fork on GitHub, then clone your fork
git clone https://github.com/<your-username>/alfred_assistant.git
cd alfred_assistant

# 2. Install the pre-commit hook (PII scan + test suite)
ln -sfn ../../tools/pre-commit .git/hooks/pre-commit
# If a global core.hooksPath shadows the per-repo hook, override:
git config --local core.hooksPath .git/hooks

# 3. Create your local PII list (gitignored) — one pattern per line, patterns
# specific to your private content (names, emails, slugs, internal URLs).
# Used by tools/scan-pii.sh and the pre-commit hook to refuse leaks.
$EDITOR tools/pii-list.local.txt

# 4. Create a branch
git checkout -b your-feature-name

# 5. Make changes. Run the test suite often:
npm test                  # ~160 unit + ~27 fixture checks (count grows over time)
node bin/wiki preflight   # env/dep go/no-go in any test vault
node bin/wiki persona-lint  # catches doc-vs-CLI verb drift

# 6. Add a fixture if you added a verb or changed observable behavior
# See tests/fixtures/README.md + AGENTS.md runbook 3.

# 7. Commit (the pre-commit hook will scan staged files for PII)
git commit -m "[<area>] short message"

# 8. Push to your fork; open a PR against main
git push origin your-feature-name
gh pr create   # or use the web UI
```

## Commit conventions

Format: `[<area or audit-ID>] <imperative verb> <what changed>`

Examples from the project history:
- `[H05] auto-commit hardening: loud failures + --no-auto-commit + race doc`
- `[M12] add wiki preflight verb + fix loadSchema empty-sentinel bug`
- `[refactor] extract bin/lib/graph.js + 34 unit tests`

If your change resolves an audit item (BLOCKER/HIGH/MEDIUM/LOW/NIT), use the ID. Otherwise pick a one-word area: `feat`, `fix`, `refactor`, `docs`, `test`.

## What gets reviewed

The maintainer will look at, in order of priority:

1. **Behavior preservation.** `npm test` must stay green. If you broke a test, the PR should explain why and update the test deliberately.
2. **Schema-driven invariants.** SCHEMA.md is the contract — if you changed tag/type/verb behavior, edit SCHEMA.md too. `wiki persona-lint` should stay clean.
3. **No new runtime dependencies.** The CLI is Node stdlib only. Dev tooling (curl, duckdb, git) is fine.
4. **PII scan.** The pre-commit hook should refuse any leak before you push. If it fires, redact the offending content (don't suppress the scanner).

## Deprecation policy

Verbs and flags follow a two-release deprecation cycle:

| Release | What happens to a deprecated thing |
|---|---|
| vX.Y     | Warn on use (e.g. `(deprecated: use **wiki <new-verb>** instead)`). Still works. |
| vX.(Y+1) | Removed. Calling it produces an "unknown verb" / "unknown flag" error. |

Same applies to closed-set tags + types in SCHEMA.md and to frontmatter fields.

## Flag-rename policy

Renaming a CLI flag (e.g. `--soft` → `--lenient`) follows the deprecation cycle plus:

1. In vX.Y, both names work; the old name prints a deprecation warning.
2. The per-verb flag-alias map (M14 in the audit backlog) maps old → new with a one-line warning.
3. Document the rename in `CHANGELOG.md` under the release that introduces it.

## When to open an issue first

Before a PR, open an issue if:

- You want to add a new verb, tag, type, or relation verb (these change the closed-set contract).
- You want to add a runtime dependency.
- You want to change the auto-commit, persona-lint, or audit-rule semantics.
- You want to remove or rename a stable frontmatter field (per `docs/SCHEMA.md § Stable frontmatter contract`).

For typos, doc fixes, new tests, performance work, and bug fixes that don't change observable behavior — go straight to a PR.

## Local-only files (gitignored)

These are part of the project's normal state but never committed:

- `audit/` — audit findings + remediation tracker (this project's own history)
- `tools/pii-list.local.txt` — your local PII patterns
- `alfred/_persona.local.md` — the rendered persona template
- `wiki/`, `raw/`, `inbox/` — your actual vault content
- `<vault>/.bin/` — deployed runtime copy of this repo's CLIs
- `<vault>/.alfred/private/` — per-vault secrets and local-only debug logs
- `.env` — Gmail app password, Telegram bot token, etc.

If you find yourself wanting to commit anything from this list, stop and ask.
