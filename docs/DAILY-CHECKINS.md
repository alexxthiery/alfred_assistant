# Daily Check-Ins

Daily check-ins are short, agentic Telegram nudges that invite the user to reply.
They are meant to increase conversational surface area and help useful life
context enter the vault through the normal Telegram ingestion path.

They are deliberately separate from the daily brief:

- `run-daily-brief.sh` is deterministic and action-oriented.
- `run-daily-checkin.sh` is agentic and conversational.

## Runtime Contract

`integrations/scheduling/run-daily-checkin.sh --slot morning|afternoon|evening`:

1. Sources the vault-private `ENV_FILE`.
2. Verifies `ALFRED_EXPECTED_VAULT` and `ALFRED_EXPECTED_LABEL`.
3. Loads the generated `AGENTS.md` persona.
4. Provides recent `cache/daily-checkin/checkins.jsonl` entries to the agent.
5. Allows read-only `wiki` context lookup.
6. Sends only the agent's Telegram message body through `.bin/telegram-send`.
7. Appends the sent message to the JSONL ledger.

The wrapper never writes to `wiki/*.md`, never creates todos, and never reads
email/Gmail/Twitter. Replies are handled later by the normal Telegram runtime.

## Message Policy

The agent should send at most one or two short lines, with at most one question.
It should use memory when that gives a natural prompt, avoid repeating recent
ledger topics, and output nothing if sending would be actively unhelpful.

For a child/teen assistant, the vault-local persona overlay should own the
voice. For example, it may say to use openings like "Hi there!" or "Hey!",
avoid forced slang, and avoid sounding like a worksheet.

## Install

Use the shared scheduler installer:

```sh
tools/install-assistant-jobs.sh \
  --vault /path/to/vault \
  --env /path/to/vault/.alfred/private/env \
  --label <assistant-label> \
  --morning-checkin 07:00 \
  --afternoon-checkin 17:00 \
  --evening-checkin 22:00 \
  --wrappers ~/.local/bin
```

For a vault that also wants a deterministic daily brief:

```sh
tools/install-assistant-jobs.sh \
  --vault /path/to/vault \
  --env /path/to/vault/.alfred/private/env \
  --label <assistant-label> \
  --brief 06:30 \
  --morning-checkin 07:00 \
  --afternoon-checkin 17:00 \
  --evening-checkin 22:00 \
  --wrappers ~/.local/bin
```

Then verify:

```sh
/path/to/vault/.bin/wiki jobs --check --label <assistant-label>
```

It is normal for uninstalled check-in slots to appear as `missing`; `missing`
is informational. `drift` is the actionable failure: wrong wrapper, wrong vault
binding, or missing required `--slot` arguments.
