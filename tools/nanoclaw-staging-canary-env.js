#!/usr/bin/env node
// nanoclaw-staging-canary-env.js - validate the live Telegram canary env split.
//
// The live canary intentionally combines exactly two secret sources:
//   - staging env: temporary canary TELEGRAM_BOT_TOKEN
//   - production env: ONECLI_URL gateway credential, plus optional TZ
//
// It must not inherit Gmail credentials or the production Telegram token.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_STAGING_KEYS = new Set(['TELEGRAM_BOT_TOKEN']);
const FORBIDDEN_RUNTIME_KEYS = new Set([
  'EMAIL_FROM',
  'GMAIL_APP_PASSWORD',
  'GMAIL_IMAP_APP_PASSWORD',
  'TELEGRAM_CHAT_ID',
]);

function usage() {
  return [
    'Usage:',
    '  tools/nanoclaw-staging-canary-env.js --staging-env <file> --prod-env <file> [--print-shell]',
    '',
    'Validates the minimal env split for a live NanoClaw Telegram staging canary.',
    'It never prints secret values.',
  ].join('\n');
}

function parseArgv(argv) {
  const out = { stagingEnv: '', prodEnv: '', printShell: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--staging-env':
        out.stagingEnv = value();
        break;
      case '--prod-env':
        out.prodEnv = value();
        break;
      case '--print-shell':
        out.printShell = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!out.help && !out.stagingEnv) throw new Error('--staging-env is required');
  if (!out.help && !out.prodEnv) throw new Error('--prod-env is required');
  return out;
}

function parseEnvFile(file) {
  const env = new Map();
  const text = fs.readFileSync(file, 'utf-8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env.set(match[1], value);
  }
  return env;
}

function ensureFile(file, label) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`${label} env file not found: ${abs}`);
  if (!fs.statSync(abs).isFile()) throw new Error(`${label} env path is not a file: ${abs}`);
  return abs;
}

function validateCanaryEnv({ stagingEnv, prodEnv }) {
  const stagingFile = ensureFile(stagingEnv, 'staging');
  const prodFile = ensureFile(prodEnv, 'production');
  const staging = parseEnvFile(stagingFile);
  const prod = parseEnvFile(prodFile);

  const errors = [];
  const warnings = [];

  if (!staging.get('TELEGRAM_BOT_TOKEN')) errors.push('staging env must contain TELEGRAM_BOT_TOKEN');
  if (!prod.get('TELEGRAM_BOT_TOKEN')) warnings.push('production env has no TELEGRAM_BOT_TOKEN to compare against');
  if (!prod.get('ONECLI_URL')) errors.push('production env must contain ONECLI_URL for the staging gateway');

  if (
    staging.get('TELEGRAM_BOT_TOKEN') &&
    prod.get('TELEGRAM_BOT_TOKEN') &&
    staging.get('TELEGRAM_BOT_TOKEN') === prod.get('TELEGRAM_BOT_TOKEN')
  ) {
    errors.push('staging TELEGRAM_BOT_TOKEN must differ from production TELEGRAM_BOT_TOKEN');
  }

  for (const key of staging.keys()) {
    if (!ALLOWED_STAGING_KEYS.has(key)) errors.push(`staging env must not contain ${key}; keep it to TELEGRAM_BOT_TOKEN only`);
  }

  for (const key of FORBIDDEN_RUNTIME_KEYS) {
    if (staging.has(key)) errors.push(`staging env must not contain ${key}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stagingFile,
    prodFile,
    hasTz: Boolean(prod.get('TZ')),
  };
}

function shellRecipe(result, nanoclawDir = '$NANOCLAW_STAGING') {
  const tzLine = result.hasTz
    ? `TZ="$(grep '^TZ=' ${JSON.stringify(result.prodFile)} | cut -d= -f2-)"`
    : 'TZ="Asia/Singapore"  # set explicitly if production env has no TZ';
  return [
    'Use this shape from the staging NanoClaw checkout; it references files but does not echo secrets:',
    '',
    `cd ${nanoclawDir}`,
    `TELEGRAM_BOT_TOKEN="$(grep '^TELEGRAM_BOT_TOKEN=' ${JSON.stringify(result.stagingFile)} | cut -d= -f2-)"`,
    `ONECLI_URL="$(grep '^ONECLI_URL=' ${JSON.stringify(result.prodFile)} | cut -d= -f2-)"`,
    tzLine,
    'export TELEGRAM_BOT_TOKEN ONECLI_URL TZ',
    'unset EMAIL_FROM GMAIL_APP_PASSWORD GMAIL_IMAP_APP_PASSWORD TELEGRAM_CHAT_ID',
    'pnpm run dev',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgv(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = validateCanaryEnv({ stagingEnv: args.stagingEnv, prodEnv: args.prodEnv });
  for (const warning of result.warnings) console.error(`WARN ${warning}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`FAIL ${error}`);
    process.exit(1);
  }
  console.log('Canary env preflight passed.');
  console.log('Runtime env keys: TELEGRAM_BOT_TOKEN from staging; ONECLI_URL and TZ from production.');
  console.log('Forbidden keys excluded: EMAIL_FROM, GMAIL_APP_PASSWORD, GMAIL_IMAP_APP_PASSWORD, TELEGRAM_CHAT_ID.');
  if (args.printShell) console.log(`\n${shellRecipe(result)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`FAIL ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgv,
  parseEnvFile,
  validateCanaryEnv,
  shellRecipe,
};
