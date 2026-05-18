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
const { detectVaultRoot } = require('./vault-root.js');

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

// forEachPage(cb): iterate every wiki page once, with frontmatter parsed.
// cb({ slug, file, absPath, fm, body, raw }) -> any. Returning `false` breaks
// the loop early (other return values are ignored).
//
// Centralizes the read+parse pattern that appears at 30+ sites in bin/wiki.
// Per-process caching is intentionally NOT applied here because several callers
// mutate pages mid-walk (mv backlink rewrite, autolink). Cache only after a
// pass that audits write-during-iteration sites.
function forEachPage(cb) {
  for (const file of listWikiPages()) {
    const slug = file.replace(/\.md$/, '');
    const absPath = path.join(WIKI_DIR, file);
    const raw = fs.readFileSync(absPath, 'utf-8');
    const { fm, body } = parseFrontmatter(raw);
    if (cb({ slug, file, absPath, fm, body, raw }) === false) return;
  }
}

module.exports = {
  VAULT_ROOT, WIKI_DIR, SCHEMA_PATH, INDEX_PATH, LOG_PATH,
  detectVaultRoot,
  nowISO,
  wikiPath,
  listWikiPages,
  readPage,
  forEachPage,
};
