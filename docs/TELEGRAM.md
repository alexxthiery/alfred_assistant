# Telegram send — bot token + chat id setup

`bin/telegram-send` reads a message body from stdin and posts it to a Telegram
chat via the Bot API. It is the send-side of the reminder system
(`reminder-dispatch | telegram-send`), the Telegram twin of `bin/email-digest`.

It needs two env vars in `~/nanoclaw/.env`:

| Env var | What it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | A Bot API token (`123456789:ABC...`). |
| `TELEGRAM_CHAT_ID` | The destination chat id. For a 1:1 DM this equals your Telegram **user id**. |

## Recommended: reuse nanoclaw's existing bot

nanoclaw already drives Alfred over a Telegram bot, so `TELEGRAM_BOT_TOKEN` is
typically **already present** in `~/nanoclaw/.env`. Reusing it means reminders
arrive in the **same chat thread** you already use for Alfred — no second bot to
manage. Sending via the Bot API does **not** interfere with nanoclaw receiving
on the same token (only the *receiving* side — `getUpdates`/webhook — is
exclusive, and `telegram-send` never touches it).

You only need the chat id:

1. In Telegram, open **@userinfobot** and tap **Start** (or send `/start`).
2. It replies with `Id: <number>`. That number is your user id = your chat id.
3. Add it to `~/nanoclaw/.env` (the token is already there):
   ```sh
   echo "TELEGRAM_CHAT_ID=<number>" >> ~/nanoclaw/.env
   ```
4. Verify (masks the token, shows the chat id which is not secret):
   ```sh
   grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' ~/nanoclaw/.env \
     | awk -F= '{print $1"="($1=="TELEGRAM_BOT_TOKEN"?"***":$2)}'
   ```

> Why @userinfobot and not `getUpdates`? If nanoclaw long-polls or uses a webhook
> on its bot, an external `getUpdates` call would conflict (steal updates or
> error). @userinfobot sidesteps that entirely, and for a 1:1 chat the user id
> is the chat id.

## Alternative: a dedicated bot via BotFather

If you prefer reminders in a separate thread:

1. Message **@BotFather**, send `/newbot`, give it a name then a username ending
   in `bot`. It returns a token.
2. Open your new bot and tap **Start** (a bot cannot message a user who has not
   started it).
3. Add `TELEGRAM_BOT_TOKEN=<token>` to `~/nanoclaw/.env` (use `read -s`, see
   `docs/SECURITY.md` rule 4 — never paste a token into agent chat).
4. Get the chat id via @userinfobot as above and set `TELEGRAM_CHAT_ID`.

## Verify end to end

```sh
set -a; . ~/nanoclaw/.env; set +a
echo "test" | bin/telegram-send --dry-run    # validates token via getMe, sends nothing
echo "hello from telegram-send" | bin/telegram-send   # real send; check your chat
```

Exit codes: `0` sent (or empty-stdin no-op), `1` bad args, `2` missing env var,
`3` Bot API unreachable / rejected.

## Security

The token is a secret; the chat id is not. Follow `docs/SECURITY.md`: never
paste the token into agent chat, write it with `read -s`, and rotate via
@BotFather (`/revoke`) on any suspected leak. The reminder dispatcher runs
**host-side** (OS cron), so these vars need no `claude.ts` allowlist change
(that — Patch 3 in `docs/NANOCLAW-PATCHES.md` — is only for in-container
secrets).

## See also

- `docs/REMINDERS.md` — the vault-backed reminder model that feeds this.
- `integrations/scheduling/` — the `*/15` cron/launchd job that runs the pipe.
- `docs/SECURITY.md` — credential handling rules.
