# Security — handling credentials

Alfred touches three kinds of secret: Gmail app passwords (SMTP send + IMAP read), optional X/Twitter session cookies for live reads, and the OneCLI/Anthropic proxy token. This document is the operating manual for handling them. It exists because credentials leaked three times during one setup session, every time through an avoidable channel. The rules below are not theoretical.

## Where each secret lives

| Secret | Env var | Stored in | Used by |
|---|---|---|---|
| Gmail SMTP-send app password | `GMAIL_APP_PASSWORD` | `~/nanoclaw/.env` | `bin/email-digest` (weekly digest, daily brief) |
| Gmail IMAP-read app password | `GMAIL_IMAP_APP_PASSWORD` | `~/nanoclaw/.env` | `bin/gmail` (Reflex 4 email recall), `bin/email-review` |
| Sender address | `EMAIL_FROM` | `~/nanoclaw/.env` | both of the above |
| X/Twitter auth cookie | `ALFRED_BIRD_AUTH_TOKEN` | `~/nanoclaw/.env` or host shell env | `bin/twitter-read` (live X/Twitter reads via `bird`) |
| X/Twitter CSRF cookie | `ALFRED_BIRD_CT0` | `~/nanoclaw/.env` or host shell env | `bin/twitter-read` (live X/Twitter reads via `bird`) |
| Telegram bot token | `TELEGRAM_BOT_TOKEN` | `~/nanoclaw/.env` | `bin/telegram-send` (reminder dispatch); also nanoclaw's own Telegram I/O |
| Telegram destination chat id | `TELEGRAM_CHAT_ID` | `~/nanoclaw/.env` | `bin/telegram-send` (reminder dispatch) — not a secret, but kept beside the token |
| Anthropic/OneCLI proxy token | injected by the OneCLI gateway | OneCLI keychain | the container's HTTPS proxy |

**The flow.** `~/nanoclaw/src/providers/claude.ts` reads a hardcoded allowlist of keys from `~/nanoclaw/.env` via `readEnvFile()` (which deliberately does NOT load them into `process.env`) and injects them into the agent container with docker `-e` flags. To add a new secret env var, you must extend that allowlist (see `docs/NANOCLAW-PATCHES.md` Patch 3) and rebuild nanoclaw. Putting a key in `.env` alone does nothing until it is allowlisted.

`.env` itself is gitignored and never committed. No secret should ever be written into a tracked file.

**Host-side jobs are exempt from the allowlist.** The reminder dispatcher (`integrations/scheduling/run-reminder-dispatch.sh`) runs from the OS scheduler, not inside the container, and sources `~/nanoclaw/.env` directly. So `TELEGRAM_CHAT_ID` (and the already-present `TELEGRAM_BOT_TOKEN`) work for `bin/telegram-send` without any `claude.ts` allowlist change — Patch 3 is only needed for secrets the in-container agent must read.

## The rules

These are absolute. Each maps to a real leak that happened.

1. **Never paste a secret into the agent chat.** Anything you type to Alfred (Telegram, web, CLI) is persisted to conversation logs on disk and may be sent to the model provider. A revoked password is still readable in those logs. If you need Alfred to use a secret, put it in `~/.env` yourself; do not hand it to him in a message.

2. **Never run `ps aux` (or any process dump) into the chat or a transcript.** The docker container is launched with `-e GMAIL_APP_PASSWORD=...` on its command line. `ps aux` prints that command line verbatim, secret included. Pasting that output leaks every `-e` value. If you must inspect process state, filter and mask first: `ps aux | grep ... | sed 's/=[^ ]*/=***/g'`.

3. **Never `grep` for a secret's literal value.** `grep "abcd1234..." ~` embeds the value in the command, which lands in shell history and, if pasted, in the chat. To check whether a key is set, match the variable NAME and mask the value: `grep "^GMAIL_IMAP" ~/nanoclaw/.env | sed 's/=.*/=***/'`.

4. **Type secrets only through `read -s`.** When writing a secret into a file, read it silently into a shell variable, write via the variable, then unset:
   ```sh
   read -s NEW_SECRET            # paste, Enter — no echo, no history
   echo "length: ${#NEW_SECRET}" # sanity-check (16 for Gmail app passwords)
   sed -i.bak "s|^KEY=.*|KEY=$NEW_SECRET|" ~/nanoclaw/.env
   unset NEW_SECRET
   ```
   The value never appears on screen, in history, or on a command line.

5. **Verify masked.** After writing, confirm presence without revealing the value:
   ```sh
   grep -E "^GMAIL_(APP|IMAP)_APP_PASSWORD" ~/nanoclaw/.env \
     | awk -F= '{print $1"="(length($2)>0?"***":"(empty)")}'
   ```

6. **Never give Alfred your X/Twitter password.** `bin/twitter-read` is designed around cookie/session auth, not password entry. If you need container-side live X/Twitter reads, set `ALFRED_BIRD_AUTH_TOKEN` and `ALFRED_BIRD_CT0` yourself in `.env`; do not paste them into chat, do not store them in `.alfred.yml`, and do not improvise another OAuth connector.

## Rotation and revocation

- **Mint separate app passwords per purpose** (`alfred-digest` for SMTP, `alfred-imap-read` for IMAP) at <https://myaccount.google.com/apppasswords>. Gmail does not actually scope app passwords by function, but distinct named entries let you revoke one without breaking the other. Revoking the IMAP password must not take down the morning brief.
- **Rotation is cheap** (about 30 seconds): mint new, write via rule 4, restart nanoclaw (`launchctl kickstart -k "gui/$(id -u)/com.nanoclaw-v2-<id>"`), stop the running container so a fresh one picks up the new env.
- **On any suspected leak, revoke immediately**, then mint fresh. Treat anything that appeared in a chat, screenshot, transcript, or pasted terminal output as compromised.

## After a leak: scrub local copies

Revoking at Google invalidates the password, but the plaintext string remains in nanoclaw's local conversation artifacts and will surface in backups, Dropbox sync, or anyone with read access to the home directory. After rotating, scrub:

```sh
# Find which artifacts contain a leaked value (run from a trusted shell;
# do NOT paste this command's output anywhere):
grep -rl "<leaked-value>" ~/nanoclaw/groups/*/conversations ~/nanoclaw/data 2>/dev/null

# Markdown / jsonl transcripts — redact in place:
grep -rl "<leaked-value>" ~/nanoclaw/groups/*/conversations 2>/dev/null \
  | while read -r f; do sed -i.bak "s/<leaked-value>/[REDACTED]/g" "$f"; done

# outbound.db is SQLite, not text — sed will not work. Inspect and UPDATE:
#   sqlite3 ~/nanoclaw/.../outbound.db
#   UPDATE <table> SET <col> = replace(<col>, '<leaked-value>', '[REDACTED]');
# or, if the history is not needed, delete the affected rows / the db file.
```

Substitute `<leaked-value>` only inside a trusted local shell; never echo it into chat. Delete the `.bak` files the `sed` leaves behind once you have verified the redaction.

## What is already done well

For the record, so this document is not read as a list of holes:

- Secrets are kept out of `process.env` (the `readEnvFile` dict pattern).
- `bin/email-digest` and `bin/gmail` never print or log the password.
- The allowlist in `claude.ts` means only the intended keys cross into the container, not the whole `.env`.
- `.gitignore` covers `.env`, `*.local.*`, `audit/`, and the PII scanner's pattern list.

The weak point is not the code. It is the human setup ritual, which is what this document hardens.

## See also

- `docs/NANOCLAW-PATCHES.md` — Patch 3 (env passthrough allowlist).
- `docs/WEEKLY-DIGEST.md`, `docs/GMAIL.md`, `docs/TWITTER.md` — per-feature credential setup.
