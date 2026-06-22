'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { readTextSource } = require('../../bin/lib/text-input.js');

test('readTextSource: positional source passes through', () => {
  const out = readTextSource({ _: ['slug', 'hello'] }, {
    positionalIndex: 1,
    positionalLabel: '<body>',
    fileFlag: 'file',
    stdinFlag: 'stdin',
    label: 'body text',
  });
  assert.equal(out, 'hello');
});

test('readTextSource: conflicting positional and stdin is rejected', () => {
  assert.throws(() => readTextSource({ _: ['slug', 'hello'], stdin: true }, {
    positionalIndex: 1,
    positionalLabel: '<body>',
    fileFlag: 'file',
    stdinFlag: 'stdin',
    label: 'body text',
  }), /choose exactly one of <body>, --file, --stdin/);
});

test('readTextSource: stdin flag with a value is rejected', () => {
  assert.throws(() => readTextSource({ _: [], stdin: 'x' }, {
    stdinFlag: 'stdin',
    label: 'body text',
  }), /--stdin does not take a value/);
});

test('readTextSource: missing file is rejected', () => {
  assert.throws(() => readTextSource({ _: [], file: '/tmp/nope' }, {
    fileFlag: 'file',
    label: 'body text',
  }, { existsSync: () => false }), /file not found/);
});

test('readTextSource: stdin reader is used when requested', () => {
  const out = readTextSource({ _: [], stdin: true }, {
    stdinFlag: 'stdin',
    label: 'body text',
  }, { readStdin: () => 'from-stdin' });
  assert.equal(out, 'from-stdin');
});
