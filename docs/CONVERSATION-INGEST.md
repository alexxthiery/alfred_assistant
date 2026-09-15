# Conversation Fact Ingestion

This is the daily safety-net pass for facts learned in Telegram conversations.
It is meant to catch useful durable knowledge that the live runtime did not
write at message time.

It is not a diary generator, not a psychological interpretation pass, and not a
second writer. The only durable writer remains `wiki`.

## Contract

`integrations/scheduling/run-conversation-ingest.sh`:

1. Sources the vault-private `ENV_FILE`.
2. Verifies `ALFRED_EXPECTED_VAULT` and `ALFRED_EXPECTED_LABEL`.
3. Optionally mirrors a configured runtime transcript directory with
   `wiki conversation-log import`.
4. Reads only recent files under `.alfred/private/conversations/`; when
   `ALFRED_CONVERSATION_EXTRACT=claude-jsonl` is set, it reads compact
   `deltas/*.jsonl` files rather than raw Claude Code transcripts.
5. Invokes a headless agent with `AGENTS.md` and this policy.
6. Lets the agent write durable facts only through `wiki ingest`, `wiki patch`,
   or `wiki todo`.
7. Sends a Telegram message only when the agent has a concrete clarification
   question or a very small useful update.
8. Appends a local JSONL ledger under `cache/conversation-ingest/`.

The job is idempotent at the local-day level. Re-running the same day is skipped
unless the wrapper is called with `--force`.

For Claude Code headless runs, the wrapper passes a narrow `--allowedTools`
list for `.bin/wiki` invocations. This is intentional: scheduled jobs cannot
answer interactive permission prompts, and the wrapper should not depend on a
machine-local `.claude/settings.local.json` allowlist. The permission is scoped
to the wiki CLI path only; the agent still cannot edit markdown files directly.

## Input Window

The wrapper does not ask the agent to read the full conversation archive. It
selects recent input files by modification time using
`ALFRED_CONVERSATION_INGEST_DAYS` (default `1`, valid range `1..14`).

When `ALFRED_CONVERSATION_EXTRACT=claude-jsonl` is set, the selected files are
only compact extracted deltas:

```text
<vault>/.alfred/private/conversations/<provider>/<source>/deltas/YYYY-MM-DD.jsonl
```

This means a line spoken yesterday but extracted today may appear in yesterday's
delta file and still be reviewed today, because the file was modified today.
That is intentional: extraction is cursor-based, while analysis is recent-file
based. The daily ledger prevents accidental same-day reruns unless `--force` is
used.

`ALFRED_CONVERSATION_SOURCE` may point either at a nanoclaw markdown archive
directory such as `groups/<group>/conversations/`, or at a live Claude JSONL
transcript directory under `data/v2-sessions/<agent-group-id>/.claude-shared/`.
When using a JSONL source, set `ALFRED_CONVERSATION_SOURCE_EXTENSIONS=jsonl` so
the mirror is explicit about what it imports. Also set
`ALFRED_CONVERSATION_EXTRACT=claude-jsonl` so the wrapper extracts only new
user/assistant text lines into daily delta files and keeps tool output,
thinking blocks, and attachments out of the ingestion prompt. If the source
directory contains Claude subagent transcripts, set
`ALFRED_CONVERSATION_EXCLUDE_DIRS=subagents`; subagent transcripts are not the
user conversation and should not feed the daily ingestion pass.

## What To Ingest

Conversation content is fair game when it is useful for the assistant becoming
a better memory, companion, organizer, or advisor. The constraint is not
"avoid personal facts"; the constraint is confidence and interpretation. Ingest
facts that were actually shared, with date/provenance, and avoid adding a story
that the user did not say.

Ingest low-risk, durable, concrete information:

- names, aliases, relationships, and recurring people;
- explicit preferences and dislikes;
- dates, events, plans, classes, trips, appointments;
- todos and reminders;
- hobbies, activities, teams, teachers, places, routines;
- explicit self-reports such as "I am nervous about X" or "I liked Y";
- corrections to existing cards.

Use `[fact]` only for assertion-shaped facts. Use `[opinion]`,
`[hypothesis]`, `[question]`, `[decision]`, or `[prediction]` when the content
requires it. If the evidence is too ambiguous, ask one concise clarification
question instead of writing.

## What Not To Ingest

Do not write broad daily summaries or inferred psychological profiles.

Avoid silently writing claims about:

- motives;
- mental health;
- hidden family or friendship dynamics;
- blame, status, popularity, or romantic implications;
- sensitive health or safety interpretations;
- anything that would surprise the user as an over-reading of casual chat.

If such a point seems important, ask a gentle clarification question or record a
narrow concrete observation instead.

## Required Provenance

Facts learned from conversation should use conversation provenance:

```text
source: "telegram:YYYY-MM-DD"
```

or an inline marker:

```text
^[telegram:YYYY-MM-DD]
```

Use a more specific Telegram message id when available. Private conversation
mirrors under `.alfred/private/conversations/` are local debug evidence; they
are not durable public provenance and are not committed to git.

## Write Path

Durable writes must use the normal pipeline:

```sh
.bin/wiki ingest --stdin
.bin/wiki ingest --file <spec.json>
.bin/wiki patch <slug> --observation ...
.bin/wiki todo add ...
```

Never edit `wiki/*.md` directly. Never write raw markdown cards by hand. Read
the CLI output after every write and fix strict audit issues before finishing.

If there is nothing worth storing, output nothing.

If a scheduled run reports that it could read conversations but could not call
`.bin/wiki`, first check that the deployed
`run-conversation-ingest.sh` is current. The expected behavior is that a Claude
agent binary named `claude` is invoked with explicit `.bin/wiki` allowed tools
by the wrapper itself.
