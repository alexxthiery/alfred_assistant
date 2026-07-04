# nanoclaw adapter

Run Alfred as an always-on Telegram bot via a [nanoclaw](../../docs/NANOCLAW-PATCHES.md) container. This is the heaviest setup (a container host + a Telegram bot); the Claude Code / Codex adapters are far lighter on-ramps for the same vault.

## How it works

nanoclaw mounts the vault into the agent container and, per the group's `CLAUDE.local.md`, instructs the agent to **read `/workspace/extra/vault/AGENTS.md` at the start of every conversation** (with a terse fallback if unreachable). So nanoclaw reads the same canonical persona as every other runtime — edit `AGENTS.md` once, all runtimes pick it up.

## Setup

The host-side patches (write-guard hook, PATH, env passthrough, provider registration, vault-read gate) are documented in [`../../docs/NANOCLAW-PATCHES.md`](../../docs/NANOCLAW-PATCHES.md). Apply them to your nanoclaw fork.

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
