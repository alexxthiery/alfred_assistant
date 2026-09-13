# Weekly digest

A cron-scheduled task that runs every Monday morning, has Alfred review the vault's state, and emails you a three-section summary via Gmail SMTP. The whole pipeline is opt-in and entirely self-hosted. This job uses only the SMTP-send credential; IMAP-read credentials, if configured for email review, are separate.

This doc covers setup, troubleshooting, and the small set of moving parts that compose the digest.

## Pieces

| Piece | Where | Purpose |
|---|---|---|
| Cron task | OS launchd/cron (Monday 09:00, your timezone) | Fires the routine |
| Composition routine | `docs/PERSONA.template.md` § "Weekly routine" | Tells Alfred what to compute and how to format the email |
| `bin/email-digest` | This repo | Bash wrapper around `curl --url 'smtps://smtp.gmail.com:465'` |
| Gmail app password | `GMAIL_APP_PASSWORD` env var | SMTP-send credential used by this job |
| Recipient | `{{USER_EMAIL}}` (from `.alfred.yml`) | Where the digest is sent |

## Setup

### 1. Gmail app password

App passwords let third-party tools send mail through your Gmail account without giving them your real password or full account access.

1. Enable 2-factor authentication on the Gmail account (required to mint app passwords).
2. Go to <https://myaccount.google.com/apppasswords>.
3. Generate a new app password named "alfred-digest" (or similar).
4. Copy the 16-character string. **You won't see it again.**

Use a distinct named app password for SMTP send, e.g. `alfred-digest`. Gmail app passwords are not protocol-scoped by Google, so keep SMTP-send and IMAP-read credentials in separate env vars and revoke them independently if needed. App passwords cannot be used to log in to the web UI.

### 2. Environment variables

Add to the agent group's environment (typically `.env` mounted by `docker-compose` or sourced by the nanoclaw container):

```sh
EMAIL_FROM=you@example.com           # the Gmail address that owns the app password
GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx  # the 16-char string from step 1
```

Both vars are checked at `email-digest` invocation time; missing values produce a friendly error with a link to the app-password page.

### 3. Recipient

`.alfred.yml` at the vault root holds your contact info:

```yaml
user:
  email: you@example.com
```

This is what the persona references as `{{USER_EMAIL}}`. The sender (`EMAIL_FROM`) and the recipient can be the same Gmail address — you'd just be sending yourself the digest, which is the common case.

### 4. Schedule

**Recommended: OS cron / launchd (runtime-independent).** The weekly review needs synthesis (an agent), so the recipe runs a *headless* agent on demand — `claude -p "...weekly routine..."` (or `codex exec`) piped to `email-digest` — from the OS scheduler. Ready-made wrapper and installer live in [`../integrations/scheduling/`](../integrations/scheduling/) and [`../tools/install-assistant-jobs.sh`](../tools/install-assistant-jobs.sh). This does not depend on nanoclaw being up or its task table surviving upgrades.

**Legacy: nanoclaw `schedule_task`.** Historical setups may still have this. Do not create new nanoclaw scheduled tasks for weekly review; use the OS-scheduler path so `wiki jobs --check --label <assistant-label>` can detect drift.

## What Alfred does when it fires

The persona routine is documented in `docs/PERSONA.template.md` under "Weekly routine." The short version:

1. Runs `wiki review`, `wiki audit --all`, `wiki agenda upcoming`, plus a few SQL queries against the DuckDB cache.
2. Synthesises (not pastes) into a ≤40-line email body with three sections:
   - **Stats** — pages / open todos / audit issues / stale markers / pending inbox items (one line).
   - **Top promotion candidates** — 3 highest-ranked independent mentions, each with the surrounding sentence and the proposed slug.
   - **Action items** — 3 highest-leverage fixes from `wiki review` + `wiki audit`, imperative voice.
3. Pipes the body through `bin/email-digest --subject "Vault weekly digest, YYYY-MM-DD" --to {{USER_EMAIL}}`.

The 40-line cap and synthesis discipline are deliberate: the digest is meant to be readable on a phone in 30 seconds, not a dump of CLI output.

## Verifying the pipeline

`bin/email-digest --dry-run` validates the SMTP config end-to-end (env vars present, recipient parseable, Gmail SMTP reachable) without sending mail. Run it once after setup and again on container start to catch silently-broken credentials before Monday morning.

```sh
EMAIL_FROM=... GMAIL_APP_PASSWORD=... \
  echo "test" | bin/email-digest --dry-run --subject "test" --to "you@example.com"
```

If `--dry-run` reports OK and the Monday email still doesn't arrive, the failure is almost certainly:

- Cron task never fired — check nanoclaw's task list; re-bootstrap if missing.
- Persona routine errored before reaching `email-digest` — check the agent's logs around 09:00 Monday for the routine's transcript.
- SMTP succeeded but Gmail filed the message as spam — check the spam folder of the recipient account.

## Why Gmail SMTP and not a service like Mailgun or Postmark

- Zero new accounts to sign up for and zero ongoing cost (Gmail's SMTP send limit, ~500/day, is enormous next to one weekly digest).
- App passwords give SMTP-only scope — strictly weaker than any OAuth flow that grants `gmail.send`, which also implies `gmail.compose` in most scopes.
- One credential lives entirely in your `.env`. Nothing to revoke through a third-party dashboard.

The tradeoff is brittle credential rotation: if Google ever forces 2FA app-password rotation, you need to mint a new one and restart the agent container.
