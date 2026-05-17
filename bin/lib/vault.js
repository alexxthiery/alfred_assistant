// vault.js — singleton vault state + fs-level page helpers.
//
// Exports the resolved VAULT_ROOT (and derived paths) plus the small set of
// fs helpers every verb uses (wikiPath, listWikiPages, readPage). Other lib/
// modules stay disk-free; this one is the controlled boundary where the CLI
// touches the user's filesystem.
//
// VAULT_ROOT is computed once at require time, matching the singleton pattern
// bin/wiki has always used. Tests override with WIKI_ROOT env var before
// requiring this module (see tests/unit/vault.test.js for the pattern).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseFrontmatter } = require('./frontmatter.js');

function detectVaultRoot() {
  // 1. Explicit env override (used by tests + scripted invocations).
  if (process.env.WIKI_ROOT) return process.env.WIKI_ROOT;
  // 2. Walk up from cwd looking for .alfred.yml (vault root marker).
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.alfred.yml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 3. Resolve from script location: <vault>/.bin/wiki → <vault>.
  try {
    const scriptDir = path.dirname(fs.realpathSync(process.argv[1]));
    if (path.basename(scriptDir) === '.bin') return path.dirname(scriptDir);
  } catch {}
  // 4. Fall back to cwd.
  return process.cwd();
}

const VAULT_ROOT  = detectVaultRoot();
const WIKI_DIR    = path.join(VAULT_ROOT, 'wiki');
const SCHEMA_PATH = path.join(VAULT_ROOT, 'SCHEMA.md');
const INDEX_PATH  = path.join(WIKI_DIR, 'index.md');
const LOG_PATH    = path.join(WIKI_DIR, 'log.md');

const nowISO = () => new Date().toISOString();
const wikiPath = (slug) => path.join(WIKI_DIR, `${slug}.md`);

function listWikiPages() {
  if (!fs.existsSync(WIKI_DIR)) return [];
  return fs.readdirSync(WIKI_DIR)
    .filter((f) => f.endsWith('.md') && !['index.md', 'log.md'].includes(f))
    .sort();
}

function readPage(slug) {
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) return null;
  return parseFrontmatter(fs.readFileSync(p, 'utf-8'));
}

module.exports = {
  VAULT_ROOT, WIKI_DIR, SCHEMA_PATH, INDEX_PATH, LOG_PATH,
  detectVaultRoot,
  nowISO,
  wikiPath,
  listWikiPages,
  readPage,
};
