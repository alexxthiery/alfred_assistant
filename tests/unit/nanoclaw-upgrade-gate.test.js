// Unit tests for tools/nanoclaw-upgrade-gate.js.
//
// The behavioral oracle here is the command plan: fast mode must stay cheap
// enough for iteration, while full mode must include the heavyweight checks
// before canary.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgv,
  validatePaths,
  alfredCommands,
  nanoclawCommands,
  defaultLogDir,
  sanitizeLogName,
  tailLines,
  displayPath,
} = require('../../tools/nanoclaw-upgrade-gate.js');

function fakeNanoclaw() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-gate-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'container', 'agent-runner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'container', 'agent-runner', 'package.json'), '{}\n');
  return root;
}

test('parseArgv defaults to fast mode and requires a staging checkout', () => {
  assert.deepEqual(parseArgv(['--nanoclaw', '/tmp/nanoclaw']), {
    mode: 'fast',
    nanoclaw: '/tmp/nanoclaw',
    prod: '',
    skipAlfred: false,
    skipNanoclaw: false,
    skipSmoke: false,
    keepSmoke: false,
    logDir: '',
  });
  assert.throws(() => parseArgv([]), /--nanoclaw is required/);
});

test('parseArgv accepts an explicit log directory', () => {
  const args = parseArgv(['--nanoclaw', '/tmp/nanoclaw', '--log-dir', '/tmp/logs']);
  assert.equal(args.logDir, '/tmp/logs');
});

test('parseArgv rejects unknown modes', () => {
  assert.throws(() => parseArgv(['--nanoclaw', '/tmp/nanoclaw', '--mode', 'reckless']), /fast or full/);
});

test('validatePaths refuses when production and staging are the same checkout', () => {
  const root = fakeNanoclaw();
  assert.throws(() => validatePaths({ nanoclaw: root, prod: root }), /same path/);
});

test('fast command plan avoids heavyweight full-suite runs', () => {
  const alfred = alfredCommands('fast').map(([cmd, args]) => [cmd, args.join(' ')]);
  assert.ok(alfred.some(([cmd, args]) => cmd === 'node' && args.includes('persona-lint')));
  assert.ok(alfred.some(([cmd, args]) => cmd === 'npm' && args === 'run test:unit'));
  assert.ok(!alfred.some(([cmd, args]) => cmd === 'npm' && args === 'test'));
  assert.deepEqual(nanoclawCommands('/tmp/nanoclaw', 'fast'), []);
});

test('full command plan includes heavyweight Alfred and NanoClaw suites', () => {
  const alfred = alfredCommands('full').map(([cmd, args]) => [cmd, args.join(' ')]);
  const nano = nanoclawCommands('/tmp/nanoclaw', 'full').map(([cmd, args]) => [cmd, args.join(' ')]);
  assert.ok(alfred.some(([cmd, args]) => cmd === 'npm' && args === 'test'));
  assert.ok(nano.some(([cmd, args]) => cmd === 'pnpm' && args === 'run build'));
  assert.ok(nano.some(([cmd, args]) => cmd === 'pnpm' && args.includes('test')));
  assert.ok(nano.some(([cmd, args]) => cmd === 'bun' && args === 'test'));
});

test('defaultLogDir is under the gitignored audit gate directory', () => {
  const d = new Date('2026-09-14T07:39:12.000Z');
  assert.match(defaultLogDir('full', d), /audit\/nanoclaw-gates\/20260914073912-full$/);
});

test('sanitizeLogName creates stable filesystem-friendly names', () => {
  assert.equal(sanitizeLogName('NanoClaw pnpm test -- --reporter=dot'), 'nanoclaw-pnpm-test-reporter-dot');
  assert.equal(sanitizeLogName('!!!'), 'step');
});

test('tailLines returns only the requested diagnostic suffix', () => {
  assert.equal(tailLines('a\nb\nc\nd', 2), 'c\nd');
});

test('displayPath keeps repo-local paths concise and external paths absolute', () => {
  assert.equal(displayPath(path.resolve('audit/nanoclaw-gates/run.log')), 'audit/nanoclaw-gates/run.log');
  assert.equal(displayPath('/tmp/nanoclaw-gate/run.log'), '/tmp/nanoclaw-gate/run.log');
});
