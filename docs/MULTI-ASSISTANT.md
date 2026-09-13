# Running multiple assistants on one machine

One Mac/server can host several independent vault-backed assistants. The safe
model is **one assistant instance per person**:

```text
Child's Telegram account  -> child bot token  -> child runtime  -> child-vault
Owner's Telegram account  -> owner bot token  -> owner runtime  -> owner-vault
```

The assistants may share the same source repo and host wrappers, but they must
not share live Telegram routing unless an explicit, tested router maps each chat
to exactly one vault. The default recommendation is a dedicated Telegram bot per
vault.

## Separation Contract

| Shared on the machine | Separate per assistant |
|---|---|
| The Mac/server and OS scheduler | Vault folder and git repo |
| The `alfred_assistant` source repo | `.alfred.yml` identity |
| The copied wrapper scripts in `~/.local/bin` | Deployed `<vault>/.bin/` |
| Optional OneCLI/Docker infrastructure | Canonical `<vault>/AGENTS.md` persona |
| | Telegram bot token (`TELEGRAM_BOT_TOKEN`) |
| | Telegram destination chat id (`TELEGRAM_CHAT_ID`) |
| | Timezone (`TZ`, e.g. `Asia/Singapore`) |
| | Env-file vault binding (`ALFRED_EXPECTED_VAULT`, `ALFRED_EXPECTED_LABEL`) |
| | Runtime group/container mounted to this vault |
| | Private env file, `<vault>/.alfred/private/env` |
| | Launchd labels, e.g. `com.child.daily-brief` |
| | Cache, ledgers, logs under `<vault>/cache` and `<vault>/.cache` |

The invariant to protect is simple: a Telegram message from one human account
must have only one path to one vault.

## Add an assistant

Use `<slug>` for the assistant namespace, e.g. `child`.

1. **Create/deploy the vault**

   ```sh
   mkdir -p ~/<slug>-vault
   tools/deploy.sh --target ~/<slug>-vault \
     --user-name "<Name>" --user-slug <slug> --user-tz-city "<City>" \
     --assistant-name "<AssistantName>" --apply
   ```

   Then create or merge the assistant's canonical `AGENTS.md`, initialize a
   private git repo/remote, and commit. The deploy step writes `AGENTS.local.md`
   only as a comparison artifact; it does not overwrite `AGENTS.md`.

2. **Create a dedicated Telegram bot**

   In Telegram, the person's account should start a bot created for this
   assistant via BotFather. Store the token only in that assistant's env file.
   Do not paste the token into chat or commit it.

   ```sh
   mkdir -p ~/<slug>-vault/.alfred/private
   chmod 700 ~/<slug>-vault/.alfred ~/<slug>-vault/.alfred/private
   # Write secrets with `read -s` as described in docs/SECURITY.md.
   # Required binding:
   #   ALFRED_EXPECTED_VAULT=$HOME/<slug>-vault
   #   ALFRED_EXPECTED_LABEL=<slug>
   #   TZ=Area/City
   # Required Telegram routing:
   #   TELEGRAM_BOT_TOKEN=<dedicated bot token>
   #   TELEGRAM_CHAT_ID=<that person's Telegram user/chat id>
   ```

3. **Create a separate runtime group/container**

   The inbound Telegram runtime must mount exactly this vault as its writable
   vault, and its startup/persona instruction must point at that vault's
   `AGENTS.md`.

   For nanoclaw, the group instruction should be:

   ```text
   Your full instructions live in the vault at `/workspace/extra/vault/AGENTS.md`.
   Read that file at the start of every conversation.
   ```

   The runtime's environment should come from `~/<slug>-vault/.alfred/private/env`,
   not from another assistant's env file. The runtime/container should not mount
   the parent directory that contains sibling vaults.

4. **Install host jobs with a label namespace**

   Copy/update wrappers once:

   ```sh
   cp integrations/scheduling/run-daily-brief.sh \
      integrations/scheduling/run-reminder-dispatch.sh \
      integrations/scheduling/run-email-review.sh \
      integrations/scheduling/run-weekly-review.sh \
      integrations/scheduling/assistant-binding.sh \
      tools/vault-backup-push.sh ~/.local/bin/
   chmod +x ~/.local/bin/run-*.sh ~/.local/bin/assistant-binding.sh ~/.local/bin/vault-backup-push.sh
   ```

   Install jobs for this assistant:

   ```sh
   tools/install-assistant-jobs.sh \
     --vault ~/<slug>-vault \
     --env ~/<slug>-vault/.alfred/private/env \
     --label <slug> \
     --reminders --brief 07:00 --backup 22:00
   ```

   Add `--email-review 10:00` or `--weekly 09:00` only when that assistant has
   the required mail credentials and the feature is wanted.

5. **Verify the namespace**

   ```sh
   tools/check-assistant-isolation.js \
     --vault ~/<slug>-vault \
     --env ~/<slug>-vault/.alfred/private/env \
     --label <slug> \
     --expect-user-slug <slug> \
     --expect-assistant-name "<AssistantName>"

   ~/<slug>-vault/.bin/wiki jobs --check --label <slug>
   set -a; . ~/<slug>-vault/.alfred/private/env; set +a
   echo "test from <slug>" | ~/<slug>-vault/.bin/telegram-send --dry-run
   ```

   The isolation check verifies the vault surface, env file, deployed wiki, and
   `com.<slug>.*` job labels without printing secrets. It also verifies that the
   env file is bound to the same vault and assistant label that the scheduler
   will use, and that `TZ` is present so scheduled jobs compute the correct
   local date. Add
   `--telegram-dry-run` when you also want it to validate Bot API reachability.
   The separate Telegram dry run validates the bot token without sending a
   message.

   From inside the assistant runtime/container, also run the isolation check
   with each sibling vault path as `--other-vault`. This must fail if a sibling
   vault is readable or writable:

   ```sh
   tools/check-assistant-isolation.js \
     --vault /workspace/extra/vault \
     --env /workspace/extra/vault/.alfred/private/env \
     --label <slug> \
     --other-vault /path/to/other-vault
   ```

## Smoke Test Before Use

Before handing the assistant to the person:

1. Send a harmless Telegram message from that person's Telegram account.
2. Confirm the runtime reads `<vault>/AGENTS.md`.
3. Ask it to create a tiny test todo.
4. Confirm the file appears only under that person's vault.
5. Confirm the other vault's `git status --short` is unchanged.
6. Delete or mark done the test todo through `wiki`, then commit/push that vault.

This is the end-to-end guard against the only serious failure mode: wrong bot or
wrong runtime writing to the wrong vault.

For a production child/family setup, “wrong runtime reading the wrong vault” is
guarded by the same principle: the runtime must not be able to see sibling
vaults at all. If `--other-vault` is accessible from inside the runtime, the
setup is not isolated enough.

## Lessons From A Second-Vault Setup

These are the failure modes that appeared when onboarding a real second
assistant and should be treated as part of the runbook.

### BotFather names

Bot usernames must be globally unique and must end in `bot`; BotFather may reject
names that look unique to you because the exact username is taken or invalid. Keep
trying variants until BotFather returns a token, then immediately store that token
in `<vault>/.alfred/private/env`. Do not paste the token into agent chat.

### Persona name drift

If the assistant is not named Alfred, set both:

```yaml
assistant:
  name: <AssistantName>
```

in `.alfred.yml`, and deploy with `tools/deploy.sh --assistant-name
"<AssistantName>"`. Verify the rendered runtime persona (`<vault>/AGENTS.md`)
starts with the expected name, then run:

```sh
tools/check-assistant-isolation.js \
  --vault ~/<slug>-vault \
  --env ~/<slug>-vault/.alfred/private/env \
  --label <slug> \
  --expect-user-slug <slug> \
  --expect-assistant-name "<AssistantName>"
```

This catches the "new assistant still calls itself Alfred" class of bugs.

### Live vaults may change while you are working

Once Telegram is connected, the assistant may write to the vault while an
operator is doing maintenance. If a CLI command reports tamper/out-of-band
changes, do not pass `--accept-tamper` reflexively. Inspect `git diff`, run a
targeted audit on the changed page, then either `wiki bless` the legitimate
runtime change as its own commit or reject it before continuing. This keeps an
operator batch from silently folding unrelated live-chat updates into its
history.

### Scheduled jobs

For a child or Telegram-only assistant, install the deterministic daily brief
with only Telegram credentials in the env file. The wrapper sends email only
when `EMAIL_FROM` is set, so omitting mail variables is the intended no-email
configuration.

Always include `TZ=Area/City` in the env file. The scheduler fires in local
wall-clock time, but the script still needs an explicit timezone to compute the
correct "today" if it ever runs under a different runtime default.

Use `wiki jobs --check --label <slug>` after installation. Missing unrelated
jobs are informational; `drift` is the actionable failure.

### GitHub backup

Each vault should have its own private git remote. Check these before the first
push:

```sh
git -C ~/<slug>-vault status --short
git -C ~/<slug>-vault remote -v
git -C ~/<slug>-vault ls-files
git -C ~/<slug>-vault check-ignore -v .alfred/private/env .cache .DS_Store AGENTS.local.md
```

Then create/push the private repo, for example:

```sh
gh repo create <owner>/<slug>-vault --private \
  --source ~/<slug>-vault --remote origin --push
```

Verify `gh repo view ... --json isPrivate,visibility,url` and keep the backup
fresh with the scheduled `vault-backup-push` job when desired.

### Starter-copy from another vault

Do not raw-copy markdown from another person's vault. Build a sanitized ingest
spec that preserves provenance and excludes private/adult/admin/sensitive
material. A useful starter-copy record should state what was copied and what was
deliberately excluded. After the ingest:

```sh
<vault>/.bin/wiki audit --all
<vault>/.bin/wiki lint
<vault>/.bin/wiki review
git -C <vault> grep -n -E '(FIN|passport|token|password|Email:|Phone:)' -- wiki
```

Treat review's co-occurrence list as suggestions, not a mandate. Add typed
relations only when the relation is structurally true and useful for retrieval;
avoid adding generic `mentions` edges just to drive the review list to zero.

## Shared-Bot Routing

A shared Telegram bot with chat-id routing is possible only if the runtime has a
tested router that binds each chat id to exactly one vault and refuses ambiguous
or missing bindings. Treat that as an advanced deployment, not the default.

For a child/family setup, prefer the simpler and safer dedicated-bot model above:
the bot token itself becomes part of the vault boundary.

## See Also

- `docs/TELEGRAM.md` — bot token and chat id setup.
- `docs/SECURITY.md` — writing secrets safely.
- `integrations/scheduling/README.md` — OS-scheduled jobs and `--label`.
- `integrations/nanoclaw/README.md` — Telegram runtime wiring.
- `docs/NANOCLAW-PATCHES.md` — the nanoclaw-side patches this assumes.
