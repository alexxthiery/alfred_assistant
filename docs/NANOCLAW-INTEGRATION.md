# NanoClaw integration contract

Alfred should stay a thin layer over upstream NanoClaw. The vault CLI, persona,
schemas, scheduling wrappers, and assistant-specific policy live in this repo.
NanoClaw should provide the runtime: channels, containers, provider plumbing,
sessions, and delivery.

This document is the contract that lets us keep that boundary clear while still
benefiting from upstream NanoClaw releases.

## Design target

One machine may host several assistants. Each assistant is one isolated runtime
cell:

```text
Telegram account -> dedicated bot/runtime -> one vault -> one env file
```

The runtime may share the host, Docker/OneCLI infrastructure, and the upstream
NanoClaw source. It must not share vault state, private env files, Telegram
routing, local-only logs, or writable mounts across assistants.

## Ownership boundary

| Concern | Owner |
|---|---|
| Typed graph schema and write invariants | `alfred_assistant` |
| Vault CLI and maintenance verbs | `alfred_assistant` |
| Runtime persona source | `alfred_assistant` |
| Per-vault private env file convention | `alfred_assistant` |
| Host scheduled jobs for daily brief, email review, reminders, backup | `alfred_assistant` |
| Telegram/channel transport | NanoClaw |
| Container/session lifecycle | NanoClaw |
| Provider execution and message delivery | NanoClaw |
| Agent templates/plugins and provider/channel installation | NanoClaw |

When a feature can live either side, prefer the side that already owns the
state. For example, email triage belongs in Alfred because it writes vault
facts and todos. Telegram delivery belongs in NanoClaw because it is channel
transport.

## Non-negotiable invariants

The integration must preserve these properties after every NanoClaw upgrade:

1. **Single-vault binding.** One assistant runtime sees exactly one vault as its
   writable vault. It must not mount the parent directory containing sibling
   vaults.
2. **Per-vault credentials.** Runtime credentials are read from the owning
   vault's `<vault>/.alfred/private/env`, not from a shared host env file.
3. **Env binding check.** `ALFRED_EXPECTED_VAULT` and
   `ALFRED_EXPECTED_LABEL` must match the active vault and assistant label.
4. **No raw wiki writes.** Runtime agents must write vault pages through the
   deployed `wiki` CLI. Direct writes to `<vault>/wiki/*.md` must be blocked or
   detected before they can become silent corruption.
5. **Vault-first answers.** For personal recall, planning, todo, family,
   email, diary, or daily-routine questions, the runtime should not deliver an
   answer unless the agent has actually touched the mounted vault.
6. **Provenance survives.** Telegram ingests and replayed actions must keep
   source markers, observation ids, and replay specs/results when the pipeline
   claims to have written knowledge.
7. **Private debug logs stay private.** Full conversation mirrors live under
   `<vault>/.alfred/private/conversations/` and must not become git-trackable.
8. **Host jobs stay runtime-independent.** Daily brief, email review,
   reminders, weekly review, backup, and watchdog jobs use the OS scheduler,
   not NanoClaw scheduled tasks, unless a deliberate migration changes that.

## Preferred extension shape

Use these in order:

1. **Upstream NanoClaw feature as-is.** Prefer release-tag behavior when it
   satisfies the contract.
2. **NanoClaw template/plugin/config.** Persona, skills, MCP servers, and
   assistant-specific setup should be expressed as a stampable NanoClaw
   template/plugin when practical.
3. **Alfred-side wrapper or CLI.** If the behavior is vault-specific, keep it
   in this repo and expose it through the deployed `.bin/` tools.
4. **Small carried NanoClaw patch.** Patch NanoClaw only when the behavior must
   happen inside the runtime boundary, such as provider hooks or mount
   admission. Each carried patch needs a manifest entry, tests, and a drop
   condition.

## Carried-patch manifest format

Every remaining NanoClaw patch must be documented with:

```text
id:
status: keep | port-to-plugin | replace-upstream | drop | upstream-candidate
reason:
upstream alternative considered:
files touched:
tests:
runtime smoke:
drop condition:
```

If a patch cannot be explained in this format, it should not remain a
long-lived fork change.

For staging upgrades, run the Alfred/NanoClaw gate:

```sh
npm run nanoclaw:gate -- --nanoclaw /path/to/nanoclaw-staging --mode fast
npm run nanoclaw:gate -- --nanoclaw /path/to/nanoclaw-staging --mode full
```

Use `fast` while porting and `full` before canary. The gate wraps Alfred checks,
NanoClaw checks, and the disposable smoke harness below without touching
production. It writes per-command logs under `audit/nanoclaw-gates/` so a
passing or failing run remains inspectable after terminal output is gone.

The smoke harness can also be run directly:

```sh
npm run nanoclaw:smoke -- --nanoclaw /path/to/nanoclaw-staging
```

It validates the host-side deploy, env-binding, write-scope, private-log, and
email fail-closed contracts against throwaway vaults. It is not a substitute for
the runtime/container sibling-mount check or the live Telegram canary.

## Current convergence target

The live NanoClaw checkout is currently based on NanoClaw `v2.0.63` plus local
Alfred patches. The first convergence target is upstream `v2.3.0`, staged in a
separate worktree outside this repo. Operators should set `NANOCLAW_STAGING` to
that staging checkout and follow:

`docs/NANOCLAW-UPGRADE-RUNBOOK.md`.

Do not deploy from a staging worktree until that runbook passes.
