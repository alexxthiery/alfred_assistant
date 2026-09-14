// Unit tests for tools/nanoclaw-staging-canary-env.js.
//
// The oracle is the canary safety contract: staging may carry only the
// temporary Telegram bot token, while the gateway credential comes from the
// production env file without inheriting Gmail or chat-id credentials.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgv,
  parseEnvFile,
  validateCanaryEnv,
  shellRecipe,
} = require('../../tools/nanoclaw-staging-canary-env.js');

function tempEnv(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-canary-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  return file;
}

test('parseArgv requires both env files', () => {
  assert.throws(() => parseArgv([]), /--staging-env is required/);
  assert.throws(() => parseArgv(['--staging-env', '/tmp/s']), /--prod-env is required/);
  assert.deepEqual(parseArgv(['--staging-env', '/tmp/s', '--prod-env', '/tmp/p']), {
    stagingEnv: '/tmp/s',
    prodEnv: '/tmp/p',
    printShell: false,
  });
});

test('parseEnvFile reads simple dotenv forms without logging values', () => {
  const file = tempEnv(`
# comment
export TELEGRAM_BOT_TOKEN="123:abc"
ONECLI_URL='http://token@gateway'
TZ=Asia/Singapore
`);
  const env = parseEnvFile(file);
  assert.equal(env.get('TELEGRAM_BOT_TOKEN'), '123:abc');
  assert.equal(env.get('ONECLI_URL'), 'http://token@gateway');
  assert.equal(env.get('TZ'), 'Asia/Singapore');
});

test('validateCanaryEnv accepts minimal split env', () => {
  const staging = tempEnv('TELEGRAM_BOT_TOKEN=999:staging\n');
  const prod = tempEnv('TELEGRAM_BOT_TOKEN=111:prod\nONECLI_URL=http://onecli.example\nTZ=Asia/Singapore\n');
  const result = validateCanaryEnv({ stagingEnv: staging, prodEnv: prod });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.hasTz, true);
});

test('validateCanaryEnv rejects same bot token as production', () => {
  const staging = tempEnv('TELEGRAM_BOT_TOKEN=111:same\n');
  const prod = tempEnv('TELEGRAM_BOT_TOKEN=111:same\nONECLI_URL=http://onecli.example\n');
  const result = validateCanaryEnv({ stagingEnv: staging, prodEnv: prod });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must differ from production/);
});

test('validateCanaryEnv rejects missing gateway credential', () => {
  const staging = tempEnv('TELEGRAM_BOT_TOKEN=999:staging\n');
  const prod = tempEnv('TELEGRAM_BOT_TOKEN=111:prod\n');
  const result = validateCanaryEnv({ stagingEnv: staging, prodEnv: prod });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /ONECLI_URL/);
});

test('validateCanaryEnv rejects leaked Gmail and chat routing keys in staging env', () => {
  const staging = tempEnv([
    'TELEGRAM_BOT_TOKEN=999:staging',
    'GMAIL_APP_PASSWORD=secret',
    'TELEGRAM_CHAT_ID=123',
    '',
  ].join('\n'));
  const prod = tempEnv('TELEGRAM_BOT_TOKEN=111:prod\nONECLI_URL=http://onecli.example\n');
  const result = validateCanaryEnv({ stagingEnv: staging, prodEnv: prod });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /GMAIL_APP_PASSWORD/);
  assert.match(result.errors.join('\n'), /TELEGRAM_CHAT_ID/);
});

test('shellRecipe references files without embedding secret values', () => {
  const staging = tempEnv('TELEGRAM_BOT_TOKEN=999:staging\n');
  const prod = tempEnv('TELEGRAM_BOT_TOKEN=111:prod\nONECLI_URL=http://secret@gateway\nTZ=Asia/Singapore\n');
  const result = validateCanaryEnv({ stagingEnv: staging, prodEnv: prod });
  const recipe = shellRecipe(result, '/tmp/nanoclaw-staging');
  assert.match(recipe, /grep '\^TELEGRAM_BOT_TOKEN='/);
  assert.match(recipe, /grep '\^ONECLI_URL='/);
  assert.doesNotMatch(recipe, /999:staging/);
  assert.doesNotMatch(recipe, /secret@gateway/);
  assert.match(recipe, /unset EMAIL_FROM GMAIL_APP_PASSWORD GMAIL_IMAP_APP_PASSWORD TELEGRAM_CHAT_ID/);
});
