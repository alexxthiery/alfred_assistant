# Reminders — the vault todo IS the reminder

A reminder is **not** a separate object. It is a `type: todo` page with a
`remind_at` datetime. One write covers both delivery channels; one query lists
them all; the slug is the identity, so reminders cannot duplicate or drift out
of sync. This replaces the older split where a Telegram reminder was a
`schedule_task` cron and the email reminder was a vault todo, with nothing
reconciling the two.

## The model

A reminder todo carries:

| Field | Meaning |
|---|---|
| `due` | The date the morning brief surfaces it (date granularity). |
| `remind_at` | ISO8601 datetime **with timezone offset** (e.g. `2026-05-23T14:00+08:00`). The Telegram fire time. |
| `notify` | csv, default `telegram,email`. Drop a channel by omitting it. |
| `reminded_at` | Set by the dispatcher when it fires. Its presence = "already sent" (idempotency). |

## Two channels, both deterministic, both reading the vault

- **Email** — the existing `daily-brief` (07:00) lists `wiki todo list
  --due-today`. A reminder with `due:` = its date appears that morning. After
  it has fired and its due date has passed, the brief hides it from the
  overdue section so one-shot reminders do not nag forever.
- **Telegram** — `bin/reminder-dispatch` (host cron, every 15 min) finds todos
  where `remind_at <= now`, `notify` includes `telegram`, and there is no
  `reminded_at` stamp; prints one line each; then stamps `reminded_at` via
  `wiki patch` so a re-run never double-sends. Piped into `bin/telegram-send`.

A reminder is **never lost**: if the cron was down, it fires (late) on the next
run. Late beats missed. (One-shot only in v1; recurrence is future work.)

The only non-deterministic step is the agent parsing "Saturday 2pm" into the
ISO `remind_at`. Everything after that is CLI + cron.

## Usage

```sh
# Create a timed reminder (one write, both channels):
wiki todo add "Pickleball booking" --due 2026-05-23 \
  --remind_at 2026-05-23T14:00+08:00            # notify defaults to telegram,email

# Email only (no Telegram push):
wiki todo add "Pay rent" --due 2026-06-01 --remind_at 2026-06-01T09:00+08:00 --notify email

# What reminders exist? (one query, one system)
wiki todo list --reminders

# Retime / restamp in place (same slug, no duplicate):
wiki patch <slug> --remind_at 2026-05-23T15:00+08:00

# Preview what would fire now without sending or stamping:
reminder-dispatch --dry-run

# Fire as of a fixed time (testing/determinism):
reminder-dispatch --now 2026-05-23T07:00:00Z
```

## Idempotency and the firing window

`reminder-dispatch` stamps `reminded_at` **after** emitting, so a crash
mid-emit will not mark a reminder sent. The residual risk: if `telegram-send`
fails *after* the stamp is written, that one reminder is not re-sent — but the
email channel still surfaced it on its due date. Acceptable for v1.

## Setup

1. Reminder fields + `reminder-dispatch` are part of the deployed CLI (vault
   `.bin/`). No extra setup for the email half.
2. For Telegram: set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in this
   assistant's private env file, `<vault>/.alfred/private/env` — see `docs/TELEGRAM.md`.
3. Install the `*/15` job — see `integrations/scheduling/` (`run-reminder-dispatch.sh`
   + the installer-generated `com.<label>.reminder-dispatch.plist`).

## See also

- `docs/TELEGRAM.md` — bot token + chat id.
- `docs/DAILY-BRIEF.md` — the email channel.
- `integrations/scheduling/README.md` — installing the cron/launchd jobs.
