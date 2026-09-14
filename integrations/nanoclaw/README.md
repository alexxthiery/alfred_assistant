# nanoclaw adapter

Run Alfred as an always-on Telegram bot via a NanoClaw container. This is the
heaviest setup (a container host + a Telegram bot); the Claude Code / Codex
adapters are far lighter on-ramps for the same vault.

The long-term strategy is to stay close to upstream NanoClaw and keep Alfred as
a thin vault/persona layer. Read the integration contract before patching
NanoClaw:

- [`../../docs/NANOCLAW-INTEGRATION.md`](../../docs/NANOCLAW-INTEGRATION.md)
- [`../../docs/NANOCLAW-UPGRADE-RUNBOOK.md`](../../docs/NANOCLAW-UPGRADE-RUNBOOK.md)
- [`../../docs/NANOCLAW-PATCHES.md`](../../docs/NANOCLAW-PATCHES.md)

## How it works

nanoclaw mounts the vault into the agent container and, per the group's `CLAUDE.local.md`, instructs the agent to **read `/workspace/extra/vault/AGENTS.md` at the start of every conversation** (with a terse fallback if unreachable). So nanoclaw reads the same canonical persona as every other runtime — edit `AGENTS.md` once, all runtimes pick it up.

## Setup

The legacy host-side patches (write-guard hook, PATH, env passthrough, provider
registration, vault-read gate) are documented in
[`../../docs/NANOCLAW-PATCHES.md`](../../docs/NANOCLAW-PATCHES.md). For new
NanoClaw releases, do not apply them mechanically: first classify each one
against upstream features and the upgrade runbook.

**Persona wiring:** point the group's `CLAUDE.local.md` at the vault's `AGENTS.md`:

```
Your full instructions live in the vault at `/workspace/extra/vault/AGENTS.md`.
Read that file at the start of every conversation.
If `AGENTS.md` is unreachable, fall back to: you are <ASSISTANT>, <USER>'s terse
personal agent. Match their style. No greetings, no preamble.
```

(Earlier setups pointed at `alfred/_persona.md`; the consolidation to `AGENTS.md` is a one-line change here.)

## Write-guard

nanoclaw's PreToolUse hook (Patch 1) is the early block; the `wiki` tamper-check is the universal backstop. Both apply.

## Scheduling

Historically nanoclaw owned scheduling via `schedule_task`. The runtime-independent recipes in [`../scheduling/`](../scheduling/) (OS cron / launchd) are preferred — they don't depend on the nanoclaw task table surviving upgrades.
