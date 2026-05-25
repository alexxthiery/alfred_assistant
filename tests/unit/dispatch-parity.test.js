// Dispatch parity — guards the wiring as verb handlers migrate out of bin/wiki
// into bin/commands/. Three static checks (parse source + require modules, no spawn):
//
//   1. VERBS table names == cmds dispatch keys. A verb advertised in help with
//      no handler (or a handler with no help entry) fails here.
//   2. Every cmd* exported by a bin/commands/*.js module is referenced as a
//      value in the cmds map. Catches "added a command module, forgot to wire
//      it" (and the reverse orphan).
//   3. Every cmd* destructured from a require('./commands/X.js') in bin/wiki is
//      actually exported by that module. Catches a typo'd import that would make
//      the verb silently undefined.
//
// bin/wiki runs dispatch at file end, so it is not require()-able; we parse its
// source text (same approach as flag-parity.test.js).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WIKI_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'wiki'), 'utf-8');
const COMMANDS_DIR = path.join(ROOT, 'bin', 'commands');

// Smallest balanced-bracket slice starting at `opener` (e.g. 'const cmds = {').
function topLevelBracketBlock(src, opener) {
  const start = src.indexOf(opener);
  assert.ok(start >= 0, `couldn't find ${JSON.stringify(opener)} in bin/wiki`);
  const open = opener.trim().endsWith('[') ? '[' : '{';
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`couldn't find end of ${opener}`);
}

// cmds map → { verb: cmdFnName }
function cmdsMap() {
  const block = topLevelBracketBlock(WIKI_SRC, 'const cmds = {');
  const map = {};
  const re = /(?:'([a-z][a-z0-9-]*)'|([a-z][a-z0-9-]*))\s*:\s*(cmd[A-Za-z0-9]+)/g;
  let m;
  while ((m = re.exec(block)) !== null) map[m[1] || m[2]] = m[3];
  return map;
}

// VERBS table → Set of names
function verbNames() {
  const block = topLevelBracketBlock(WIKI_SRC, 'const VERBS = [');
  const out = new Set();
  for (const m of block.matchAll(/\bname:\s*'([a-z][a-z0-9-]*)'/g)) out.add(m[1]);
  return out;
}

// require('./commands/X.js') destructures in bin/wiki → { 'X.js': [cmdNames] }
function commandImports() {
  const out = {};
  const re = /const\s*\{([^}]*)\}\s*=\s*require\('\.\/commands\/([^']+)'\)/g;
  let m;
  while ((m = re.exec(WIKI_SRC)) !== null) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    out[m[2]] = names;
  }
  return out;
}

function listCommandModules() {
  if (!fs.existsSync(COMMANDS_DIR)) return [];
  return fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.js'));
}

test('dispatch parity 1: VERBS names == cmds keys', () => {
  const cmds = cmdsMap();
  const verbs = verbNames();
  const cmdKeys = new Set(Object.keys(cmds));
  assert.ok(cmdKeys.size >= 30, `expected >=30 verbs, parsed ${cmdKeys.size} (parser broke?)`);
  const inCmdsNotVerbs = [...cmdKeys].filter((v) => !verbs.has(v));
  const inVerbsNotCmds = [...verbs].filter((v) => !cmdKeys.has(v));
  assert.deepEqual(inCmdsNotVerbs, [], `verbs dispatched but not in the VERBS help table: ${inCmdsNotVerbs.join(', ')}`);
  assert.deepEqual(inVerbsNotCmds, [], `verbs in the VERBS help table but not dispatched: ${inVerbsNotCmds.join(', ')}`);
});

test('dispatch parity 2: every bin/commands/ exported cmd is wired into cmds', () => {
  const modules = listCommandModules();
  if (!modules.length) return; // nothing migrated yet
  const cmdValues = new Set(Object.values(cmdsMap()));
  const seen = new Map(); // cmdName -> module (collision guard)
  for (const file of modules) {
    const exp = require(path.join(COMMANDS_DIR, file));
    for (const name of Object.keys(exp)) {
      if (!/^cmd[A-Z]/.test(name)) continue;
      assert.ok(!seen.has(name), `${name} exported by both ${seen.get(name)} and ${file}`);
      seen.set(name, file);
      assert.ok(cmdValues.has(name), `bin/commands/${file} exports ${name} but bin/wiki's cmds map never references it`);
    }
  }
});

test('dispatch parity 3: every ./commands import in bin/wiki is exported by its module', () => {
  const imports = commandImports();
  for (const [file, names] of Object.entries(imports)) {
    const modPath = path.join(COMMANDS_DIR, file);
    assert.ok(fs.existsSync(modPath), `bin/wiki imports ./commands/${file} which does not exist`);
    const exp = require(modPath);
    for (const name of names) {
      assert.ok(typeof exp[name] === 'function', `bin/wiki imports { ${name} } from ./commands/${file}, but the module does not export it`);
    }
  }
});
