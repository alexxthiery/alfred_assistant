# Integrations — running Alfred on your runtime of choice

The CLI (`bin/`) and the persona are runtime-agnostic. Alfred is just "an LLM agent that drives `bin/wiki` against your vault." Any agent runtime that can run shell commands works. This directory holds the thin per-runtime config — **not** persona variants. There is exactly one persona: the canonical `AGENTS.md` in your vault.

> `AGENTS.md` here always means the **vault's** persona (runtime behavior). The repo also has its own root `AGENTS.md`, which is *developer* orientation for changing this codebase — a different file in a different tree. See the note at the top of the repo `AGENTS.md`.

## The model

```
runtime (swappable)        ──reads──▶  AGENTS.md (one persona, in the vault)
  nanoclaw / Claude Code / Codex                 │
                                                 └─drives──▶  bin/wiki  ──▶  vault
```

- **One persona, one file.** Your personalized persona lives at `<vault>/AGENTS.md`. Every runtime reads that same file — so Alfred behaves identically whether you reach him via Telegram (nanoclaw), a terminal (Claude Code / Codex), or anything else. Edit `AGENTS.md` once; all runtimes pick it up.
- **No global config.** Nothing goes in `~/.claude/CLAUDE.md` or Codex's global config. The persona is scoped to the vault directory; launch the runtime from there and it becomes Alfred, launch it elsewhere and it's vanilla.
- **The write-guard is enforced at the git layer** by `wiki`'s tamper-check (refuses to operate while the vault has out-of-band edits), so it holds on *every* runtime regardless of that runtime's hook support. Per-runtime hooks (below) add a friendlier early block where available.

## What each adapter provides

| Responsibility | nanoclaw | Claude Code | Codex |
|---|---|---|---|
| Reads the persona | `AGENTS.md` (via the `CLAUDE.local.md` instruction) | `AGENTS.md` (via the vault's `CLAUDE.md` → `@AGENTS.md` import) | `AGENTS.md` (native) |
| Write-guard, universal | `wiki` tamper-check (git-layer; all runtimes) | | |
| Write-guard, early block (optional UX) | PreToolUse hook (Patch 1) | PreToolUse hook in `.claude/settings.json` | tamper-check only (Codex deny-hook: TBD) |
| Launch | the nanoclaw container | `alfred-cc` (or `cd <vault> && claude`) | `alfred-codex` (or `cd <vault> && codex`) |
| Scheduling | OS cron (see `../integrations/scheduling/`) — runtime-independent | | |

## Pick your runtime

- **`claude-code/`** — terminal/IDE sessions on your machine. The lightest on-ramp: no container, no bot. `cd <vault> && claude`.
- **`codex/`** — same idea with Codex. `cd <vault> && codex`.
- **`nanoclaw/`** — the always-on Telegram bot (a container host). The heaviest setup; see `../docs/NANOCLAW-PATCHES.md`.

All three drive the same vault and the same `AGENTS.md`. Use whichever fits the moment.

## The one rule, on every runtime

Never raw-edit `wiki/*.md`; go through `bin/wiki`. The tamper-check enforces it (a stray edit blocks the next `wiki` op until you `wiki bless` or revert). The persona states it; the CLI guarantees it.
