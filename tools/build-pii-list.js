#!/usr/bin/env node
// build-pii-list.js — regenerate tools/pii-list.local.txt from live vaults.
//
// Reads (never writes) each vault listed in tools/pii-vaults.local.txt, one
// path per line, and emits TAB-separated <CATEGORY>\t<pattern> lines:
//   NAME / ORG / SLUG  titles, aliases, and hyphenated slugs of entity pages
//   EMAIL / PHONE      real contact details found anywhere in page text
//   SECRET / CHATID    values from <vault>/.alfred/private/{env,git-credentials}
//   PATH               the vault directory name
// Then appends tools/pii-extra.local.txt (hand-kept patterns) and drops any
// pattern listed in tools/pii-allow.local.txt (public names that would
// otherwise false-positive, e.g. a tool or a historical figure).
//
// Why generated: a hand-kept list goes stale as the vault grows, and a stale
// list silently lets new names through. The pre-commit hook reruns this.
//
// Prints counts only; never prints a pattern.
//
// Usage: tools/build-pii-list.js [--tools-dir <dir>] [--quiet]
// Exit: 0 ok, 2 no usable vault sources (existing list left untouched).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('../bin/lib/frontmatter.js');

const ENTITY_TAGS = new Set(['person', 'org', 'family']);
const MIN_LEN = 4;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+\d[\d -]{8,16}\d/g;
const PLACEHOLDER_EMAIL_RE = /@example\.(com|org|edu|test)$/i;

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function unquote(s) {
  return String(s).trim().replace(/^['"]|['"]$/g, '');
}

function asList(v) {
  if (v === undefined || v === '') return [];
  return (Array.isArray(v) ? v : [v]).map(unquote).filter(Boolean);
}

// Collect patterns from one vault into `add(category, pattern)`.
function collectVault(vault, add) {
  const wiki = path.join(vault, 'wiki');
  for (const fn of fs.readdirSync(wiki)) {
    if (!fn.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(wiki, fn), 'utf8');
    for (const e of text.match(EMAIL_RE) || []) {
      if (!PLACEHOLDER_EMAIL_RE.test(e)) add('EMAIL', e);
    }
    for (const p of text.match(PHONE_RE) || []) add('PHONE', p);
    const { fm } = parseFrontmatter(text);
    const tags = asList(fm.tags).map((t) => t.toLowerCase());
    const kind = tags.includes('person') || tags.includes('family') ? 'NAME'
      : tags.some((t) => ENTITY_TAGS.has(t)) ? 'ORG' : null;
    if (!kind) continue;
    for (const label of [...asList(fm.title), ...asList(fm.aliases)]) add(kind, label);
    const slug = fn.slice(0, -3);
    // Single-word slugs ("python", "reading") match ordinary prose.
    if (slug.includes('-')) add('SLUG', slug);
  }

  const envFile = path.join(vault, '.alfred', 'private', 'env');
  for (const line of readLines(envFile)) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const val = unquote(raw);
    if (/TOKEN|KEY|PASS|SECRET/.test(key) && val.length >= 8) add('SECRET', val);
    else if (/CHAT|JID/.test(key) && val.length >= 6) add('CHATID', val);
    else if (/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(val)) add('EMAIL', val);
  }
  const credFile = path.join(vault, '.alfred', 'private', 'git-credentials');
  for (const line of readLines(credFile)) {
    const m = line.match(/:\/\/[^:/]+:([^@]+)@/);
    if (m) add('SECRET', m[1]);
  }
  add('PATH', path.basename(path.resolve(vault)));
}

function buildList({ vaults, extraLines = [], allowLines = [] }) {
  const allow = new Set(allowLines.map((l) => l.toLowerCase()));
  const seen = new Set();
  const out = [];
  const add = (cat, pattern) => {
    const p = String(pattern).trim();
    if (p.length < MIN_LEN || allow.has(p.toLowerCase())) return;
    const key = `${cat}\t${p.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(`${cat}\t${p}`);
  };
  for (const v of vaults) collectVault(v, add);
  for (const line of extraLines) {
    const i = line.indexOf('\t');
    if (i > 0) add(line.slice(0, i), line.slice(i + 1));
  }
  return out;
}

function main(argv) {
  const quiet = argv.includes('--quiet');
  const di = argv.indexOf('--tools-dir');
  const toolsDir = di >= 0 ? path.resolve(argv[di + 1]) : __dirname;
  const expandHome = (p) => p.replace(/^~(?=\/|$)/, process.env.HOME || '~');
  const vaults = readLines(path.join(toolsDir, 'pii-vaults.local.txt'))
    .map(expandHome)
    .filter((v) => fs.existsSync(path.join(v, 'wiki')));
  if (!vaults.length) {
    console.error('build-pii-list: no readable vaults in tools/pii-vaults.local.txt; list not rebuilt');
    return 2;
  }
  const lines = buildList({
    vaults,
    extraLines: readLines(path.join(toolsDir, 'pii-extra.local.txt')),
    allowLines: readLines(path.join(toolsDir, 'pii-allow.local.txt')),
  });
  const outFile = path.join(toolsDir, 'pii-list.local.txt');
  const tmp = `${outFile}.tmp`;
  fs.writeFileSync(tmp, `# Generated by tools/build-pii-list.js from ${vaults.length} vault(s). Never commit.\n${lines.join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(tmp, outFile);
  if (!quiet) {
    const counts = {};
    for (const l of lines) { const c = l.split('\t')[0]; counts[c] = (counts[c] || 0) + 1; }
    console.log(`build-pii-list: ${lines.length} patterns from ${vaults.length} vault(s) ${JSON.stringify(counts)}`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { buildList, collectVault };
