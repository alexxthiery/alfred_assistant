#!/usr/bin/env node
// wiki-write-guard.js — Claude Code PreToolUse hook that blocks raw writes to
// the vault's wiki/*.md (Write/Edit/MultiEdit/NotebookEdit, and Bash redirects
// like `>`/`>>`/`tee`/`sed -i` into those paths). The vault is a typed graph;
// every page has invariants only `bin/wiki` enforces, so a raw write would
// silently break them. This is the friendly *early* block; the universal
// guarantee is `wiki`'s tamper-check (git-layer), which catches anything that
// slips past this.
//
// Wire it in <vault>/.claude/settings.json (project-scoped — only active when
// Claude Code runs in the vault). See ./settings.json in this directory.
//
// Contract: reads the PreToolUse event JSON on stdin; to block, prints a
// permissionDecision:deny JSON and exits 2.

'use strict';

const WIKI_RE = /\/wiki\/[^/\s]+\.md\b/;                 // a vault wiki page path
const REDIRECT_RE = /(>>?|\btee\b|\bsed\b\s+-i|\bawk\b\s+-i|\bdd\b\s+of=|\bcp\b|\bmv\b|\brm\b)/; // write-ish bash ops

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(2);
}

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let ev;
  try { ev = JSON.parse(raw || '{}'); } catch { process.exit(0); } // malformed → don't block
  const tool = ev.tool_name || '';
  const inp = ev.tool_input || {};

  const MSG = 'Blocked: this is a vault wiki page — go through `wiki ingest` / `wiki patch`, '
    + 'never a raw file write. The block is intentional (the CLI enforces schema, provenance, '
    + 'autolink, audit, obs-ids). Free-write zones: inbox/, raw/, alfred/scratchpad.md.';

  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const p = inp.file_path || inp.notebook_path || '';
    if (WIKI_RE.test(p)) deny(MSG);
  } else if (tool === 'Bash') {
    const cmd = inp.command || '';
    if (WIKI_RE.test(cmd) && REDIRECT_RE.test(cmd)) deny(MSG);
  }
  process.exit(0); // allow
});
