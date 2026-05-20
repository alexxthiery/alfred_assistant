# Scheduling — runtime-independent (OS cron / launchd)

Scheduled jobs do **not** belong to any agent runtime. They run from the OS scheduler (launchd on macOS, cron on Linux), so they survive nanoclaw upgrades and don't depend on any agent being up. This replaces the older model where nanoclaw owned scheduling via `schedule_task` (fragile: the task table can drop on upgrade).

## Two jobs, two natures

| Job | Needs an agent? | How it runs |
|---|---|---|
| **Daily brief** (07:00) | **No** — deterministic | `run-daily-brief.sh`: `bin/daily-brief \| bin/email-digest`. Pure composition; most robust. |
| **Weekly review** (Mon 09:00) | **Yes** — synthesis | `run-weekly-review.sh`: `claude -p "...weekly routine..."` (loads Alfred from `AGENTS.md`) piped to `email-digest`. Swap `claude -p` for `codex exec` if preferred. |

Both are runtime-independent: the daily needs no LLM at all; the weekly invokes a *headless* agent on demand, not a persistent runtime.

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

## Linux (cron) equivalent

```cron
0 7 * * *  ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-daily-brief.sh
0 9 * * 1  ALFRED_VAULT=/path/to/vault ENV_FILE=/path/to/.env /path/to/run-weekly-review.sh
```

## Why not nanoclaw `schedule_task`?

It coupled a runtime-independent job to one always-on runtime, and the task table is lost on some nanoclaw upgrades (you must re-bootstrap). OS cron has neither problem. The nanoclaw `schedule_task` path still works if you prefer it — it's just no longer the recommended default. See `../nanoclaw/README.md`.
