// Unit tests for tools/check-assistant-isolation.js.
//
// These tests protect the multi-assistant deployment boundary: an assistant
// instance should be explicitly tied to one vault, one env file, and one
// launchd label namespace. The fixtures use fake deployed .bin tools so the
// oracle is independent of the implementation under test.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'check-assistant-isolation.js');
const NODE = process.execPath;

function writeExecutable(file, text) {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

function makeVault(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-isolation-'));
  const vault = path.join(root, opts.name || 'child-vault');
  const envFile = path.join(vault, '.alfred', 'private', opts.envName || 'env');
  fs.mkdirSync(path.join(vault, '.bin'), { recursive: true });
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(path.join(vault, '.alfred.yml'), [
    'user:',
    `  slug: ${opts.userSlug || 'child'}`,
    `  name: ${opts.userName || 'Child'}`,
    'assistant:',
    `  name: ${opts.assistantName || 'Alfred'}`,
    'paths:',
    '  vault_root: ""',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# Persona\n');
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${opts.expectedVault || vault}`,
    `ALFRED_EXPECTED_LABEL=${opts.expectedLabel || 'child'}`,
    opts.omitToken ? '' : `TELEGRAM_BOT_TOKEN=${opts.token || '123456:SECRET_TOKEN'}`,
    `TELEGRAM_CHAT_ID=${opts.chatId || '987654321'}`,
    opts.omitTz ? '' : `TZ=${opts.tz || 'Asia/Singapore'}`,
    '',
  ].filter((x) => x !== '').join('\n'));

  writeExecutable(path.join(vault, '.bin', 'wiki'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'jobs' || !args.includes('--json')) {
  console.error('unexpected wiki args: ' + args.join(' '));
  process.exit(2);
}
const labelIdx = args.indexOf('--label');
const requested = labelIdx >= 0 ? args[labelIdx + 1] : 'alfred';
const label = process.env.FAKE_WRONG_LABEL ? 'alfred' : requested;
const names = ['daily-brief', 'reminder-dispatch', 'email-review'];
if (args.includes('--check')) {
  console.log(JSON.stringify(names.map((name) => ({ name, label: 'com.' + label + '.' + name, status: 'missing', detail: 'no launchd/cron entry found' }))));
} else {
  console.log(JSON.stringify(names.map((name) => ({ name, label: 'com.' + label + '.' + name, wrapper: 'run-' + name + '.sh', schedule: { kind: 'calendar', hour: 7, minute: 0 }, purpose: 'test' }))));
}
`);

  const marker = path.join(root, 'telegram-called.txt');
  writeExecutable(path.join(vault, '.bin', 'telegram-send'), `#!/usr/bin/env node
if (!process.argv.includes('--dry-run')) process.exit(2);
if (process.env.FAKE_TELEGRAM_FAIL) {
  console.error('token leaked here: ' + process.env.TELEGRAM_BOT_TOKEN);
  process.exit(3);
}
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');
console.log('dry ok');
`);

  return { root, vault, envFile, marker };
}

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function initGitVault(vault, ignoreText = '.bin/\n.alfred/private/\n') {
  let r = git(vault, 'init', '-q');
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(path.join(vault, '.gitignore'), ignoreText);
}

function runCheck(args, env = {}) {
  return spawnSync(NODE, [TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('passes for one vault/env/label namespace and does not print Telegram token', () => {
  const { vault, envFile } = makeVault();
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child', '--expect-user-slug', 'child']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /Assistant isolation check passed/);
  assert.match(r.stdout, /com\.child\.\*/);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET_TOKEN/);
});

test('passes git hygiene when deployed .bin is ignored and untracked', () => {
  const { vault, envFile } = makeVault();
  initGitVault(vault);
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /git hygiene: \.bin\/ and private conversation logs are ignored/);
});

test('fails git hygiene when deployed .bin is tracked', () => {
  const { vault, envFile } = makeVault();
  initGitVault(vault);
  let r = git(vault, 'add', '-f', '.bin/wiki');
  assert.equal(r.status, 0, r.stderr);
  r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.bin\/ has 1 tracked file/);
});

test('fails git hygiene when private conversation logs are not ignored', () => {
  const { vault, envFile } = makeVault();
  initGitVault(vault, '.bin/\n');
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.alfred\/private\/conversations\/ is not gitignored/);
});

test('can verify the configured assistant display name', () => {
  const { vault, envFile } = makeVault({ assistantName: 'Minerva' });
  const r = runCheck([
    '--vault', vault,
    '--env', envFile,
    '--label', 'child',
    '--expect-user-slug', 'child',
    '--expect-assistant-name', 'Minerva',
  ]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /assistant\.name=Minerva/);
});

test('fails when the configured assistant display name drifts', () => {
  const { vault, envFile } = makeVault({ assistantName: 'Alfred' });
  const r = runCheck([
    '--vault', vault,
    '--env', envFile,
    '--label', 'child',
    '--expect-assistant-name', 'Minerva',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /assistant\.name is 'Alfred', expected 'Minerva'/);
});

test('fails when deployed wiki reports a different label namespace', () => {
  const { vault, envFile } = makeVault();
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child'], { FAKE_WRONG_LABEL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /labels outside com\.child\.\*/);
});

test('fails when Telegram token is absent from the assistant env file', () => {
  const { vault, envFile } = makeVault({ omitToken: true });
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /env file missing TELEGRAM_BOT_TOKEN/);
});

test('fails when timezone is absent from the assistant env file', () => {
  const { vault, envFile } = makeVault({ omitTz: true });
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /env file missing TZ/);
});

test('fails when timezone is not IANA-shaped', () => {
  const { vault, envFile } = makeVault({ tz: 'Singapore' });
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TZ does not look like an IANA timezone/);
});

test('fails when env file is bound to a different vault', () => {
  const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-isolation-wrong-'));
  const wrongVault = path.join(wrongRoot, 'wrong-vault');
  fs.mkdirSync(wrongVault);
  const { vault, envFile } = makeVault({ expectedVault: wrongVault });
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ALFRED_EXPECTED_VAULT/);
});

test('fails when env file is bound to a different assistant label', () => {
  const { vault, envFile } = makeVault({ expectedLabel: 'other' });
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ALFRED_EXPECTED_LABEL/);
});

test('fails when env file is outside the owning vault private directory', () => {
  const { root, vault } = makeVault();
  const outsideEnv = path.join(root, 'external.env');
  fs.writeFileSync(outsideEnv, [
    `ALFRED_EXPECTED_VAULT=${vault}`,
    'ALFRED_EXPECTED_LABEL=child',
    'TELEGRAM_BOT_TOKEN=123456:SECRET_TOKEN',
    'TELEGRAM_CHAT_ID=987654321',
    'TZ=Asia/Singapore',
    '',
  ].join('\n'));
  const r = runCheck(['--vault', vault, '--env', outsideEnv, '--label', 'child']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /env file must live under/);
});

test('fails when another vault is accessible from the checked runtime', () => {
  const { root, vault, envFile } = makeVault();
  const otherVault = path.join(root, 'other-vault');
  fs.mkdirSync(otherVault);
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child', '--other-vault', otherVault]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /other vault is accessible/);
});

test('optional telegram dry-run invokes the deployed sender with assistant env', () => {
  const { vault, envFile, marker } = makeVault();
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child', '--telegram-dry-run']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'called');
});

test('telegram dry-run failures redact secret values from child output', () => {
  const { vault, envFile } = makeVault();
  const r = runCheck(['--vault', vault, '--env', envFile, '--label', 'child', '--telegram-dry-run'], { FAKE_TELEGRAM_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /<REDACTED:TELEGRAM_BOT_TOKEN>/);
  assert.doesNotMatch(r.stderr, /SECRET_TOKEN/);
});
