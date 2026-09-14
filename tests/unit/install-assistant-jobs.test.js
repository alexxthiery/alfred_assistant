'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const INSTALLER = path.join(ROOT, 'tools', 'install-assistant-jobs.sh');

function writeExecutable(file, body = '#!/usr/bin/env bash\nexit 0\n') {
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-assistant-jobs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'child-vault');
  const wrappers = path.join(root, 'wrappers');
  const privateDir = path.join(vault, '.alfred', 'private');
  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(wrappers, { recursive: true });
  for (const f of ['assistant-binding.sh', 'run-daily-brief.sh']) {
    writeExecutable(path.join(wrappers, f));
  }
  const envFile = path.join(privateDir, 'env');
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${vault}`,
    'ALFRED_EXPECTED_LABEL=child',
    'TZ=Asia/Singapore',
    'TELEGRAM_BOT_TOKEN=token',
    'TELEGRAM_CHAT_ID=123',
    '',
  ].join('\n'));
  return { root, vault, wrappers, envFile };
}

function run(args) {
  return spawnSync('bash', [INSTALLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('install-assistant-jobs dry-run stamps label and vault-private env path', (t) => {
  const { vault, wrappers, envFile } = makeFixture(t);
  const r = run([
    '--vault', vault,
    '--env', envFile,
    '--label', 'child',
    '--brief', '07:00',
    '--wrappers', wrappers,
    '--dry-run',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const envReal = fs.realpathSync(envFile);
  assert.match(r.stdout, /<key>ALFRED_ASSISTANT_LABEL<\/key><string>child<\/string>/);
  assert.match(r.stdout, new RegExp(`<key>ENV_FILE</key><string>${envReal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
});

test('install-assistant-jobs refuses env files outside the vault private dir', (t) => {
  const { root, vault, wrappers } = makeFixture(t);
  const externalEnv = path.join(root, 'external.env');
  fs.writeFileSync(externalEnv, 'TELEGRAM_BOT_TOKEN=token\n');
  const r = run([
    '--vault', vault,
    '--env', externalEnv,
    '--label', 'child',
    '--brief', '07:00',
    '--wrappers', wrappers,
    '--dry-run',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /env file must live under/);
});

test('install-assistant-jobs refuses env files bound to another label', (t) => {
  const { vault, wrappers, envFile } = makeFixture(t);
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${vault}`,
    'ALFRED_EXPECTED_LABEL=other',
    'TZ=Asia/Singapore',
    'TELEGRAM_BOT_TOKEN=token',
    'TELEGRAM_CHAT_ID=123',
    '',
  ].join('\n'));
  const r = run([
    '--vault', vault,
    '--env', envFile,
    '--label', 'child',
    '--brief', '07:00',
    '--wrappers', wrappers,
    '--dry-run',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /env label binding mismatch/);
});

test('install-assistant-jobs refuses env files without timezone', (t) => {
  const { vault, wrappers, envFile } = makeFixture(t);
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${vault}`,
    'ALFRED_EXPECTED_LABEL=child',
    'TELEGRAM_BOT_TOKEN=token',
    'TELEGRAM_CHAT_ID=123',
    '',
  ].join('\n'));
  const r = run([
    '--vault', vault,
    '--env', envFile,
    '--label', 'child',
    '--brief', '07:00',
    '--wrappers', wrappers,
    '--dry-run',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must set TZ/);
});
