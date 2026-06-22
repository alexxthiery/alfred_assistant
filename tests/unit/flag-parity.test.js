// Flag parity — the test class that was missing when `wiki list --limit` was
// silently ignored. Two directions, both static (parse source, no spawn):
//
//   Test A (no silent rejection): every flag the CODE reads (args.X /
//     args['X']) is in the verb's known-flags set. Guarantees the strict
//     validator in bin/wiki will never reject a flag the verb actually honors.
//     If this fails, either document the flag in the VERBS metadata or add it
//     to flag-spec's extraValidFlags.
//
//   Test B (no false advertising): every flag ADVERTISED in a verb's one-line
//     help is actually read by the code (or covered by a family). This is the
//     direct catch for the original bug: `list` advertising `--limit` while
//     cmdList ignored it.
//
// bin/wiki isn't require()-able (dispatch runs at file end), so we parse the
// source text of bin/wiki + bin/verbs/read.js directly.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { knownFlags, extraValidFlags, GLOBAL_FLAGS, FREEFORM_VERBS, flagsFromHelpText } =
  require('../../bin/lib/flag-spec.js');
const { DISPATCH_VERBS } = require('../../bin/lib/verb-metadata.js');

const ROOT = path.resolve(__dirname, '..', '..');
const WIKI_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'wiki'), 'utf-8');
const READ_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'verbs', 'read.js'), 'utf-8');
const COMMAND_SRCS = fs.readdirSync(path.join(ROOT, 'bin', 'commands'))
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => fs.readFileSync(path.join(ROOT, 'bin', 'commands', f), 'utf-8'));
const SOURCES = [WIKI_SRC, READ_SRC, ...COMMAND_SRCS];

// ─── parse source blocks used below ─────────────────────────────────────────
function topLevelBracketBlock(src, opener) {
  const start = src.indexOf(opener);
  assert.ok(start >= 0, `couldn't find ${JSON.stringify(opener)} in source`);
  const open = opener.trim().endsWith('[') ? '[' : '{';
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`couldn't find end of ${opener}`);
}

// ─── parse `const cmds = {}` → { verb: cmdFnName } ──────────────────────────
function verbToFn() {
  const block = topLevelBracketBlock(WIKI_SRC, 'const cmds = {');
  const map = {};
  const re = /(?:'([a-z][a-z0-9-]*)'|([a-z][a-z0-9-]*))\s*:\s*(cmd[A-Za-z]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const verb = m[1] || m[2];
    map[verb] = m[3];
  }
  return map;
}

// ─── index every top-level function body across both source files ───────────
function indexFunctions() {
  const bodies = {};
  for (const src of SOURCES) {
    const re = /function\s+([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      const parenStart = src.indexOf('(', m.index);
      let parenDepth = 0;
      let braceStart = -1;
      for (let i = parenStart; i < src.length; i++) {
        if (src[i] === '(') parenDepth++;
        else if (src[i] === ')' && --parenDepth === 0) {
          braceStart = src.indexOf('{', i);
          break;
        }
      }
      if (braceStart < 0) continue;
      let depth = 0;
      for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { bodies[name] = src.slice(braceStart, i + 1); break; }
      }
    }
  }
  return bodies;
}

const FUNCS = indexFunctions();

// Direct flag reads in one body: args.<name> and args['<name>'] / args["<name>"].
function directFlags(body) {
  const out = new Set();
  for (const m of body.matchAll(/\bargs\.([a-zA-Z_][\w]*)/g)) out.add(m[1]);
  for (const m of body.matchAll(/\bargs\[\s*['"]([^'"]+)['"]\s*\]/g)) out.add(m[1]);
  out.delete('_');
  return out;
}

// Flags read by a verb's handler, following delegation into sub-handlers /
// shared cores — but ONLY when the call actually threads `args` through. This
// is the crucial distinction:
//   predict:  cmdPatch({ ...args, ... })      → inherits patch's flags (follow)
//   sources:  cmdList({ _: [], type: '...' }) → fresh object, no inheritance (don't follow)
//   todo:     const subArgs = { ...args }; subs[sub](subArgs) → follow sub-handlers
// A verb that spreads args (`...args`) into a derived object is treated as
// passing its whole flag surface onward, so every in-source function it
// references is followed. Otherwise only callees invoked literally as `f(args`
// are followed.
function flagsReadByFn(fnName, visited = new Set()) {
  const body = FUNCS[fnName];
  if (!body || visited.has(fnName)) return new Set();
  visited.add(fnName);
  const out = directFlags(body);
  const spreadsArgs = /\.\.\.args\b/.test(body) || /=\s*args\b(?![.\[])/.test(body);
  for (const name of Object.keys(FUNCS)) {
    if (name === fnName) continue;
    if (!new RegExp(`\\b${name}\\b`).test(body)) continue;
    const threaded = spreadsArgs || new RegExp(`\\b${name}\\s*\\([^)]*\\bargs\\b`).test(body);
    if (threaded) for (const f of flagsReadByFn(name, visited)) out.add(f);
  }
  return out;
}

const HELP = Object.fromEntries(
  DISPATCH_VERBS.map((v) => [v.name, [...(v.lines || []), v.longHelp || ''].join('\n')])
);
const ADVERTISED_LINES = Object.fromEntries(
  DISPATCH_VERBS.map((v) => [v.name, (v.lines || []).join('\n')])
);
const FN = verbToFn();
const VERBS = Object.keys(FN);

test('flag parity: parser sanity (catches silent parse failure)', () => {
  assert.ok(VERBS.length >= 30, `expected ≥30 verbs, got ${VERBS.length}`);
  assert.ok(Object.keys(HELP).length >= 30, `expected ≥30 help entries, got ${Object.keys(HELP).length}`);
});

test('flag parity A: every flag the code reads is a known flag', () => {
  const violations = [];
  for (const verb of VERBS) {
    if (FREEFORM_VERBS.has(verb)) continue;
    if (!FUNCS[FN[verb]]) continue; // covered by verbs-parity test
    const read = flagsReadByFn(FN[verb]);
    const known = knownFlags(verb, HELP[verb] || '');
    for (const f of read) {
      if (!known.has(f)) violations.push(`${verb}: reads --${f} but it is not in help, a family, or GLOBAL_FLAGS`);
    }
  }
  assert.deepEqual(violations, [],
    'Code reads flags the validator would reject:\n  ' + violations.join('\n  ') +
    '\nFix: document the flag in the VERBS metadata `lines`, or add it to flag-spec extraValidFlags.');
});

// Flags a verb advertises but intentionally does not read, documented here so
// the test stays green without hiding real regressions. Keep this list tiny.
//   groom --mechanical: the only mode groom implements is mechanical, so it is
//     the default; the flag is accepted for explicitness but reading it would
//     be a no-op (see cmdGroom comments in bin/wiki).
const INTENTIONAL_UNREAD = { groom: new Set(['mechanical']) };

test('flag parity B: every flag advertised in help is implemented', () => {
  const violations = [];
  for (const verb of VERBS) {
    if (FREEFORM_VERBS.has(verb)) continue;
    if (!FUNCS[FN[verb]]) continue;
    const read = flagsReadByFn(FN[verb]);
    const family = extraValidFlags(verb);
    const exempt = INTENTIONAL_UNREAD[verb] || new Set();
    const advertised = flagsFromHelpText(ADVERTISED_LINES[verb] || '');
    for (const f of advertised) {
      if (GLOBAL_FLAGS.has(f)) continue;
      if (read.has(f) || family.has(f) || exempt.has(f)) continue;
      violations.push(`${verb}: help advertises --${f} but cmd${FN[verb].slice(3)} never reads it`);
    }
  }
  assert.deepEqual(violations, [],
    'Help advertises flags the code ignores (silent no-op, like the original `list --limit` bug):\n  ' +
    violations.join('\n  ') +
    '\nFix: implement the flag, or remove it from the VERBS help line.');
});
