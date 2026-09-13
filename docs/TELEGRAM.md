# Telegram send — bot token + chat id setup

`bin/telegram-send` reads a message body from stdin and posts it to a Telegram
chat via the Bot API. It is the send-side of the reminder system
(`reminder-dispatch | telegram-send`), the Telegram twin of `bin/email-digest`.

It needs two env vars in the assistant's private env file:
`<vault>/.alfred/private/env`.

| Env var | What it is |
|---|---|
| `ALFRED_EXPECTED_VAULT` | Absolute path to the only vault this env file may be used with. |
| `ALFRED_EXPECTED_LABEL` | Assistant label used by scheduled jobs, e.g. `child`. |
| `TELEGRAM_BOT_TOKEN` | A Bot API token (`123456789:ABC...`). |
| `TELEGRAM_CHAT_ID` | The destination chat id. For a 1:1 DM this equals your Telegram **user id**. |

## Recommended: one bot per assistant

For one assistant and one vault, reminders should use the same bot/chat that the
inbound runtime uses. For multiple people on the same machine, prefer one
dedicated BotFather bot token per assistant, each with its own env file and
runtime mount. This keeps Telegram routing aligned with vault routing:

```text
person's Telegram account -> assistant bot token -> assistant runtime -> assistant vault
```

Sending via the Bot API does **not** interfere with the runtime receiving on the
same token (only the receiving side — `getUpdates`/webhook — is exclusive, and
`telegram-send` never touches it).

You need the destination chat id for the human account that will receive
messages:

1. In Telegram, open **@userinfobot** and tap **Start** (or send `/start`).
2. It replies with `Id: <number>`. That number is your user id = your chat id.
3. Add it to that assistant's private env file:
   ```sh
   echo "ALFRED_EXPECTED_VAULT=$HOME/<slug>-vault" >> ~/<slug>-vault/.alfred/private/env
   echo "ALFRED_EXPECTED_LABEL=<slug>" >> ~/<slug>-vault/.alfred/private/env
   echo "TELEGRAM_CHAT_ID=<number>" >> ~/<slug>-vault/.alfred/private/env
   ```
4. Verify (masks the token, shows the chat id which is not secret):
   ```sh
   grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' ~/<slug>-vault/.alfred/private/env \
     | awk -F= '{print $1"="($1=="TELEGRAM_BOT_TOKEN"?"***":$2)}'
   ```

> Why @userinfobot and not `getUpdates`? If nanoclaw long-polls or uses a webhook
> on its bot, an external `getUpdates` call would conflict (steal updates or
> error). @userinfobot sidesteps that entirely, and for a 1:1 chat the user id
> is the chat id.

## Create a dedicated bot via BotFather

For a new assistant:

1. Message **@BotFather**, send `/newbot`, give it a name then a username ending
   in `bot`. It returns a token.
2. Open your new bot and tap **Start** (a bot cannot message a user who has not
   started it).
3. Add `TELEGRAM_BOT_TOKEN=<token>` to that assistant's private env file (use `read -s`, see
   `docs/SECURITY.md` rule 4 — never paste a token into agent chat).
4. Get the chat id via @userinfobot as above and set `TELEGRAM_CHAT_ID`.

## Verify end to end

```sh
set -a; . ~/<slug>-vault/.alfred/private/env; set +a
echo "test" | bin/telegram-send --dry-run    # validates token via getMe, sends nothing
echo "hello from telegram-send" | bin/telegram-send   # real send; check your chat
```

Exit codes: `0` sent (or empty-stdin no-op), `1` bad args, `2` missing env var,
`3` Bot API unreachable / rejected.

## Security

The token is a secret; the chat id is not. Follow `docs/SECURITY.md`: never
paste the token into agent chat, write it with `read -s`, and rotate via
@BotFather (`/revoke`) on any suspected leak. Host-side scheduled jobs source
the assistant-specific env file directly. In-container runtimes still need their
own env pass-through/allowlist as described in `docs/NANOCLAW-PATCHES.md`.

## See also

- `docs/REMINDERS.md` — the vault-backed reminder model that feeds this.
- `integrations/scheduling/` — the `*/15` cron/launchd job that runs the pipe.
- `docs/SECURITY.md` — credential handling rules.
