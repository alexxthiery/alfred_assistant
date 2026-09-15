# Scheduling — runtime-independent (OS cron / launchd)

Scheduled jobs do **not** belong to any agent runtime. They run from the OS scheduler (launchd on macOS, cron on Linux), so they survive nanoclaw upgrades and don't depend on any agent being up. This replaces the older model where nanoclaw owned scheduling via `schedule_task` (fragile: the task table can drop on upgrade).

## Jobs

| Job | Needs an agent? | How it runs |
|---|---|---|
| **Daily brief** (07:00) | **No** — deterministic | `run-daily-brief.sh`: composes the brief once and fans it out to `bin/email-digest` (email) and, if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, `bin/telegram-send` (a Telegram note in the same chat). Channel failures are isolated, logged to `cache/daily-brief/send.log`, and retried once after 3 hours by default. |
| **Daily check-ins** (07:00 / 17:00 / 22:00) | **Yes** — conversational judgment | `run-daily-checkin.sh --slot morning|afternoon|evening`: asks a headless agent for one short, natural Telegram check-in, using `AGENTS.md`, read-only `wiki` context, and `cache/daily-checkin/checkins.jsonl` to avoid repetition. It never writes to the vault; replies are handled by the normal Telegram runtime. |
| **Email review** (10:00) | **Yes** — triage + judgment | `run-email-review.sh`: runs `.bin/email-review --days 1 --max-questions 7 --record-ledger` directly from the scheduler wrapper, then passes the metadata-only report to a headless Alfred with `AGENTS.md` + `persona/email-review.md`. The agent is not asked to run Gmail commands, so the job does not depend on a non-interactive shell-command allowlist. It sends only concrete questions or useful updates to Telegram. |
| **Conversation fact ingestion** (21:30) | **Yes** — conservative extraction | `run-conversation-ingest.sh`: optionally mirrors runtime transcripts with `wiki conversation-log import`, then asks a headless agent to ingest only durable low-risk facts through `.bin/wiki ingest` / `.bin/wiki patch` / `.bin/wiki todo`, following `persona/conversation-ingest.md`. It sends Telegram only for concrete clarification questions. |
| **Reminder dispatch** (every 15 min) | **No** — deterministic | `run-reminder-dispatch.sh`: `bin/reminder-dispatch \| bin/telegram-send`. Fires vault todos whose `remind_at` is due; idempotent (stamps `reminded_at`). Silent when nothing is due. |
| **Vault backup push** (daily 22:00) | **No** — deterministic | `tools/vault-backup-push.sh <vault>`: pushes the vault to its git `origin` if ahead. No-op when in sync. For a local vault this **is** the backup — without it the remote silently falls behind. |
| **Weekly review** (Mon 09:00) | **Yes** — synthesis | `run-weekly-review.sh`: `claude -p "...weekly routine..."` (loads Alfred from `AGENTS.md`) piped to `email-digest`. Swap `claude -p` for `codex exec` if preferred. |
| **Docker watchdog** (every 2 min) | **No** — deterministic | `.bin/docker-watchdog` (decision core unit-tested in `bin/lib/docker-watchdog.js`): probes the OneCLI gateway (`:10254`) that the agent runtime needs to spawn containers. If it is unreachable, nudges the compose stack (daemon up) or restarts Docker Desktop (daemon down, rate-limited). **macOS only** — guards against the Docker Desktop engine wedging (the agent goes silent until restarted). Silent when healthy. |

The daily brief, reminders, backup, and watchdog need no LLM. Daily check-ins, conversation fact ingestion, weekly review, and email review invoke a *headless* agent on demand, not a persistent runtime. The watchdog is infrastructure: it keeps the container backend alive so any agent can run at all.

This table is also the CLI's job manifest (`bin/lib/jobs.js`). Run `wiki jobs` to print it, and `wiki jobs --check` to validate what is actually installed for the default assistant label (`alfred`). On multi-vault hosts, run `wiki jobs --check --label <slug>` so the checker reads `~/Library/LaunchAgents/com.<slug>.*.plist` (and `crontab -l`) for the intended assistant. It reports each job as `ok` / `custom` (installed at a non-default time) / `missing` / `drift`. Drift is the actionable failure and exits nonzero: wrong wrapper, wrong `ALFRED_VAULT`, missing/wrong `ALFRED_ASSISTANT_LABEL`, `ENV_FILE` outside the active vault's `.alfred/private/`, or a backup job targeting the wrong vault. It is read-only: the OS scheduler stays the executor; `wiki jobs` never installs or edits a schedule.

## Methodology

Use this checklist before adding, changing, or debugging any scheduled Alfred routine:

1. **One scheduler:** use OS launchd/cron. Do not also create a nanoclaw `schedule_task` for the same routine.
2. **One wrapper per routine:** put wrappers in `integrations/scheduling/`, then copy them plus `assistant-binding.sh` to a launchd-safe directory such as `~/.local/bin` for real execution. Avoid CloudStorage/Dropbox/iCloud paths in installed jobs.
3. **No secrets in scheduler files:** plists and cron entries may name `ALFRED_VAULT`, `ALFRED_ASSISTANT_LABEL`, `ENV_FILE`, and `PATH`; credentials stay in `ENV_FILE`.
4. **Env files are vault-private:** every scheduled assistant env file must live under `<vault>/.alfred/private/`, must not be a symlink, and must export `ALFRED_EXPECTED_VAULT=/path/to/that/vault`, `ALFRED_EXPECTED_LABEL=<label>`, and `TZ=<IANA-zone>` such as `Asia/Singapore`. Wrappers refuse to source the file otherwise; the timezone keeps date-sensitive jobs correct even if a runtime default changes.
5. **Deterministic stays deterministic:** daily brief, reminders, backups, and watchdog should not invoke an LLM. Use a headless agent only for routines that need judgment, such as email review and weekly synthesis.
6. **Policy files are explicit:** if a headless agent runs, the wrapper prompt must point it at the relevant deployed instructions. Email review reads `AGENTS.md` plus `persona/email-review.md`; conversation fact ingestion reads `AGENTS.md` plus `persona/conversation-ingest.md`. The wrapper, not the agent, performs low-level data collection before invoking the agent when that collection has a deterministic tool.
   For nanoclaw/Claude conversation ingestion, do not assume
   `groups/<group>/conversations/` contains yesterday's chat: that directory is
   populated on compaction or session rotation. If the current transcript must
   be mirrored daily, configure `ALFRED_CONVERSATION_SOURCE` to the live
   `.claude-shared/projects/...` JSONL directory and set
   `ALFRED_CONVERSATION_SOURCE_EXTENSIONS=jsonl` plus
   `ALFRED_CONVERSATION_EXTRACT=claude-jsonl`. If that directory contains
   subagent transcripts, also set `ALFRED_CONVERSATION_EXCLUDE_DIRS=subagents`.
   The extractor keeps a cursor and writes compact `deltas/YYYY-MM-DD.jsonl`
   files, so the agent reviews only new user/assistant text rather than the full
   Claude execution transcript.
7. **Manifest or it does not exist:** every expected job belongs in `bin/lib/jobs.js`; `wiki jobs --check --label <label>` is the source of truth for drift on multi-assistant hosts.
8. **Installer first:** prefer `tools/install-assistant-jobs.sh` for real machines. It refuses env files outside the vault private directory, env files internally bound to another vault/label, and env files without `TZ`. The committed `com.alfred.*.plist` files are examples and manual fallbacks.
9. **Verify after install:** run `plutil -lint`, `launchctl print gui/$(id -u)/com.<label>.<job>` on macOS, and `<vault>/.bin/wiki jobs --check --label <label>`.

## Install (macOS / launchd)

1. Put the wrappers and `assistant-binding.sh` in a launchd-safe directory such as `~/.local/bin`. Avoid pointing launchd at files under CloudStorage/Dropbox/iCloud paths.
2. Install expected jobs through the shared installer. Use one label namespace per assistant:
   ```sh
   tools/install-assistant-jobs.sh \
     --vault /path/to/vault \
     --env /path/to/vault/.alfred/private/env \
     --label alfred \
     --brief 07:00 \
     --morning-checkin 07:00 \
     --afternoon-checkin 17:00 \
     --evening-checkin 22:00 \
     --email-review 10:00 \
     --conversation-ingest 21:30 \
     --weekly 09:00 \
     --wrappers ~/.local/bin
   ```
3. `ENV_FILE` is a file under `<vault>/.alfred/private/` exporting the vault binding (`ALFRED_EXPECTED_VAULT`, `ALFRED_EXPECTED_LABEL`), timezone (`TZ`), plus mail/Telegram credentials (`EMAIL_FROM`, `GMAIL_APP_PASSWORD`, `GMAIL_IMAP_APP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) as needed — secrets stay there, never in the plist. Email review specifically needs `EMAIL_FROM`, `GMAIL_IMAP_APP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`.
   For a Telegram-only daily brief, set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` and omit `EMAIL_FROM`; the wrapper will not attempt email.
4. Weekly review needs `EMAIL_FROM` and `GMAIL_APP_PASSWORD`, and uses a headless agent from `PATH`.
5. The committed `com.alfred.*.plist` files are manual-install examples. Prefer the installer for real machines because it resolves wrapper paths, injects `ALFRED_VAULT` / `ALFRED_ASSISTANT_LABEL` / `ENV_FILE`, and keeps the generated jobs consistent. For a second assistant, use a different `--label` and that vault's private env file, e.g. `--label child --env ~/child-vault/.alfred/private/env`.
6. For reminders, install `com.alfred.reminder-dispatch.plist` the same way (it fires every 15 min via `StartInterval`). `ENV_FILE` must also export `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (see `../../docs/TELEGRAM.md`).
7. For backups, install `com.alfred.vault-backup-push.plist` (edit the script path + the vault-dir argument). Your git credential helper must let an unattended `git push` authenticate (macOS osxkeychain, or an SSH remote). This keeps the git remote — the actual backup for a local vault — current.
8. For the Docker watchdog (recommended if the agent runtime — e.g. nanoclaw — depends on Docker), point `com.alfred.docker-watchdog.plist` at the **deployed** worker `<vault>/.bin/docker-watchdog` (run `tools/deploy.sh` first so it exists), then:
   ```sh
   cp com.alfred.docker-watchdog.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.alfred.docker-watchdog.plist
   wiki jobs --check --label alfred          # should now report docker-watchdog: ok
   ```
   It needs no secrets and does not touch the vault — it only probes `:10254` and, on failure, restarts Docker. It logs (only when it acts) to `~/Library/Logs/docker-onecli-watchdog.log`. It is **macOS-specific** (uses `osascript`/`open` to restart Docker Desktop); on Linux, `dockerd` under systemd already self-restarts, so skip it there. To pause it: `launchctl bootout gui/$(id -u)/com.alfred.docker-watchdog`.

   > **Why the deployed `.bin/` copy, not the repo path:** a macOS LaunchAgent cannot execute files under `~/Library/CloudStorage` (Dropbox/iCloud). If your repo lives there, pointing launchd at it fails with `Operation not permitted`. `tools/deploy.sh` copies the worker to `<vault>/.bin/` — a plain path launchd can run. (Same reason the other jobs invoke `<vault>/.bin/...`.)

> Tip: launchd jobs only fire while the Mac is awake. A missed `StartInterval` tick coalesces and runs once on wake (late, not lost); a `StartCalendarInterval` job runs at the next wake after its time. Delivery is therefore as reliable as the machine being on — true of any host-side scheduler.

## Linux (cron) equivalent

```cron
0 7 * * *    ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-daily-brief.sh
0 7 * * *    ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-daily-checkin.sh --slot morning
0 17 * * *   ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-daily-checkin.sh --slot afternoon
0 22 * * *   ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-daily-checkin.sh --slot evening
*/15 * * * * ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-reminder-dispatch.sh
0 22 * * *   /path/to/alfred_assistant/tools/vault-backup-push.sh /path/to/vault
0 9 * * 1    ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-weekly-review.sh
0 10 * * *   ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-email-review.sh
30 21 * * *  ALFRED_VAULT=/path/to/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/path/to/vault/.alfred/private/env /path/to/run-conversation-ingest.sh
```

## Why not nanoclaw `schedule_task`?

It coupled a runtime-independent job to one always-on runtime, and the task table is lost on some nanoclaw upgrades (you must re-bootstrap). OS cron has neither problem. The nanoclaw `schedule_task` path still works if you prefer it — it's just no longer the recommended default. See `../nanoclaw/README.md`.
