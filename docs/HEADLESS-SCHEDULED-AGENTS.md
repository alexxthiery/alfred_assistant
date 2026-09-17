# Headless Scheduled Agents

Scheduled jobs run without an interactive permission prompt. Any job that asks
a headless agent to use local tools must make that tool contract explicit in the
wrapper and in tests.

This document records the general failure mode behind the September 2026
conversation-ingest permission bug. It is not specific to that job.

## Failure Mode

A wrapper can correctly validate the vault, load the right persona, and invoke a
headless agent, while the agent still cannot perform the tool action the prompt
requires. In Claude Code this appears as a permission-gate failure: the agent
can reason, but calls such as `.bin/wiki patch` are denied because no human is
present to approve the tool use.

This can be missed when tests use a fake binary named `agent`: provider-specific
branches such as `basename "$ALFRED_AGENT_BIN" == claude` never run. Prompt
assertions alone are not enough; the test must inspect the child process argv.

## Rule

For every scheduled wrapper that invokes a headless agent:

1. Deterministic collection happens in the wrapper, not in the agent, when
   practical. Example: email review runs `.bin/email-review` before invoking the
   agent; conversation ingest mirrors/extracts transcripts before invoking the
   agent.
2. If the prompt allows or requires local tool use, the wrapper passes explicit
   non-interactive permissions for that provider.
3. The permission must be as narrow as the job allows:
   - write-capable vault updates: `wiki-write`, which grants only `.bin/wiki`
     command patterns; the wiki CLI still enforces schema, audit, autolink,
     binding, and auto-commit;
   - read-only context: `wiki-read <verbs...>`, which grants only named
     read-only wiki verbs such as `agenda`, `review`, `audit`, `recent`, `day`,
     or `search`;
   - no tools: no provider permission args.
4. Never rely on machine-local ambient settings such as
   `.claude/settings.local.json` for scheduled jobs. Those settings may differ
   between hosts, vaults, or users.
5. Tests for a Claude-specific permission path must name the fake binary
   `claude` and assert the exact `--allowedTools` argv passed to it. Include a
   negative assertion when the job should not receive broad write-capable wiki
   access.
6. User-visible messages are only for user-facing clarification or useful small
   updates. Operational blockers — tamper state, dirty git state, binding
   mismatch, missing permissions, missing CLIs, runtime failures — are
   maintainer-facing. The wrapper should give the agent an operator-only output
   convention and test that those messages are logged locally rather than sent
   to Telegram.

The implementation lives in `integrations/scheduling/assistant-binding.sh`:

```sh
alfred_prepare_agent_args wiki-write
alfred_prepare_agent_args wiki-read agenda review audit
```

Wrappers then invoke the agent with:

```sh
"$ALFRED_AGENT_BIN" "${ALFRED_AGENT_ARGS[@]}" -p "$PROMPT"
```

## Why The Old Tests Missed It

The old wrapper tests checked that the prompt mentioned the right policy and
that the fake agent produced a Telegram message. They did not simulate the
actual provider name or inspect provider-specific argv. As a result, a wrapper
could pass tests while still invoking live Claude as:

```sh
claude -p "$PROMPT"
```

That is insufficient for a scheduled run when the prompt expects `.bin/wiki`
tool calls.

## Similar Risks To Check

When adding or changing a scheduled job, check for these variants of the same
class:

- The prompt asks the agent to run a CLI, but the wrapper passes no provider
  permission args.
- The wrapper grants broad write-capable access for a read-only job.
- The test fake agent is not named like the real provider, so provider-specific
  branches are untested.
- Dry-run validates only env/binding and never exercises the child-agent argv.
- `wiki jobs --check` reports the plist as installed but cannot see whether the
  deployed wrapper/helper pair is stale.
- The wrapper and `assistant-binding.sh` are copied separately; deploy them as a
  pair to the launchd-safe wrapper directory.
- A child-facing assistant forwards operational/debug text to the child/user
  instead of writing a maintainer-only log entry.

## Current Scheduled-Agent Classification

| Wrapper | Agent role | Permission mode |
|---|---|---|
| `run-conversation-ingest.sh` | conservative fact/todo ingestion | `wiki-write` |
| `run-email-review.sh` | judge metadata-only email report; may create todos/facts | `wiki-write` |
| `run-daily-checkin.sh` | generate one Telegram check-in from context | `wiki-read recent agenda day search` |
| `run-weekly-review.sh` | synthesize weekly digest | `wiki-read agenda review audit` |

Deterministic jobs such as daily brief, reminders, backup, and Docker watchdog
do not invoke a headless agent and should not get provider permission args.
