# Scheduling — runtime-independent (OS cron / launchd)

Scheduled jobs do **not** belong to any agent runtime. They run from the OS scheduler (launchd on macOS, cron on Linux), so they survive nanoclaw upgrades and don't depend on any agent being up. This replaces the older model where nanoclaw owned scheduling via `schedule_task` (fragile: the task table can drop on upgrade).

## Jobs

| Job | Needs an agent? | How it runs |
|---|---|---|
| **Daily brief** (07:00) | **No** — deterministic | `run-daily-brief.sh`: composes the brief once and fans it out to `bin/email-digest` (email) and, if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, `bin/telegram-send` (a Telegram note in the same chat). Pure composition; most robust. |
| **Reminder dispatch** (every 15 min) | **No** — deterministic | `run-reminder-dispatch.sh`: `bin/reminder-dispatch \| bin/telegram-send`. Fires vault todos whose `remind_at` is due; idempotent (stamps `reminded_at`). Silent when nothing is due. |
| **Vault backup push** (daily 22:00) | **No** — deterministic | `tools/vault-backup-push.sh <vault>`: pushes the vault to its git `origin` if ahead. No-op when in sync. For a local vault this **is** the backup — without it the remote silently falls behind. |
| **Weekly review** (Mon 09:00) | **Yes** — synthesis | `run-weekly-review.sh`: `claude -p "...weekly routine..."` (loads Alfred from `AGENTS.md`) piped to `email-digest`. Swap `claude -p` for `codex exec` if preferred. |

All but the weekly are runtime-independent and need no LLM; the weekly invokes a *headless* agent on demand, not a persistent runtime.

## Install (macOS / launchd)

1. Edit `run-daily-brief.sh` / `run-weekly-review.sh` (or set `ALFRED_VAULT` + `ENV_FILE`). `ENV_FILE` is a file exporting `EMAIL_FROM` + `GMAIL_APP_PASSWORD` — secrets stay there, never in the plist.
2. Edit the absolute paths in `com.alfred.daily-brief.plist`.
3. Install:
   ```sh
   cp com.alfred.daily-brief.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.alfred.daily-brief.plist
   launchctl start com.alfred.daily-brief   # test-fire now
   ```
4. For the weekly, make a parallel plist (Hour 9, Weekday 1) pointing at `run-weekly-review.sh`.
5. For reminders, install `com.alfred.reminder-dispatch.plist` the same way (it fires every 15 min via `StartInterval`). `ENV_FILE` must also export `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (see `../../docs/TELEGRAM.md`).
6. For backups, install `com.alfred.vault-backup-push.plist` (edit the script path + the vault-dir argument). Your git credential helper must let an unattended `git push` authenticate (macOS osxkeychain, or an SSH remote). This keeps the git remote — the actual backup for a local vault — current.

> Tip: launchd jobs only fire while the Mac is awake. A missed `StartInterval` tick coalesces and runs once on wake (late, not lost); a `StartCalendarInterval` job runs at the next wake after its time. Delivery is therefore as reliable as the machine being on — true of any host-side scheduler.

## Linux (cron) equivalent

```cron
0 7 * * *    ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-daily-brief.sh
*/15 * * * * ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-reminder-dispatch.sh
0 22 * * *   /path/to/alfred_assistant/tools/vault-backup-push.sh /path/to/vault
0 9 * * 1    ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-weekly-review.sh
```

## Why not nanoclaw `schedule_task`?

It coupled a runtime-independent job to one always-on runtime, and the task table is lost on some nanoclaw upgrades (you must re-bootstrap). OS cron has neither problem. The nanoclaw `schedule_task` path still works if you prefer it — it's just no longer the recommended default. See `../nanoclaw/README.md`.
