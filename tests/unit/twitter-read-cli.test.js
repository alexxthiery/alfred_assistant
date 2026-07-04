'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'twitter-read');

function makeFakeBird() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bird-'));
  const log = path.join(dir, 'argv.txt');
  const bin = path.join(dir, 'bird');
  fs.writeFileSync(bin, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\n'));`,
    "process.stdout.write('fake-bird-ok\\n');",
    '',
  ].join('\n'));
  fs.chmodSync(bin, 0o755);
  return { bin, log };
}

test('twitter-read CLI: forwards allowed verbs to the backend and appends Alfred cookie flags', () => {
  const fake = makeFakeBird();
  const r = spawnSync('node', [CLI, 'bookmarks', '-n', '5'], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ALFRED_BIRD_BIN: fake.bin,
      ALFRED_BIRD_AUTH_TOKEN: 'tok123',
      ALFRED_BIRD_CT0: 'ct0123',
    },
  });

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fake-bird-ok/);
  const forwarded = fs.readFileSync(fake.log, 'utf-8').trim().split('\n');
  assert.deepEqual(forwarded, ['bookmarks', '-n', '5', '--auth-token', 'tok123', '--ct0', 'ct0123']);
});

test('twitter-read CLI: rejects unsupported verbs without invoking the backend', () => {
  const fake = makeFakeBird();
  const r = spawnSync('node', [CLI, 'tweet', 'hello'], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      ALFRED_BIRD_BIN: fake.bin,
    },
  });

  assert.equal(r.status, 1);
  assert.match(r.stderr, /unsupported verb: tweet/);
  assert.equal(fs.existsSync(fake.log), false, 'backend must not be invoked for blocked verbs');
});
