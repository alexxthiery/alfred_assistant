// vault-root.js — locate the vault root for any binary in this repo.
//
// Single source of truth for `.alfred.yml`-anchored vault discovery. Both
// bin/wiki (via bin/lib/vault.js) and bin/inbox import this. Standalone
// module by design: bin/inbox should not require the larger bin/lib/vault.js
// (which pulls in frontmatter, fs walks, etc.) just to find a directory.
//
// Discovery order (matches the documented contract):
//   1. WIKI_ROOT env override (used by tests + scripted invocations)
//   2. Walk up from process.cwd() until a directory contains .alfred.yml
//   3. Resolve from script location: <vault>/.bin/<name> → <vault>
//   4. Fall back to process.cwd()
//
// Pure-ish: depends on process.env, process.cwd, process.argv, fs.existsSync,
// fs.realpathSync. Side-effect-free (no writes). Re-entrant.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function detectVaultRoot() {
  if (process.env.WIKI_ROOT) return process.env.WIKI_ROOT;
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.alfred.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const scriptDir = path.dirname(fs.realpathSync(process.argv[1]));
    if (path.basename(scriptDir) === '.bin') return path.dirname(scriptDir);
  } catch {}
  return process.cwd();
}

module.exports = { detectVaultRoot };
