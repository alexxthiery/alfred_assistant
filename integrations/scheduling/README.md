# Scheduling — runtime-independent (OS cron / launchd)

Scheduled jobs do **not** belong to any agent runtime. They run from the OS scheduler (launchd on macOS, cron on Linux), so they survive nanoclaw upgrades and don't depend on any agent being up. This replaces the older model where nanoclaw owned scheduling via `schedule_task` (fragile: the task table can drop on upgrade).

## Jobs

| Job | Needs an agent? | How it runs |
|---|---|---|
| **Daily brief** (07:00) | **No** — deterministic | `run-daily-brief.sh`: composes the brief once and fans it out to `bin/email-digest` (email) and, if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, `bin/telegram-send` (a Telegram note in the same chat). Channel failures are isolated, logged to `cache/daily-brief/send.log`, and retried once after 3 hours by default. |
| **Email review** (10:00) | **Yes** — triage + judgment | `run-email-review.sh`: runs `.bin/email-review --days 1 --max-questions 7 --record-ledger` directly from the scheduler wrapper, then passes the metadata-only report to a headless Alfred with `AGENTS.md` + `persona/email-review.md`. The agent is not asked to run Gmail commands, so the job does not depend on a non-interactive shell-command allowlist. It sends only concrete questions or useful updates to Telegram. |
| **Reminder dispatch** (every 15 min) | **No** — deterministic | `run-reminder-dispatch.sh`: `bin/reminder-dispatch \| bin/telegram-send`. Fires vault todos whose `remind_at` is due; idempotent (stamps `reminded_at`). Silent when nothing is due. |
| **Vault backup push** (daily 22:00) | **No** — deterministic | `tools/vault-backup-push.sh <vault>`: pushes the vault to its git `origin` if ahead. No-op when in sync. For a local vault this **is** the backup — without it the remote silently falls behind. |
| **Weekly review** (Mon 09:00) | **Yes** — synthesis | `run-weekly-review.sh`: `claude -p "...weekly routine..."` (loads Alfred from `AGENTS.md`) piped to `email-digest`. Swap `claude -p` for `codex exec` if preferred. |
| **Docker watchdog** (every 2 min) | **No** — deterministic | `.bin/docker-watchdog` (decision core unit-tested in `bin/lib/docker-watchdog.js`): probes the OneCLI gateway (`:10254`) that the agent runtime needs to spawn containers. If it is unreachable, nudges the compose stack (daemon up) or restarts Docker Desktop (daemon down, rate-limited). **macOS only** — guards against the Docker Desktop engine wedging (the agent goes silent until restarted). Silent when healthy. |

The daily brief, reminders, backup, and watchdog need no LLM. Weekly review and email review invoke a *headless* agent on demand, not a persistent runtime. The watchdog is infrastructure: it keeps the container backend alive so any agent can run at all.

This table is also the CLI's job manifest (`bin/lib/jobs.js`). Run `wiki jobs` to print it, and `wiki jobs --check` to validate what is actually installed: it reads your `~/Library/LaunchAgents/com.alfred.*.plist` (and `crontab -l`) and reports each job as `ok` / `custom` (installed at a non-default time) / `missing` / `drift` (installed but pointing at the wrong script — the one actionable failure, which exits nonzero). It is read-only: the OS scheduler stays the executor; `wiki jobs` never installs or edits a schedule.

## Methodology

Use this checklist before adding, changing, or debugging any scheduled Alfred routine:

1. **One scheduler:** use OS launchd/cron. Do not also create a nanoclaw `schedule_task` for the same routine.
2. **One wrapper per routine:** put wrappers in `integrations/scheduling/`, then copy them to a launchd-safe directory such as `~/.local/bin` for real execution. Avoid CloudStorage/Dropbox/iCloud paths in installed jobs.
3. **No secrets in scheduler files:** plists and cron entries may name `ALFRED_VAULT`, `ENV_FILE`, and `PATH`; credentials stay in `ENV_FILE`.
4. **Deterministic stays deterministic:** daily brief, reminders, backups, and watchdog should not invoke an LLM. Use a headless agent only for routines that need judgment, such as email review and weekly synthesis.
5. **Policy files are explicit:** if a headless agent runs, the wrapper prompt must point it at the relevant deployed instructions. Email review reads `AGENTS.md` plus `persona/email-review.md`; the wrapper, not the agent, performs the low-level `.bin/email-review` Gmail scan before invoking the agent.
6. **Manifest or it does not exist:** every expected job belongs in `bin/lib/jobs.js`; `wiki jobs --check` is the source of truth for drift.
7. **Installer first:** prefer `tools/install-assistant-jobs.sh` for real machines. The committed `com.alfred.*.plist` files are examples and manual fallbacks.
8. **Verify after install:** run `plutil -lint`, `launchctl print gui/$(id -u)/<label>` on macOS, and `<vault>/.bin/wiki jobs --check`.

## Install (macOS / launchd)

1. Put the wrappers in a launchd-safe directory such as `~/.local/bin`. Avoid pointing launchd at files under CloudStorage/Dropbox/iCloud paths.
2. Install expected jobs through the shared installer:
   ```sh
   tools/install-assistant-jobs.sh \
     --vault /path/to/vault \
     --env /path/to/nanoclaw/.env \
     --label alfred \
     --brief 07:00 \
     --email-review 10:00 \
     --weekly 09:00 \
     --wrappers ~/.local/bin
   ```
3. `ENV_FILE` is a file exporting mail/Telegram credentials (`EMAIL_FROM`, `GMAIL_APP_PASSWORD`, `GMAIL_IMAP_APP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) as needed — secrets stay there, never in the plist. Email review specifically needs `EMAIL_FROM`, `GMAIL_IMAP_APP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`.
4. Weekly review needs `EMAIL_FROM` and `GMAIL_APP_PASSWORD`, and uses a headless agent from `PATH`.
5. The committed `com.alfred.*.plist` files are manual-install examples. Prefer the installer for real machines because it resolves wrapper paths, injects `ALFRED_VAULT` / `ENV_FILE`, and keeps the generated jobs consistent.
6. For reminders, install `com.alfred.reminder-dispatch.plist` the same way (it fires every 15 min via `StartInterval`). `ENV_FILE` must also export `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (see `../../docs/TELEGRAM.md`).
7. For backups, install `com.alfred.vault-backup-push.plist` (edit the script path + the vault-dir argument). Your git credential helper must let an unattended `git push` authenticate (macOS osxkeychain, or an SSH remote). This keeps the git remote — the actual backup for a local vault — current.
8. For the Docker watchdog (recommended if the agent runtime — e.g. nanoclaw — depends on Docker), point `com.alfred.docker-watchdog.plist` at the **deployed** worker `<vault>/.bin/docker-watchdog` (run `tools/deploy.sh` first so it exists), then:
   ```sh
   cp com.alfred.docker-watchdog.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.alfred.docker-watchdog.plist
   wiki jobs --check          # should now report  docker-watchdog: ok
   ```
   It needs no secrets and does not touch the vault — it only probes `:10254` and, on failure, restarts Docker. It logs (only when it acts) to `~/Library/Logs/docker-onecli-watchdog.log`. It is **macOS-specific** (uses `osascript`/`open` to restart Docker Desktop); on Linux, `dockerd` under systemd already self-restarts, so skip it there. To pause it: `launchctl bootout gui/$(id -u)/com.alfred.docker-watchdog`.

   > **Why the deployed `.bin/` copy, not the repo path:** a macOS LaunchAgent cannot execute files under `~/Library/CloudStorage` (Dropbox/iCloud). If your repo lives there, pointing launchd at it fails with `Operation not permitted`. `tools/deploy.sh` copies the worker to `<vault>/.bin/` — a plain path launchd can run. (Same reason the other jobs invoke `<vault>/.bin/...`.)

> Tip: launchd jobs only fire while the Mac is awake. A missed `StartInterval` tick coalesces and runs once on wake (late, not lost); a `StartCalendarInterval` job runs at the next wake after its time. Delivery is therefore as reliable as the machine being on — true of any host-side scheduler.

## Linux (cron) equivalent

```cron
0 7 * * *    ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-daily-brief.sh
*/15 * * * * ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-reminder-dispatch.sh
0 22 * * *   /path/to/alfred_assistant/tools/vault-backup-push.sh /path/to/vault
0 9 * * 1    ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-weekly-review.sh
0 10 * * *   ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-email-review.sh
```

## Why not nanoclaw `schedule_task`?

It coupled a runtime-independent job to one always-on runtime, and the task table is lost on some nanoclaw upgrades (you must re-bootstrap). OS cron has neither problem. The nanoclaw `schedule_task` path still works if you prefer it — it's just no longer the recommended default. See `../nanoclaw/README.md`.
