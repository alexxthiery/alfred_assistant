# Daily morning brief

A cron-scheduled task that fires every morning at 07:00 (your timezone), runs `bin/daily-brief`, and emails you a short three-or-four-section summary via Gmail SMTP. Unlike the [weekly digest](WEEKLY-DIGEST.md), composition is **deterministic**: a tiny Node script (`bin/daily-brief`) calls the underlying CLI verbs and emits byte-identical output for identical vault state. Alfred is not in the format loop.

Trust the channel: even an empty day sends a "clean slate" email. Silence means the cron didn't fire; silence is never "nothing to report".

## Pieces

| Piece | Where | Purpose |
|---|---|---|
| Cron task | nanoclaw `schedule_task` (07:00 daily, your timezone) | Fires the routine |
| Composer | `bin/daily-brief` (Node, ~120 lines) | Runs four `wiki` subprocesses (step 0 `sync-ids` + three reads), parses output, emits formatted body |
| Pure formatter | `bin/lib/daily-brief.js` | Parses verb output + formats body. No I/O. Unit-tested |
| `bin/email-digest` | This repo (shared with weekly) | Bash wrapper around `curl --url 'smtps://smtp.gmail.com:465'` |
| Persona routine | `docs/PERSONA.template.md` § "Daily routine" | One short paragraph: pipe `daily-brief` into `email-digest`. No composition by Alfred |
| Cache log | `<vault>/cache/daily-brief/YYYY-MM-DD.txt` | Every emitted body persisted; `ls` answers "did it fire?" |

## What runs, in order

1. **Step 0 — `wiki sync-ids` (defensive, idempotent).** Mints any missing `<!--obs:XXXXXX-->` markers across the vault. ~1 second when coverage is already 100%; no-op in the steady state. Failure here is non-fatal — the brief still ships, but a warning lands on stderr. See **§ Why we mint defensively** below for the rationale.
2. **Step 1 — `wiki todo list --overdue`.** Open todos whose `due:` is in the past.
3. **Step 2 — `wiki todo list --due-today`.** Open todos whose `due:` matches today.
4. **Step 3 — `wiki agenda --on $(today)`.** Events + birthdays sharing today's MM-DD (any year).
5. **Compose** the deterministic body (see § What the email contains) and emit to stdout.
6. **Persist** a copy to `<vault>/cache/daily-brief/YYYY-MM-DD.txt` unless `--no-log`.

Steps 0 and 6 can be skipped with `--no-sync` and `--no-log` respectively (used by tests, never in production).

## What the email contains

Up to four sections, each capped at 5 items. Sections with zero items are omitted:

- **Overdue (N)** — open todo pages whose `due:` is in the past, oldest first.
- **Due today (N)** — open todo pages whose `due:` matches today.
- **Today's events (N)** — `type=event` pages whose `when:` shares today's MM-DD (any year — so recurring annual events also fire).
- **Birthdays today (N)** — pages with `born:` sharing today's MM-DD. Year-known entries show `(turns N)`.

If all four sections are empty, the body is exactly: `Clean slate today. Nothing overdue, nothing due, no events, no birthdays.`

## Sample output

```
$ bin/daily-brief --date 2026-06-22
Daily brief — 2026-06-22

Birthdays today (1):
  06-22 — [[carol]]
```

```
$ bin/daily-brief --date 2026-06-01
Daily brief — 2026-06-01

Today's events (1):
  2026-06-01 — [[meeting-team-offsite]]
```

## Setup

### 1. Reuse weekly-digest env vars

Same `EMAIL_FROM` + `GMAIL_APP_PASSWORD` as the [weekly digest](WEEKLY-DIGEST.md). Already configured? Skip this step.

### 2. Schedule

**Recommended: OS cron / launchd (runtime-independent).** The daily brief is deterministic (no agent), so run it straight from the OS scheduler. Ready-made wrapper + launchd plist are in [`../integrations/scheduling/`](../integrations/scheduling/) (`run-daily-brief.sh` + `com.alfred.daily-brief.plist`). Survives nanoclaw upgrades; doesn't depend on any agent being up.

**Legacy: nanoclaw `schedule_task`.** Alternatively, ask Alfred via Telegram to bootstrap it (`recurrence: "0 7 * * *"`, the "Daily routine" prompt). Works, but the task table can drop on a nanoclaw upgrade (then re-bootstrap). Prefer the OS-cron path.

### Timezone

The brief's "today" is computed in your local zone, resolved as `--tz` flag >
`$TZ` env > runtime default. **Pass `--tz <IANA-zone>` (or set `$TZ`) whenever
the runtime might be UTC** — notably the nanoclaw agent container, which does
not inherit `TZ`. Firing at 07:00 local is the previous calendar day in UTC, so
without a correct zone the brief lists *yesterday's* due todos and events. The
host wrapper (`run-daily-brief.sh`) sources `$TZ` from the env file and passes
`--tz` automatically.

### 3. Verify

Run the composer once by hand to confirm wiring:

```sh
bin/daily-brief --tz Asia/Singapore --no-log
```

Empty output is fine; clean-slate days are a valid output. If you see an error about `wiki` not found, check that `.bin/` is in your `$PATH` or that `daily-brief` is co-located with `wiki` (the resolver walks the sibling directory).

## Populating data

The brief only surfaces what the vault already knows. To make a relationship "rememberable":

```sh
# Birthday with known year:
wiki patch carol --born 1985-08-22

# Birthday with only MM-DD (e.g., friend whose birth year you don't know):
wiki patch firstlove --born 07-14

# Recurring annual event:
wiki write anniversary-wedding --type event --when 2015-06-22 \
  --title "Wedding anniversary" --tags event \
  --content "- [fact] seed ^[memory:2026-05-19]"

# Single-fire todo with a due date:
wiki todo add "Pay tax" --due 2026-05-21 --priority high
```

A **timed reminder** is just a todo with a `remind_at` (and `--notify`). Its
`due` date is what makes it appear in this brief; the `remind_at` time drives a
separate Telegram push via the reminder dispatcher. See `docs/REMINDERS.md`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No email on a morning | `nanoclaw` task table lost the cron | Re-bootstrap |
| Email arrives but is "clean slate" when you expected entries | The vault doesn't know yet | `wiki patch <slug> --born MM-DD`, `wiki todo add … --due …`, or `wiki write … --type event --when …` |
| `daily-brief: \`wiki ...\` failed` | `wiki` binary not resolvable from `daily-brief`'s neighbourhood | Ensure both are in the same `.bin/` (deploy.sh handles this; verify with `ls -la <vault>/.bin/`) |
| Birthday in MM-DD form not firing | Stored as `born: "07-14"` (quoted) — same; check shape regex matches `/^\d{2}-\d{2}$/` | `wiki patch <slug> --born 07-14` (unquoted YAML scalar) |
| Yesterday's brief missing from `cache/daily-brief/` | Either cron didn't fire (re-bootstrap) or `--no-log` was passed | Inspect nanoclaw task history |

## Why we mint defensively (step 0)

The CLI guarantees that every observation written through `wiki ingest`, `wiki write`, `wiki patch`, or `wiki capture` is stamped with a `<!--obs:XXXXXX-->` marker at write time. Markers are the stable handle the CLI uses for `--supersede`, FTS index keying, transclusion, and future diffing. The invariant we want: **every observation in the vault carries a marker**.

The CLI has held that invariant since the obs-id mint was added to all four `cmdIngest` `stagePage` sites (see Phase 13.x in `CHANGELOG.md`). So in a single-process world, the invariant would be automatic.

It is not a single-process world.

`wiki` is a Node script that lives in `bin/wiki` on the dev machine and is **copied** to `<vault>/.bin/wiki` by `tools/deploy.sh` for the runtime container (`nanoclaw`) that actually fields Alfred's Telegram-driven ingests. Between "dev machine has the fixed wiki" and "container's `.bin/wiki` is also the fixed wiki", there is a sync interval — bind-mount latency, Dropbox propagation, container caching, restart timing. During that interval, the container can run the **pre-fix** wiki against new ingests, and those observations land **unstamped**.

We learned this the hard way on 2026-05-19: the fix went live at 21:37 SGT; ingests at 21:45, 22:16, and 22:19 SGT produced 60 unstamped observations across 9 pages. The CLI was correct; the deployment was lagging.

`wiki sync-ids` is the existing repair: walks the vault, mints markers on any observation that lacks one. Idempotent. Cheap when there's nothing to do (~1s on a 200-page vault). The cost of running it daily is negligible; the cost of *not* running it is a slow drift away from the 100% coverage invariant, which silently breaks `--supersede` (which can't find an observation by id if it never got one).

So step 0 is a belt to go with the cmdIngest suspenders. Two independent paths reach the same invariant. If the deployment sync is fast, sync-ids has nothing to do and the brief proceeds in ~1 extra second. If the deployment sync was slow (or a future regression breaks the mint at write time), sync-ids closes the gap before anyone notices.

The alternatives I considered and rejected:

- **Round-trip verification in `tools/deploy.sh`**: ingest a throwaway stub on the target path, assert marker presence, delete. Works, but slow, intrusive, and only catches *the moment of deploy* — not later drift if the container's wiki state diverges for any other reason.
- **Root-cause the container's wiki-sync mechanism**: requires nanoclaw internals; out of scope for this repo and would not protect against future deployment-machinery changes.
- **Run sync-ids on every ingest**: too aggressive. The morning brief is the right cadence — it's the daily heartbeat that the vault is healthy.

If you ever want to *measure* the gap, run `.bin/wiki sync-ids --dry-run` ad-hoc. Sustained non-zero output means deployment sync is failing more than expected and warrants investigation.

## Why not put the composition in the persona?

The weekly digest's body IS composed by Alfred each fire — synthesis of `wiki review` + `wiki audit` benefits from his editorial judgment. The daily brief is the opposite: it lists facts the vault already knows, and we want byte-identical output every day. Putting composition in a Node script means:

- The format is testable (see `tests/unit/daily-brief.test.js`).
- The brief cannot hallucinate sections, miss a birthday, or change wording on a whim.
- Adding a future Telegram channel is one-line: swap `email-digest` for a `telegram-send` wrapper.
- The persona shrinks. It now just points at the script.

If you ever feel the daily brief is missing nuance (e.g. flagging a birthday with a one-line note about your last conversation), promote a section to Alfred-composed by adding a step to the persona that runs `bin/daily-brief` and *augments* its output — don't tear up the deterministic part.
