#!/usr/bin/env node
// nanoclaw-disposable-smoke.js - disposable two-vault smoke for NanoClaw upgrades.
//
// This is intentionally an operator smoke harness, not a daemon and not a
// replacement for the live Telegram canary. It exercises the host-side Alfred
// contract against throwaway vaults: deploy, env binding, git hygiene, one CLI
// write, private-log ignores, email-env fail-closed behavior, and optionally
// the focused NanoClaw provider guard tests.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SECRET_PATTERNS = [
  /[0-9]{4,}:[A-Za-z0-9_-]{10,}/g,
  /SMOKE_[A-Z0-9_]*SECRET[A-Z0-9_]*/g,
];

function usage() {
  return [
    'Usage:',
    '  tools/nanoclaw-disposable-smoke.js [--nanoclaw /path/to/nanoclaw-staging] [--skip-nanoclaw] [--keep]',
    '',
    'Creates two disposable vaults under /tmp, deploys Alfred into both, and runs',
    'host-side isolation/write/email fail-closed checks. With --nanoclaw, also',
    'runs the focused NanoClaw provider guard tests in container/agent-runner.',
    '',
    'This does not touch live vaults and does not validate real Telegram/Gmail.',
  ].join('\n');
}

function parseArgv(argv) {
  const out = { keep: false, skipNanoclaw: false, nanoclaw: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--nanoclaw':
        out.nanoclaw = value();
        break;
      case '--skip-nanoclaw':
        out.skipNanoclaw = true;
        break;
      case '--keep':
        out.keep = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  if (out.skipNanoclaw && out.nanoclaw) throw new Error('use either --nanoclaw or --skip-nanoclaw, not both');
  return out;
}

function redact(text) {
  let out = String(text || '');
  for (const re of SECRET_PATTERNS) out = out.replace(re, '<REDACTED>');
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: opts.env || process.env,
    encoding: 'utf8',
    input: opts.input,
  });
  if (opts.expectStatus !== undefined) {
    if (r.status !== opts.expectStatus) {
      throw new Error(
        `${cmd} ${args.join(' ')} exit=${r.status}, expected ${opts.expectStatus}\n${redact(r.stdout)}${redact(r.stderr)}`,
      );
    }
  } else if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed exit=${r.status}\n${redact(r.stdout)}${redact(r.stderr)}`);
  }
  return r;
}

function ok(msg) {
  console.log(`OK   ${msg}`);
}

function appendIgnore(vault, entries) {
  const file = path.join(vault, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
  const add = entries.filter((entry) => !lines.has(entry));
  if (!add.length) return;
  fs.appendFileSync(file, `${existing.endsWith('\n') || !existing ? '' : '\n'}${add.join('\n')}\n`);
}

function readEnvFile(file) {
  const env = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

function git(vault, args) {
  return run('git', args, { cwd: vault });
}

function gitStatus(vault) {
  return run('git', ['status', '--short'], { cwd: vault }).stdout.trim();
}

function writeEnv(vault, label) {
  const dir = path.join(vault, '.alfred', 'private');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const envFile = path.join(dir, 'env');
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${vault}`,
    `ALFRED_EXPECTED_LABEL=${label}`,
    `TELEGRAM_BOT_TOKEN=123456:SMOKE_${label.toUpperCase()}_SECRET_TOKEN`,
    `TELEGRAM_CHAT_ID=${label === 'alpha' ? '111111' : '222222'}`,
    'TZ=Asia/Singapore',
    '',
  ].join('\n'), { mode: 0o600 });
  return envFile;
}

function prepareVault(root, spec) {
  const vault = path.join(root, `${spec.label}-vault`);
  fs.cpSync(path.join(ROOT, 'tests', 'vault'), vault, { recursive: true });
  appendIgnore(vault, ['.bin/', '.alfred/private/', 'AGENTS.local.md', 'AGENTS.rendered.md']);

  run('bash', [
    'tools/deploy.sh',
    '--target', vault,
    '--user-name', spec.userName,
    '--user-slug', spec.userSlug,
    '--user-email', `${spec.userSlug}@example.invalid`,
    '--user-tz-city', 'Singapore',
    '--assistant-name', spec.assistantName,
    '--apply',
  ]);

  const canonical = path.join(vault, 'AGENTS.md');
  if (!fs.existsSync(canonical)) throw new Error(`${spec.label}: deploy did not create AGENTS.md`);

  const envFile = writeEnv(vault, spec.label);
  git(vault, ['init', '-q']);
  git(vault, ['config', 'user.name', 'Smoke Test']);
  git(vault, ['config', 'user.email', 'smoke@example.invalid']);
  git(vault, ['add', '-A']);
  git(vault, ['commit', '-q', '-m', `baseline ${spec.label} vault`]);
  if (gitStatus(vault)) throw new Error(`${spec.label} baseline is dirty after commit`);
  ok(`${spec.label}: disposable vault deployed and baseline committed`);
  return { ...spec, vault, envFile };
}

function runIsolation(v) {
  run(process.execPath, [
    'tools/check-assistant-isolation.js',
    '--vault', v.vault,
    '--env', v.envFile,
    '--label', v.label,
    '--expect-user-slug', v.userSlug,
    '--expect-assistant-name', v.assistantName,
  ]);
  ok(`${v.label}: isolation checker passes without sibling mounts`);
}

function runSiblingNegativeControl(v, sibling) {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'check-assistant-isolation.js'),
    '--vault', v.vault,
    '--env', v.envFile,
    '--label', v.label,
    '--other-vault', sibling.vault,
  ], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0 || !/other vault is accessible/.test(r.stderr)) {
    throw new Error(`sibling negative control did not fail as expected\n${redact(r.stdout)}${redact(r.stderr)}`);
  }
  ok('negative control: checker detects a host-visible sibling vault');
}

function runWriteScopeCheck(a, b) {
  const env = { ...process.env, ...readEnvFile(a.envFile) };
  run(path.join(a.vault, '.bin', 'wiki'), [
    'todo',
    'add',
    'Disposable smoke todo',
    '--tags',
    'work',
    '--priority',
    'low',
  ], { cwd: a.vault, env });
  if (gitStatus(a.vault)) throw new Error(`${a.label} dirty after wiki auto-commit`);
  if (gitStatus(b.vault)) throw new Error(`${b.label} changed after ${a.label} write`);
  ok('write scope: CLI todo write auto-committed in one vault and left sibling clean');
}

function runPrivateLogCheck(v) {
  const log = path.join(v.vault, '.alfred', 'private', 'conversations', 'probe.md');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, '# disposable conversation probe\n');
  if (gitStatus(v.vault)) throw new Error('private conversation probe appeared in git status');
  ok(`${v.label}: private conversation logs are gitignored`);
}

function runEmailFailClosedCheck(v) {
  const env = { ...process.env, ...readEnvFile(v.envFile) };
  delete env.EMAIL_FROM;
  delete env.GMAIL_IMAP_APP_PASSWORD;
  const r = run(path.join(v.vault, '.bin', 'email-review'), [
    '--days', '1',
    '--body-limit', '0',
    '--format', 'json',
  ], { cwd: v.vault, env, expectStatus: 2 });
  if (!/EMAIL_FROM env var not set/.test(r.stderr)) {
    throw new Error(`email-review failed for the wrong reason\n${redact(r.stderr || r.stdout)}`);
  }
  ok(`${v.label}: email review fails closed before any Gmail access when email env is absent`);
}

function runNanoclawFocusedTests(nanoclaw) {
  const root = path.resolve(nanoclaw);
  const runnerDir = path.join(root, 'container', 'agent-runner');
  if (!fs.existsSync(path.join(runnerDir, 'package.json'))) {
    throw new Error(`not a NanoClaw agent-runner checkout: ${runnerDir}`);
  }
  run('bun', [
    'test',
    'src/providers/claude-vault-write-guard.test.ts',
    'src/providers/claude-vault-use-gate.test.ts',
    'src/providers/claude.tool-collisions.test.ts',
  ], { cwd: runnerDir });
  ok('NanoClaw focused provider guard tests pass');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgv(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-nanoclaw-smoke-'));
  try {
    console.log(`Disposable smoke root: ${root}`);
    const alpha = prepareVault(root, {
      label: 'alpha',
      userSlug: 'alpha-user',
      userName: 'Alpha User',
      assistantName: 'Alfred',
    });
    const beta = prepareVault(root, {
      label: 'beta',
      userSlug: 'beta-user',
      userName: 'Beta User',
      assistantName: 'Minerva',
    });

    runIsolation(alpha);
    runIsolation(beta);
    runSiblingNegativeControl(alpha, beta);
    runWriteScopeCheck(alpha, beta);
    runPrivateLogCheck(alpha);
    runEmailFailClosedCheck(beta);
    if (args.nanoclaw) runNanoclawFocusedTests(args.nanoclaw);
    else if (args.skipNanoclaw) ok('NanoClaw focused tests skipped by request');
    else ok('NanoClaw focused tests skipped (pass --nanoclaw /path/to/staging)');

    console.log('\nDisposable NanoClaw/Alfred smoke passed.');
  } finally {
    if (args.keep) {
      console.log(`Kept disposable smoke root: ${root}`);
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`FAIL ${redact(err && err.message ? err.message : err)}`);
    process.exit(1);
  }
}

module.exports = { parseArgv, redact };
