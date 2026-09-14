#!/usr/bin/env node
// check-assistant-isolation.js — preflight one assistant instance on a multi-vault host.
//
// This is an operator smoke check, not a runtime daemon. It validates the local
// routing boundary before a Telegram-facing assistant is handed to a user:
// one vault, one env file, one launchd label namespace, one deployed CLI.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadConfig } = require('../bin/lib/config.js');
const { privateEnvPathErrors } = require('../bin/lib/vault-binding.js');

const LABEL_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const REQUIRED_ENV = [
  'ALFRED_EXPECTED_VAULT',
  'ALFRED_EXPECTED_LABEL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TZ',
];
const SECRET_KEYS = new Set([
  'TELEGRAM_BOT_TOKEN',
  'GMAIL_APP_PASSWORD',
  'GMAIL_IMAP_APP_PASSWORD',
  'ALFRED_BIRD_AUTH_TOKEN',
  'ALFRED_BIRD_CT0',
]);

function usage() {
  return [
    'Usage:',
    '  tools/check-assistant-isolation.js --vault <path> --env <path> --label <slug>',
    '      [--expect-user-slug <slug>] [--expect-assistant-name <name>]',
    '      [--other-vault <path>] [--telegram-dry-run]',
    '',
    'Checks:',
    '  - vault exists and has .alfred.yml, AGENTS.md, .bin/wiki, .bin/telegram-send',
    '  - env file lives under <vault>/.alfred/private/ and is bound to this vault/label',
    '  - env file has TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TZ without printing secrets',
    '  - deployed wiki jobs manifest uses com.<label>.* labels',
    '  - if the vault is a git repo, .bin/ is ignored and not tracked',
    '  - optional: user.slug matches --expect-user-slug',
    '  - optional: assistant.name matches --expect-assistant-name',
    '  - optional: each --other-vault is inaccessible from this runtime',
    '  - optional: telegram-send --dry-run succeeds using this env file',
  ].join('\n');
}

function parseArgv(argv) {
  const out = { otherVaults: [], telegramDryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--vault': out.vault = value(); break;
      case '--env': out.envFile = value(); break;
      case '--label': out.label = value(); break;
      case '--expect-user-slug': out.expectUserSlug = value(); break;
      case '--expect-assistant-name': out.expectAssistantName = value(); break;
      case '--other-vault': out.otherVaults.push(value()); break;
      case '--telegram-dry-run': out.telegramDryRun = true; break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

function real(p) {
  return fs.realpathSync(path.resolve(p));
}

function realOrNull(p) {
  try {
    return real(p);
  } catch {
    return null;
  }
}

function parseEnvFile(file) {
  const env = {};
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (seen.has(key)) throw new Error(`env file defines ${key} more than once`);
    seen.add(key);
    if (value.length >= 2) {
      const a = value[0], b = value[value.length - 1];
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function redact(text, env) {
  let out = String(text || '');
  for (const [k, v] of Object.entries(env || {})) {
    if (!v || !SECRET_KEYS.has(k)) continue;
    out = out.split(v).join(`<REDACTED:${k}>`);
  }
  return out;
}

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`OK   ${msg}`);
}

function requireFile(file, desc) {
  if (!fs.existsSync(file)) throw new Error(`missing ${desc}: ${file}`);
}

function requireExecutable(file, desc) {
  requireFile(file, desc);
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    throw new Error(`${desc} is not executable: ${file}`);
  }
}

function canAccess(p, mode) {
  try {
    fs.accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
}

function runJson(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: opts.env || process.env, cwd: opts.cwd || process.cwd() });
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed exit=${r.status}: ${redact(r.stderr || r.stdout, opts.redactEnv)}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} did not emit JSON: ${redact(r.stdout, opts.redactEnv)}`);
  }
}

function git(args, opts = {}) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
  });
}

function isGitWorktree(vault) {
  const r = git(['-C', vault, 'rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

function gitCheckIgnored(vault, relPath) {
  const r = git(['-C', vault, 'check-ignore', '--no-index', relPath]);
  return r.status === 0;
}

function trackedFiles(vault, relPath) {
  const r = git(['-C', vault, 'ls-files', relPath]);
  if (r.status !== 0) throw new Error(`git ls-files ${relPath} failed: ${r.stderr || r.stdout}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function check(args) {
  if (!args.vault || !args.envFile || !args.label) throw new Error('--vault, --env, and --label are required');
  if (!LABEL_RE.test(args.label)) throw new Error(`invalid --label '${args.label}' (use lowercase letters, digits, hyphens)`);
  if (args.expectUserSlug && !LABEL_RE.test(args.expectUserSlug)) {
    throw new Error(`invalid --expect-user-slug '${args.expectUserSlug}'`);
  }

  const vault = real(args.vault);
  const envFile = real(args.envFile);
  const wiki = path.join(vault, '.bin', 'wiki');
  const telegramSend = path.join(vault, '.bin', 'telegram-send');

  requireFile(path.join(vault, '.alfred.yml'), 'vault config');
  requireFile(path.join(vault, 'AGENTS.md'), 'vault persona');
  requireExecutable(wiki, 'deployed wiki');
  requireExecutable(telegramSend, 'deployed telegram-send');
  ok(`vault surface exists: ${vault}`);

  const envPathErrors = privateEnvPathErrors({ vault, envFile });
  if (envPathErrors.length) throw new Error(envPathErrors.join('; '));
  ok('env file is stored inside this vault private directory');

  for (const other of args.otherVaults || []) {
    const otherReal = realOrNull(other);
    if (!otherReal) {
      ok(`other vault is not visible from this runtime: ${other}`);
      continue;
    }
    if (otherReal === vault) throw new Error(`--other-vault resolves to the target vault: ${other}`);
    if (canAccess(otherReal, fs.constants.R_OK) || canAccess(otherReal, fs.constants.W_OK)) {
      throw new Error(`other vault is accessible from this runtime: ${otherReal}`);
    }
    ok(`other vault exists but is not readable/writable from this runtime: ${otherReal}`);
  }

  const cfg = loadConfig(vault);
  if (path.resolve(cfg.paths.vault_root) !== vault) {
    throw new Error(`.alfred.yml resolves paths.vault_root to ${cfg.paths.vault_root}, expected ${vault}`);
  }
  if (args.expectUserSlug && cfg.user.slug !== args.expectUserSlug) {
    throw new Error(`.alfred.yml user.slug is '${cfg.user.slug}', expected '${args.expectUserSlug}'`);
  }
  if (args.expectAssistantName && cfg.assistant.name !== args.expectAssistantName) {
    throw new Error(`.alfred.yml assistant.name is '${cfg.assistant.name}', expected '${args.expectAssistantName}'`);
  }
  ok(`vault identity loaded: user.slug=${cfg.user.slug}, assistant.name=${cfg.assistant.name}`);

  const env = parseEnvFile(envFile);
  for (const key of REQUIRED_ENV) {
    if (!env[key]) throw new Error(`env file missing ${key}`);
  }
  const expectedVault = real(env.ALFRED_EXPECTED_VAULT);
  if (expectedVault !== vault) {
    throw new Error(`env file ALFRED_EXPECTED_VAULT resolves to ${expectedVault}, expected ${vault}`);
  }
  if (env.ALFRED_EXPECTED_LABEL !== args.label) {
    throw new Error(`env file ALFRED_EXPECTED_LABEL is '${env.ALFRED_EXPECTED_LABEL}', expected '${args.label}'`);
  }
  ok(`env file is bound to vault + label: ${args.label}`);
  if (!/^[A-Za-z_]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?$/.test(env.TZ)) {
    throw new Error(`env file TZ does not look like an IANA timezone: ${env.TZ}`);
  }
  ok(`env file has required Telegram keys and TZ`);

  const manifest = runJson(wiki, ['jobs', '--label', args.label, '--json'], { cwd: vault, redactEnv: env });
  const badLabels = manifest
    .filter((j) => !j.label || !j.label.startsWith(`com.${args.label}.`))
    .map((j) => `${j.name}:${j.label}`);
  if (badLabels.length) throw new Error(`jobs manifest has labels outside com.${args.label}.*: ${badLabels.join(', ')}`);
  ok(`jobs manifest is label-scoped: com.${args.label}.*`);

  const jobHealth = runJson(wiki, ['jobs', '--check', '--label', args.label, '--json'], { cwd: vault, redactEnv: env });
  const drift = jobHealth.filter((j) => j.status === 'drift');
  if (drift.length) throw new Error(`scheduled job drift: ${drift.map((j) => `${j.name}:${j.detail}`).join('; ')}`);
  ok(`scheduled-job check ran for label ${args.label} (${jobHealth.length} jobs; missing is allowed before install)`);

  if (isGitWorktree(vault)) {
    if (!gitCheckIgnored(vault, '.bin/wiki')) {
      throw new Error('.bin/wiki is not gitignored; deployed runtime code should not dirty vault history');
    }
    if (!gitCheckIgnored(vault, '.alfred/private/conversations/probe')) {
      throw new Error('.alfred/private/conversations/ is not gitignored; full discussion logs must stay local-only');
    }
    const trackedBin = trackedFiles(vault, '.bin');
    if (trackedBin.length) {
      const sample = trackedBin.slice(0, 3).join(', ');
      throw new Error(`.bin/ has ${trackedBin.length} tracked file(s), e.g. ${sample}; run git rm -r --cached .bin after reviewing`);
    }
    ok('git hygiene: .bin/ and private conversation logs are ignored and .bin/ is untracked');
  } else {
    ok('git hygiene skipped (vault is not a git worktree)');
  }

  if (args.telegramDryRun) {
    const childEnv = { ...process.env, ...env, ALFRED_ASSISTANT_LABEL: args.label };
    const r = spawnSync(telegramSend, ['--dry-run'], {
      input: '',
      encoding: 'utf8',
      env: childEnv,
      cwd: vault,
    });
    if (r.status !== 0) {
      throw new Error(`telegram-send --dry-run failed exit=${r.status}: ${redact(r.stderr || r.stdout, env)}`);
    }
    ok(`telegram-send --dry-run succeeded for label ${args.label}`);
  } else {
    ok('telegram network dry-run skipped (pass --telegram-dry-run to validate token reachability)');
  }
}

function main() {
  let args;
  try {
    args = parseArgv(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    check(args);
  } catch (e) {
    fail(e.message);
  }
  if (process.exitCode) {
    console.error('\nAssistant isolation check failed.');
  } else {
    console.log('\nAssistant isolation check passed.');
  }
}

if (require.main === module) main();

module.exports = { parseEnvFile, redact, parseArgv };
