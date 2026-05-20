# Codex adapter

Run Codex as Alfred against your vault. No global config.

## How it works

Codex reads `AGENTS.md` from the working directory natively. Your vault's `AGENTS.md` is the canonical persona, so launching Codex from the vault loads Alfred. Verified: `codex exec` from the vault identifies as Alfred.

## Setup

1. **Persona** — already handled: `<vault>/AGENTS.md` is the canonical persona; Codex reads it natively. Nothing to do.
2. **Launch** — `cd <vault> && codex`, or the `alfred-codex` wrapper here (set `ALFRED_VAULT`), on your PATH. Non-interactive: `alfred-codex exec "..."`.

## Write-guard

Codex's deny-hook capability is not yet wired here, so the **`wiki` tamper-check is the write-guard for Codex** — the universal, git-layer guarantee. A raw edit to `wiki/*.md` blocks the next `wiki` op until you `wiki bless` or revert, regardless of runtime. If Codex later exposes a pre-tool deny hook, an early-block (like the Claude Code adapter's) can be added; until then the backstop fully satisfies "use `wiki`, never raw-edit."

Note: Codex runs with `sandbox: workspace-write` by default — it *can* write vault files, which is exactly why the tamper-check matters.
