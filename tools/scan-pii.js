#!/usr/bin/env node
// scan-pii.js — refuse private content before it leaves the machine.
//
// Two checks per line:
//   1. list patterns from tools/pii-list.local.txt (see build-pii-list.js);
//      NAME/ORG/SLUG match on word boundaries, everything else as substring.
//      Case-insensitive.
//   2. generic secret shapes (bin/lib/secrets.js + a few scanner-only shapes).
//      Skipped under tests/ and in *.test.* files, which carry fake tokens on purpose. List
//      patterns still apply there: fixtures are exactly where real IDs get
//      pasted by accident.
// LICENSE is exempt from both: the maintainer's name belongs there.
//
// Output: <where>:<line> [<CATEGORY>] HIT — never the matched text, so the
// output is safe to paste anywhere.
//
// Modes:
//   scan-pii.js <file> [file ...]      working-tree files
//   scan-pii.js --staged               index blobs (what the commit will contain)
//   scan-pii.js --range <rev-list args> added lines + messages of those commits
// Common flags: --list <file> (default: pii-list.local.txt next to this script)
//
// Exit: 0 clean, 1 hits, 2 usage/config error.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detectSecrets } = require('../bin/lib/secrets.js');

const WORD_CATEGORIES = new Set(['NAME', 'ORG', 'SLUG']);
const EXTRA_SECRET_SHAPES = [
  { name: 'telegram-bot-token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/ },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'google-api-key', re: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One alternation regex per category keeps a ~1000-pattern list fast.
function loadMatchers(listFile) {
  const byCat = new Map();
  for (const raw of fs.readFileSync(listFile, 'utf8').split('\n')) {
    if (!raw || raw.startsWith('#')) continue;
    const i = raw.indexOf('\t');
    if (i <= 0 || i === raw.length - 1) continue;
    const cat = raw.slice(0, i);
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(escapeRe(raw.slice(i + 1)));
  }
  const matchers = [];
  for (const [cat, pats] of byCat) {
    // Longest first so a full name wins over its prefix in the alternation.
    pats.sort((a, b) => b.length - a.length);
    const body = `(?:${pats.join('|')})`;
    const src = WORD_CATEGORIES.has(cat) ? `(?<![\\w])${body}(?![\\w])` : body;
    matchers.push({ cat, re: new RegExp(src, 'i') });
  }
  return matchers;
}

function isExempt(file) {
  return path.basename(file) === 'LICENSE' && !file.includes('/');
}

function genericAllowed(file) {
  return !file.split('/').includes('tests') && !/\.test\.(js|ts|mjs|cjs|py)$/.test(file);
}

function scanLine(line, file, matchers) {
  const cats = [];
  for (const { cat, re } of matchers) if (re.test(line)) cats.push(cat);
  if (genericAllowed(file)) {
    for (const h of detectSecrets(line)) cats.push(`SECRET-SHAPE:${h.name}`);
    for (const s of EXTRA_SECRET_SHAPES) if (s.re.test(line)) cats.push(`SECRET-SHAPE:${s.name}`);
  }
  return cats;
}

// items: [{ where, file, lines: [{ n, text }] }]
function scanItems(items, matchers) {
  const hits = [];
  for (const item of items) {
    if (isExempt(item.file)) continue;
    for (const { n, text } of item.lines) {
      for (const cat of scanLine(text, item.file, matchers)) hits.push(`${item.where}:${n} [${cat}] HIT`);
    }
  }
  return hits;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function toLines(text) {
  return text.split('\n').map((t, i) => ({ n: i + 1, text: t }));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer: 1 << 30 });
}

function fileItems(files) {
  const items = [];
  for (const f of files) {
    if (!fs.statSync(f, { throwIfNoEntry: false })?.isFile()) continue;
    const buf = fs.readFileSync(f);
    if (isBinary(buf)) continue;
    const rel = path.relative(process.cwd(), path.resolve(f)) || f;
    items.push({ where: rel, file: rel, lines: toLines(buf.toString('utf8')) });
  }
  return items;
}

function stagedItems(cwd) {
  const names = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], cwd)
    .toString().split('\0').filter(Boolean);
  const items = [];
  for (const f of names) {
    const buf = git(['show', `:${f}`], cwd);
    if (isBinary(buf)) continue;
    items.push({ where: f, file: f, lines: toLines(buf.toString('utf8')) });
  }
  return items;
}

// Added lines of every commit in the range, plus each commit message: a push
// can carry content that never passed pre-commit (--no-verify, rebase, amend).
function rangeItems(revArgs, cwd) {
  const commits = git(['rev-list', ...revArgs], cwd).toString().split('\n').filter(Boolean);
  const items = [];
  for (const c of commits) {
    const short = c.slice(0, 8);
    const msg = git(['log', '-1', '--format=%B', c], cwd).toString();
    items.push({ where: `${short}:<message>`, file: '<message>', lines: toLines(msg) });
    const diff = git(['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', c], cwd).toString();
    let file = null;
    let cur = null;
    let n = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        file = line === '+++ /dev/null' ? null : line.slice(6);
        cur = file ? { where: `${short}:${file}`, file, lines: [] } : null;
        if (cur) items.push(cur);
      } else if (line.startsWith('@@')) {
        const m = line.match(/\+(\d+)/);
        n = m ? Number(m[1]) : 0;
      } else if (cur && line.startsWith('+')) {
        cur.lines.push({ n, text: line.slice(1) });
        n++;
      }
    }
  }
  return items;
}

function main(argv) {
  let listFile = path.join(__dirname, 'pii-list.local.txt');
  const li = argv.indexOf('--list');
  if (li >= 0) { listFile = argv[li + 1]; argv = argv.filter((_, i) => i !== li && i !== li + 1); }
  if (!fs.existsSync(listFile)) {
    console.error(`scan-pii: missing ${listFile}; run tools/build-pii-list.js`);
    return 2;
  }
  const matchers = loadMatchers(listFile);
  if (!matchers.length) {
    console.error(`scan-pii: ${listFile} has no patterns`);
    return 2;
  }
  let items;
  if (argv[0] === '--staged') items = stagedItems(process.cwd());
  else if (argv[0] === '--range') items = rangeItems(argv.slice(1), process.cwd());
  else if (argv.length) items = fileItems(argv);
  else {
    console.error('usage: scan-pii.js <file...> | --staged | --range <rev-list args>');
    return 2;
  }
  const hits = scanItems(items, matchers);
  for (const h of hits) console.log(h);
  return hits.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { loadMatchers, scanItems, rangeItems, stagedItems };
