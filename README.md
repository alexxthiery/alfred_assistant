# Alfred Assistant

A typed-graph personal-knowledge CLI plus a portable agent persona that can drive it.

The core is `bin/wiki`: a zero-dependency CLI that turns a markdown vault into a schema-enforced graph. Humans can use the CLI directly, and agent runtimes can use the same CLI through a generated vault persona. Durable writes go through `wiki ingest`, `wiki patch`, `wiki todo`, and related verbs; the assistant should not hand-edit markdown cards.

Vault content lives outside this repo. This repo contains the CLI, schema, generated-persona source, runtime adapters, scheduled-job wrappers, docs, and tests.

## Design

Alfred is built around a few hard constraints:

- **Typed graph, not loose notes.** Pages are atomic entities, concepts, events, todos, sources, or syntheses. Relations are typed and queryable.
- **Epistemic discipline.** Observations distinguish facts, opinions, hypotheses, predictions, decisions, and questions, with provenance and stable ids.
- **CLI-only writes.** `bin/wiki` owns schema validation, audit checks, autolink, inverse relation closure, and auto-commit.
- **Determinism where possible.** Daily brief, reminders, backups, and watchdog jobs are deterministic. Agents are used only for judgment-shaped work.
- **One vault is one security cell.** Each assistant gets its own vault, env file, Telegram bot, scheduler label, private logs, and runtime mount.

See [`docs/PHILOSOPHY.md`](docs/PHILOSOPHY.md) for the full design rationale.

## Capabilities

- `wiki`: typed-graph CRUD, search, context, relations, audit, review, SQL, todo, agenda, timeline, and maintenance verbs.
- Generated runtime persona: `docs/persona/*.template.md` assembled into each vault's `AGENTS.md`, with optional vault-local overlays.
- Scheduled routines: daily brief, daily check-ins, email review, conversation fact ingestion, reminder dispatch, weekly review, backup push, and Docker watchdog.
- Gmail tools: stateless IMAP recall plus bounded email review.
- Conversation tools: local-only transcript mirrors, compact Claude JSONL deltas, and conservative fact ingestion through the normal `wiki` pipeline.
- Multi-assistant support: several independent vault-backed assistants can run on one host.

Primary docs:

| Topic | Doc |
|---|---|
| Vault schema and microsyntax | [`docs/SCHEMA.md`](docs/SCHEMA.md) |
| Repo orientation for coding agents | [`AGENTS.md`](AGENTS.md) |
| Compact project map | [`.claude/codemap.md`](.claude/codemap.md) |
| Runtime persona assembly | [`docs/PERSONA-ASSEMBLY.md`](docs/PERSONA-ASSEMBLY.md) |
| Scheduled jobs | [`integrations/scheduling/README.md`](integrations/scheduling/README.md) |
| Multi-assistant isolation | [`docs/MULTI-ASSISTANT.md`](docs/MULTI-ASSISTANT.md) |
| Secrets and credentials | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Conversation logging | [`docs/CONVERSATION-LOGGING.md`](docs/CONVERSATION-LOGGING.md) |
| Conversation ingestion | [`docs/CONVERSATION-INGEST.md`](docs/CONVERSATION-INGEST.md) |
| NanoClaw integration and upgrades | [`docs/NANOCLAW-INTEGRATION.md`](docs/NANOCLAW-INTEGRATION.md), [`docs/NANOCLAW-UPGRADE-RUNBOOK.md`](docs/NANOCLAW-UPGRADE-RUNBOOK.md), [`docs/NANOCLAW-PROMOTION.md`](docs/NANOCLAW-PROMOTION.md) |

## Quickstart

```bash
git clone https://github.com/alexxthiery/alfred_assistant.git
cd alfred_assistant

mkdir -p ~/my-vault/wiki
cp examples/.alfred.yml.example ~/my-vault/.alfred.yml
$EDITOR ~/my-vault/.alfred.yml

# CLI-only install
./install.sh ~/my-vault

# Full assistant deployment: CLI + generated persona + policy docs
tools/deploy.sh \
  --target ~/my-vault \
  --user-name "Me" \
  --user-slug me \
  --assistant-name Alfred \
  --apply

cd ~/my-vault
wiki preflight
wiki list
```

Secrets and scheduler bindings belong in `<vault>/.alfred/private/env`, not in `.alfred.yml` and not in a shared host env file.

## Development

```bash
npm test
npm run test:unit
npm run test:fixtures
npm run test:gmail
```

Before changing a verb, read `AGENTS.md` and open the owning `bin/commands/<group>.js` module rather than reading `bin/wiki` end to end. Before changing scheduled jobs, read `integrations/scheduling/README.md`.

## PII Discipline

This repo was extracted from a personal system. The pre-commit hook runs `tools/scan-pii.sh` to block personal data and secrets. Keep local patterns in `tools/pii-list.local.txt` and never commit vault-private files, `.alfred/private/`, runtime logs, or credentials.

## License

MIT. See [`LICENSE`](LICENSE).
