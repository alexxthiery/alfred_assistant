# Claude Code adapter

Run Claude Code as Alfred against your vault. No global config.

## How it works

Claude Code auto-loads `CLAUDE.md` from the launch directory. Your vault's `CLAUDE.md` is a one-line `@AGENTS.md` import, so launching Claude Code from the vault loads the canonical persona — and launching it anywhere else is vanilla Claude Code. Verified: a fresh `claude -p` from the vault identifies as Alfred.

## Setup

1. **Persona** — already handled by the vault wiring: `<vault>/CLAUDE.md` contains `@AGENTS.md`, and `<vault>/AGENTS.md` is the canonical persona. Nothing to do here.
2. **Launch** — `cd <vault> && claude`, or use the `alfred-cc` wrapper in this directory (set `ALFRED_VAULT` or edit its default), put it on your PATH:
   ```sh
   ALFRED_VAULT=/path/to/vault alfred-cc
   ```
3. **Write-guard (optional, recommended)** — copy `settings.json` here into `<vault>/.claude/settings.json` and fix the absolute path to `wiki-write-guard.js`. This blocks raw writes to `wiki/*.md` at the tool-call layer, with a helpful message. It is *project-scoped* (only fires when Claude Code runs in the vault).

## What enforces the write-guard

Two layers:
- **`wiki-write-guard.js`** (this hook): the friendly early block — denies a `Write`/`Edit`/`MultiEdit` or a Bash redirect (`>`, `tee`, `sed -i`, …) targeting `wiki/*.md` before it happens.
- **`wiki` tamper-check** (universal, git-layer): if anything slips past the hook, the next `wiki` op refuses while the vault has out-of-band edits, until you `wiki bless` or revert.

The hook is convenience; the tamper-check is the guarantee. Even without the hook installed, the guarantee holds.
