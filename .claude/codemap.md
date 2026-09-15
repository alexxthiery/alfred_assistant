# Codemap: alfred_assistant

> Auto-maintained by Claude. Last updated: 2026-09-15

## Structure

```text
.
├── bin/                    # CLI entrypoints, command handlers, pure libraries
│   ├── commands/           # write/edit/ingest/jobs/etc. verb handlers
│   ├── lib/                # reusable helpers; most unit-tested logic lives here
│   └── verbs/              # read-only verb handlers
├── docs/                   # schema, design, runtime, scheduler, and feature docs
│   └── persona/            # source fragments for generated vault AGENTS.md
├── examples/               # .alfred.yml template and small example vault
├── integrations/           # runtime adapters and OS-scheduled wrappers
│   └── scheduling/         # launchd/cron wrappers + methodology
├── schemas/                # JSON schema for wiki ingest specs
├── tests/                  # node:test unit tests, fixture suite, seed vault
└── tools/                  # deploy, persona rendering, isolation, gates, hooks
```

## Modules

| Path | Purpose |
|------|---------|
| `bin/wiki` | CLI entrypoint: argv parse, dispatch, help, tamper/auto-commit gating. |
| `bin/commands/*.js` | Verb handlers. Open the owning module instead of reading `bin/wiki` end-to-end. |
| `bin/lib/*.js` | Pure/shared logic: schema, audit, graph, frontmatter, jobs, conversation logs, persona rendering, vault binding. |
| `integrations/scheduling/*.sh` | Host-scheduled routines. Wrappers source vault-private env files and enforce assistant binding. |
| `docs/persona/*.template.md` | Runtime persona fragments assembled into `docs/PERSONA.template.md`. |
| `tests/unit/*.test.js` | Unit coverage for helpers, wrappers, installers, and tools. |
| `tests/fixtures/*.json` | End-to-end CLI fixtures against `tests/vault/`. |
| `tools/check-assistant-isolation.js` | Multi-vault safety preflight for env, deployed CLI, job labels, and sibling-vault access. |
| `tools/deploy.sh` | Copies runtime CLI/docs/persona policy into one target vault. |
| `tools/install-assistant-jobs.sh` | Generates/loads launchd jobs for one assistant label. |

## Entry Points

- **CLI:** `bin/wiki`; deployed to each vault as `<vault>/.bin/wiki`.
- **Assistant deployment:** `tools/deploy.sh`.
- **Scheduled jobs:** `integrations/scheduling/run-*.sh`; installed by `tools/install-assistant-jobs.sh`.
- **Persona rendering:** `tools/render-persona.sh`; fragments in `docs/persona/`.
- **Tests:** `npm test` (unit + fixture + Gmail/email-review tests), `bin/wiki-test`, `npm run test:unit`.
- **NanoClaw upgrade safety:** `npm run nanoclaw:gate`, `npm run nanoclaw:smoke`, `npm run nanoclaw:canary-env`.

## Patterns

- Zero production npm dependencies; Node stdlib for runtime code.
- `bin/wiki` is a thin dispatcher; behavior belongs in command modules and pure helpers.
- `docs/SCHEMA.md` is the closed-set vault contract and is parsed at runtime.
- All durable vault writes go through `wiki`; never edit `wiki/*.md` directly.
- Multi-assistant hosts use one vault-private env file and one scheduler label per assistant.
- Local evidence mirrors live under `.alfred/private/` or `cache/`; durable knowledge lives in `wiki/`.

## Dependencies

Key host tools: Node >=18, Python 3 stdlib for Gmail/email-review CLIs, git, launchd/cron for scheduled jobs, optional DuckDB CLI for SQL/search acceleration, optional NanoClaw for Telegram runtime.
