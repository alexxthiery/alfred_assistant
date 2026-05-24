# Running multiple assistants on one machine

One Mac + one nanoclaw can host several independent assistants (e.g. a family:
each person their own). They share the runtime and — today — one Telegram bot,
but each has its **own vault, memory, persona, name, reminders, and brief**.
This is the supported multi-tenant model; adding one is config-only.

## What's shared vs separate

| Shared (one per machine) | Separate (one per assistant) |
|---|---|
| The Mac + nanoclaw daemon | Vault folder (own memory, todos, notes) |
| **The Telegram bot** (`TELEGRAM_BOT_TOKEN`) | nanoclaw agent group + container + persona + name |
| The deployed CLI source (one repo) | `.alfred.yml` identity; `AGENTS.md` persona |
| | Telegram **chat** (routed by chat id) |
| | Host cron jobs (brief / reminders / backup) |
| | Per-assistant env file `~/nanoclaw/.env.<slug>` |

Routing: nanoclaw maps an inbound Telegram **chat id** → an agent group, so each
person talks to the same bot from their own account and reaches their own
assistant. The only thing not separable today is the bot's @handle (see
[Per-person bots](#per-person-bots-future)).

## Prerequisite: host wrappers

The launchd jobs call generic wrappers. Copy them once to `~/.local/bin/` (they
take the vault + env file from the plist, so one copy serves all assistants):

```sh
cp integrations/scheduling/run-daily-brief.sh \
   integrations/scheduling/run-reminder-dispatch.sh \
   tools/vault-backup-push.sh  ~/.local/bin/
chmod +x ~/.local/bin/run-*.sh ~/.local/bin/vault-backup-push.sh
```

## Add an assistant (`<slug>` = e.g. `leo`)

1. **Vault** — deploy the CLI + identity into a new vault:
   ```sh
   tools/deploy.sh --target ~/<slug>-vault \
     --user-name "<Name>" --user-slug <slug> --user-tz-city "<City>" --apply
   ```
   This seeds `.alfred.yml`, a clean `.gitignore`, and `.bin/`. Write the
   assistant's `AGENTS.md` persona (its own name + voice — start from an existing
   one). Then `git init`, add a private remote, and commit.

2. **Mount allowlist** — add the vault to `~/.config/nanoclaw/mount-allowlist.json`:
   ```json
   { "path": "~/<slug>-vault", "allowReadWrite": true, "description": "<Name>'s vault" }
   ```

3. **nanoclaw agent group + Telegram** (supported flow):
   ```sh
   cd ~/nanoclaw
   pnpm exec tsx setup/pair-telegram.ts --intent new-agent:<slug>-chat
   ```
   The person sends the printed code **from their own Telegram account** — this
   captures their chat id and creates the agent group + binding. Then name it:
   ```sh
   ncl groups config update --id <new-agent-group-id> --assistant-name "<AssistantName>"
   ```

4. **Vault mount** (the one step with no CLI) — point the group at its vault:
   ```sh
   pnpm exec tsx scripts/q.ts data/v2.db \
     "UPDATE container_configs SET additional_mounts =
       '[{\"hostPath\":\"~/<slug>-vault\",\"containerPath\":\"vault\",\"readonly\":false}]'
      WHERE agent_group_id = '<new-agent-group-id>'"
   ncl groups restart --id <new-agent-group-id>
   ```

5. **Env file** — `~/nanoclaw/.env.<slug>` with whichever channels apply:
   ```sh
   TELEGRAM_BOT_TOKEN=<the shared bot token>
   TELEGRAM_CHAT_ID=<this person's chat id, from step 3>
   # Optional email brief (omit for Telegram-only, e.g. a kid):
   # EMAIL_FROM=them@example.com
   # GMAIL_APP_PASSWORD=<16-char app password>
   ```

6. **Host jobs** — one command stamps + loads their launchd jobs:
   ```sh
   tools/install-assistant-jobs.sh \
     --vault ~/<slug>-vault --env ~/nanoclaw/.env.<slug> --label <slug> \
     --reminders --brief 07:00 --backup 22:00
   ```
   The brief auto-detects channels: with only `TELEGRAM_*` set it sends a
   **Telegram-only** brief; with `EMAIL_FROM` too, both. `--dry-run` previews the
   plists; `--uninstall` removes them.

Done — the person messages the bot from their account and reaches their own
assistant + vault; reminders and brief go to their chat.

## Per-person bots (future)

This nanoclaw runs a **single** `TELEGRAM_BOT_TOKEN` (`src/channels/telegram.ts`),
so all assistants currently share one bot @handle (routing is by chat id). A
dedicated @handle per person needs nanoclaw to support **multiple bot tokens** —
best done by upstreaming multi-bot support to nanoclaw, not a local fork (which
becomes upgrade debt). When added, existing vaults/agent-groups/jobs carry over
unchanged; only the bot binding changes. Until then, the shared-bot model above
gives a fully separate assistant in every other respect.

## See also
- `integrations/scheduling/README.md` — the host-job model + plist details.
- `docs/TELEGRAM.md` / `docs/REMINDERS.md` / `docs/DAILY-BRIEF.md` — per-feature setup.
- `docs/NANOCLAW-PATCHES.md` — the nanoclaw-side patches this assumes.
