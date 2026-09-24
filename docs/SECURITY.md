# Security — handling credentials

Alfred touches two kinds of secret: Gmail app passwords (SMTP send + IMAP read) and the OneCLI/Anthropic proxy token. This document is the operating manual for handling them. It exists because credentials leaked three times during one setup session, every time through an avoidable channel. The rules below are not theoretical.

## Where each secret lives

| Secret | Env var | Stored in | Used by |
|---|---|---|---|
| Gmail SMTP-send app password | `GMAIL_APP_PASSWORD` | `<vault>/.alfred/private/env` | `bin/email-digest` (weekly digest, daily brief) |
| Gmail IMAP-read app password | `GMAIL_IMAP_APP_PASSWORD` | `<vault>/.alfred/private/env` | `bin/gmail` (Reflex 4 email recall), `bin/email-review` |
| Sender address | `EMAIL_FROM` | `<vault>/.alfred/private/env` | both of the above |
| Telegram bot token | `TELEGRAM_BOT_TOKEN` | `<vault>/.alfred/private/env` | `bin/telegram-send` (reminder dispatch); also the assistant's Telegram runtime |
| Telegram destination chat id | `TELEGRAM_CHAT_ID` | `<vault>/.alfred/private/env` | `bin/telegram-send` (reminder dispatch) — not a secret, but kept beside the token |
| GitHub push credential | n/a | `<vault>/.alfred/private/git-credentials` | git backup pushes from host jobs or in-container assistant workflows |
| Env-file vault binding | `ALFRED_EXPECTED_VAULT` | `<vault>/.alfred/private/env` | scheduled wrappers, `bin/wiki`, `bin/gmail`, `bin/email-review` |
| Env-file label binding | `ALFRED_EXPECTED_LABEL` | `<vault>/.alfred/private/env` | scheduled wrappers and isolation smoke checks |
| Anthropic/OneCLI proxy token | injected by the OneCLI gateway | OneCLI keychain | the container's HTTPS proxy |

**The flow.** The assistant runtime reads a hardcoded allowlist of keys from that assistant's env file via `readEnvFile()` (which deliberately does NOT load them into `process.env`) and injects them into the agent container with docker `-e` flags. In the legacy NanoClaw integration this allowlist is Patch 3 in `docs/NANOCLAW-PATCHES.md`; the target design is described in `docs/NANOCLAW-INTEGRATION.md`, where Alfred-specific secrets should cross into the container only when an in-container feature genuinely needs them. Putting a key in `.env` alone does nothing until it is allowlisted.

`<vault>/.alfred/private/` is gitignored and never committed. No secret should ever be written into a tracked file. Gitignored does **not** mean local-only: if the vault is under Dropbox, iCloud Drive, CloudStorage, Google Drive, OneDrive, or similar sync roots, private env files, conversation mirrors, and cache ledgers may still sync outside the machine. `wiki preflight` and `tools/deploy.sh` warn on common sync roots, but the operator must decide whether that storage location is acceptable.
Full conversation mirrors created by `wiki conversation-log` also live under
`<vault>/.alfred/private/conversations/`; they are local-only debug artifacts,
not git-backed vault content. See `docs/CONVERSATION-LOGGING.md`.

Each assistant env file must also declare the non-secret binding values:

```sh
ALFRED_EXPECTED_VAULT=/absolute/path/to/that/assistant-vault
ALFRED_EXPECTED_LABEL=<assistant-label>
```

Scheduled wrappers compare those values against the `ALFRED_VAULT` and
`ALFRED_ASSISTANT_LABEL` stamped into the scheduler entry. `bin/wiki`,
`bin/gmail`, and `bin/email-review` also refuse to run against a different
vault when `ALFRED_EXPECTED_VAULT` is present. This is the guard that prevents a
credential file from being accidentally reused with the wrong vault.

The env file must live under the owning vault's `.alfred/private/` directory and
must not be a symlink. Scheduled wrappers parse it as inert `KEY=VALUE` data and
reject shell syntax such as `export`, backticks, and command substitution. This
is deliberate: credentials are part of one vault's runtime cell, not shared host
state or executable shell configuration.

**Host-side jobs are exempt from the allowlist.** Scheduled wrappers (`integrations/scheduling/run-*.sh`) run from the OS scheduler, not inside the container, and parse the `ENV_FILE` named in the plist. They require `ALFRED_EXPECTED_VAULT` and `ALFRED_EXPECTED_LABEL` before touching email, Telegram, or vault writes. So `TELEGRAM_CHAT_ID` and `TELEGRAM_BOT_TOKEN` work for `bin/telegram-send` without any container allowlist change. Patch 3 is only needed for secrets the in-container agent must read.

**GitHub backup credentials are vault-private too.** Do not rely on a shared
host `~/.git-credentials` file for vault backup pushes. Hardened assistant
runtimes use their own `HOME`, so a push that succeeds from the operator's
shell can still fail from inside the assistant. Store the Git credential under
the owning vault's gitignored private directory and point that vault's local git
config at it by relative path:

```sh
cp ~/.git-credentials <vault>/.alfred/private/git-credentials
chmod 600 <vault>/.alfred/private/git-credentials
git -C <vault> config --unset-all credential.helper || true
git -C <vault> config credential.helper 'store --file=.alfred/private/git-credentials'
```

The relative `--file` matters: the same `.git/config` must work both on the
host (`git -C <vault> ...`) and inside the mounted runtime vault
(`/workspace/extra/vault`). Prefer a fine-grained token limited to that vault's
private repository when creating a new credential.

## The rules

These are absolute. Each maps to a real leak that happened.

1. **Never paste a secret into the agent chat.** Anything you type to Alfred (Telegram, web, CLI) is persisted to conversation logs on disk and may be sent to the model provider. A revoked password is still readable in those logs. If you need Alfred to use a secret, put it in the assistant's env file yourself; do not hand it to him in a message.

2. **Never run `ps aux` (or any process dump) into the chat or a transcript.** The docker container is launched with `-e GMAIL_APP_PASSWORD=...` on its command line. `ps aux` prints that command line verbatim, secret included. Pasting that output leaks every `-e` value. If you must inspect process state, filter and mask first: `ps aux | grep ... | sed 's/=[^ ]*/=***/g'`.

3. **Never `grep` for a secret's literal value.** `grep "abcd1234..." ~` embeds the value in the command, which lands in shell history and, if pasted, in the chat. To check whether a key is set, match the variable NAME and mask the value: `grep "^GMAIL_IMAP" <vault>/.alfred/private/env | sed 's/=.*/=***/'`.

4. **Type secrets only through `read -s`.** When writing a secret into a file, read it silently into a shell variable, write via the variable, then unset:
   ```sh
   read -s NEW_SECRET            # paste, Enter — no echo, no history
   echo "length: ${#NEW_SECRET}" # sanity-check (16 for Gmail app passwords)
   sed -i.bak "s|^KEY=.*|KEY=$NEW_SECRET|" <vault>/.alfred/private/env
   unset NEW_SECRET
   ```
   The value never appears on screen, in history, or on a command line.

5. **Verify masked.** After writing, confirm presence without revealing the value:
   ```sh
   grep -E "^GMAIL_(APP|IMAP)_APP_PASSWORD" <vault>/.alfred/private/env \
     | awk -F= '{print $1"="(length($2)>0?"***":"(empty)")}'
   ```

6. **Never copy real identifiers into code, tests, or docs.** A real Telegram chat id once landed in a NanoClaw test fixture and was pushed to a public fork. Invent example values instead.
   The PII guard enforces this in every repo that carries Alfred work:
   - `tools/build-pii-list.js` regenerates the gitignored `tools/pii-list.local.txt` from the vaults named in `tools/pii-vaults.local.txt`: entity names, aliases, slugs, real emails and phones, and the values in each vault's `.alfred/private/` files.
   - `tools/pre-commit` and `tools/pre-push` rebuild the list, then run `tools/scan-pii.js`. The push hook covers commits that skipped pre-commit (`--no-verify`, rebase, cherry-pick).
   - NanoClaw checkouts use husky, which ignores `.git/hooks`. They opt in with `git config alfred.piiGuard true`; `~/.config/husky/init.sh` then runs Alfred's hooks before husky's own.
   - Public names that false-positive go in `tools/pii-allow.local.txt`. Run `npm run doctor` to confirm the hooks are installed.
   A pushed commit stays fetchable by SHA even after its branch is deleted (fork networks share storage). Only GitHub Support can purge it, so the guard has to fire before the push.

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
- `.gitignore` covers `.alfred/private/`, deployed vault `.bin/`, `.env`, `*.local.*`, `audit/`, and the PII scanner's pattern list.

The weak point is not the code. It is the human setup ritual, which is what this document hardens.

## See also

- `docs/NANOCLAW-INTEGRATION.md` — runtime/vault/secret boundary.
- `docs/NANOCLAW-PATCHES.md` — legacy Patch 3 (env passthrough allowlist).
- `docs/WEEKLY-DIGEST.md`, `docs/GMAIL.md` — per-feature credential setup.
