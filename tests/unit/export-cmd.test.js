// Integration tests for bin/commands/export.js — `wiki export` end to end
// against a throwaway vault. Drives the real cmdExport via the --content path
// (no stdin coupling), asserting the file lands inside output/, collisions
// suffix, hostile names stay contained, and refusals exit with the documented
// codes. The pure filename logic is covered separately in output-export.test.js.
//
// Like page-io.test.js, the command module binds VAULT_ROOT at require time from
// WIKI_ROOT, so we set it to a temp dir BEFORE requiring. node --test runs each
// file in its own process, so the override does not leak.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'exportcmd-'));
process.env.WIKI_ROOT = TMP;

const { cmdExport } = require('../../bin/commands/export.js');
const OUTPUT_DIR = path.join(TMP, 'output');

// Run cmdExport with stdout/stderr captured and process.exit intercepted, so a
// refusal surfaces as a thrown { code } instead of killing the test process.
function run(args) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  let exitCode = 0;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exit = (code) => {
    exitCode = code || 0;
    throw Object.assign(new Error(`exit ${exitCode}`), { __exit: exitCode });
  };
  try {
    cmdExport(args);
  } catch (e) {
    if (e && e.__exit === undefined) throw e; // real error, not our exit shim
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exit = origExit;
  }
  return { out, err, exitCode };
}

test('export: writes the deliverable under output/ and prints its absolute path', () => {
  const { out, exitCode } = run({ _: ['Q2 Summary'], content: 'hello body' });
  assert.equal(exitCode, 0);
  const dest = out[0];
  assert.equal(dest, path.join(OUTPUT_DIR, 'Q2-Summary.md'));
  assert.ok(fs.existsSync(dest), 'file should exist on disk');
  // Body is preserved and newline-terminated.
  assert.equal(fs.readFileSync(dest, 'utf-8'), 'hello body\n');
});

test('export: a second write to the same name does not clobber — it suffixes', () => {
  run({ _: ['dup'], content: 'first' });
  const { out } = run({ _: ['dup'], content: 'second' });
  assert.equal(out[0], path.join(OUTPUT_DIR, 'dup-2.md'));
  assert.equal(fs.readFileSync(path.join(OUTPUT_DIR, 'dup.md'), 'utf-8'), 'first\n');
  assert.equal(fs.readFileSync(path.join(OUTPUT_DIR, 'dup-2.md'), 'utf-8'), 'second\n');
});

test('export --force overwrites in place', () => {
  run({ _: ['over'], content: 'v1' });
  const { out } = run({ _: ['over'], content: 'v2', force: true });
  assert.equal(out[0], path.join(OUTPUT_DIR, 'over.md'));
  assert.equal(fs.readFileSync(path.join(OUTPUT_DIR, 'over.md'), 'utf-8'), 'v2\n');
});

test('export: a hostile traversal name cannot escape output/', () => {
  const { out, exitCode } = run({ _: ['../../etc/passwd'], content: 'x' });
  assert.equal(exitCode, 0);
  const dest = out[0];
  // The written path must be a direct child of OUTPUT_DIR.
  assert.equal(path.dirname(dest), OUTPUT_DIR, `must stay in output/: ${dest}`);
  assert.ok(!fs.existsSync('/etc/passwd.md'));
});

test('export: --ext controls the extension', () => {
  const { out } = run({ _: ['data'], ext: 'csv', content: 'a,b,c' });
  assert.equal(out[0], path.join(OUTPUT_DIR, 'data.csv'));
});

test('export: missing <name> is a usage error (exit 1)', () => {
  const { exitCode, err } = run({ _: [] });
  assert.equal(exitCode, 1);
  assert.ok(err.join('\n').includes('Usage: wiki export'));
});

test('export: empty body is refused (exit 3), no file created', () => {
  const before = fs.readdirSync(OUTPUT_DIR).length;
  const { exitCode, err } = run({ _: ['blank'], content: '   ' });
  assert.equal(exitCode, 3);
  assert.match(err.join('\n'), /empty deliverable/);
  assert.equal(fs.readdirSync(OUTPUT_DIR).length, before, 'no new file on refusal');
});

test('export: an unusable name is refused (exit 3)', () => {
  const { exitCode, err } = run({ _: ['...'], content: 'x' });
  assert.equal(exitCode, 3);
  assert.match(err.join('\n'), /no usable characters|empty/);
});
