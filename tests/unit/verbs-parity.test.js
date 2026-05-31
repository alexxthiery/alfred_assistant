// Asserts every verb in the shared VERBS metadata has a dispatch handler in `cmds`
// and vice versa. Catches "added a verb but forgot to wire it" + "removed a
// verb but forgot to update the help table" regressions, both of which would
// otherwise only surface when an agent typed the verb and got "unknown".
//
// bin/wiki isn't a require()-able module (dispatch runs at file end), so we
// parse the dispatch map directly. This is a static-shape assertion: it
// doesn't load any code, doesn't spawn anything, and runs in <5 ms.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DISPATCH_VERBS } = require('../../bin/lib/verb-metadata.js');

const WIKI_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'bin', 'wiki'),
  'utf-8'
);

function extractVerbsTable() {
  return new Set(DISPATCH_VERBS.map((v) => v.name));
}

function extractDispatchKeys(src) {
  const start = src.indexOf('const cmds = {');
  assert.ok(start >= 0, "couldn't find `const cmds = {` in bin/wiki");
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > start, "couldn't find end of cmds object");
  const block = src.slice(start, end + 1);
  const keys = new Set();
  // Quoted-string keys: 'sync-ids': cmdSyncIds
  for (const m of block.matchAll(/'([a-z][a-z0-9-]*)'\s*:\s*cmd[A-Za-z]+/g)) {
    keys.add(m[1]);
  }
  // Bare-identifier keys: list: cmdList   (excludes line-leading comments etc.)
  for (const m of block.matchAll(/(?:^|[,\s])([a-z][a-z0-9-]*)\s*:\s*cmd[A-Za-z]+/g)) {
    keys.add(m[1]);
  }
  return keys;
}

test('VERBS parity: every VERBS entry has a dispatch handler in cmds', () => {
  const verbs = extractVerbsTable();
  const cmds = extractDispatchKeys(WIKI_SRC);
  assert.ok(verbs.size > 0, 'VERBS table parsed empty');
  assert.ok(cmds.size > 0, 'cmds dispatch parsed empty');
  const orphaned = [...verbs].filter((v) => !cmds.has(v));
  assert.deepEqual(
    orphaned,
    [],
    `VERBS metadata entries with no dispatch: ${orphaned.join(', ')}. Either add a handler in const cmds, or remove the metadata entry.`
  );
});

test('VERBS parity: every cmds dispatch key has a VERBS entry', () => {
  const verbs = extractVerbsTable();
  const cmds = extractDispatchKeys(WIKI_SRC);
  const unlisted = [...cmds].filter((c) => !verbs.has(c));
  assert.deepEqual(
    unlisted,
    [],
    `cmds keys missing from VERBS metadata: ${unlisted.join(', ')}. Add to bin/lib/verb-metadata.js so help discovers them.`
  );
});

test('VERBS parity: parser sanity — counts are healthy (catches a silent parse failure)', () => {
  const verbs = extractVerbsTable();
  const cmds = extractDispatchKeys(WIKI_SRC);
  // Floor at 30 — the project ships ~40 verbs. If parsing degrades to ≤5,
  // both lists become trivially equal and the parity test passes vacuously.
  assert.ok(verbs.size >= 30, `expected ≥30 VERBS metadata entries, got ${verbs.size}`);
  assert.ok(cmds.size >= 30, `expected ≥30 cmds dispatch keys, got ${cmds.size}`);
});
