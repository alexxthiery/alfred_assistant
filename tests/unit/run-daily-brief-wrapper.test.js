'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRAPPER = path.join(REPO_ROOT, 'integrations', 'scheduling', 'run-daily-brief.sh');

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeVault(t, scripts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-daily-wrapper-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const vault = path.join(tmp, 'vault');
  const bin = path.join(vault, '.bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, content] of Object.entries(scripts)) {
    writeExecutable(path.join(bin, name), content);
  }
  return { tmp, vault };
}

function dailyBriefScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tz) shift 2 ;;
    --print-subject) echo "Daily brief: fake"; exit 0 ;;
    *) shift ;;
  esac
done
echo "BODY"
`;
}

function runWrapper(vault, extraEnv = {}) {
  const envFile = path.join(vault, '.alfred', 'private', 'env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  const fileEnv = {
    ALFRED_EXPECTED_VAULT: vault,
    ALFRED_EXPECTED_LABEL: 'child',
    EMAIL_FROM: 'user@example.com',
    GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: '12345',
  };
  for (const key of Object.keys(fileEnv)) {
    if (Object.prototype.hasOwnProperty.call(extraEnv, key)) fileEnv[key] = extraEnv[key];
  }
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${fileEnv.ALFRED_EXPECTED_VAULT}`,
    `ALFRED_EXPECTED_LABEL=${fileEnv.ALFRED_EXPECTED_LABEL}`,
    `EMAIL_FROM=${fileEnv.EMAIL_FROM}`,
    `GMAIL_APP_PASSWORD=${fileEnv.GMAIL_APP_PASSWORD}`,
    `TELEGRAM_BOT_TOKEN=${fileEnv.TELEGRAM_BOT_TOKEN}`,
    `TELEGRAM_CHAT_ID=${fileEnv.TELEGRAM_CHAT_ID}`,
    '',
  ].join('\n'));
  return spawnSync('bash', [WRAPPER], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALFRED_VAULT: vault,
      ALFRED_ASSISTANT_LABEL: 'child',
      ENV_FILE: envFile,
      TZ: 'Asia/Singapore',
      ...extraEnv,
    },
  });
}

test('daily brief wrapper still sends Telegram when email fails', (t) => {
  const marker = path.join(os.tmpdir(), `alfred-telegram-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const { vault } = makeVault(t, {
    'daily-brief': dailyBriefScript(),
    'email-digest': `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
echo "curl: (6) Could not resolve host: smtp.gmail.com" >&2
exit 6
`,
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat > "$TEST_TELEGRAM_BODY"
echo "sent to Telegram chat"
`,
  });

  const result = runWrapper(vault, {
    DAILY_BRIEF_RETRY_ON_FAILURE: '0',
    TEST_TELEGRAM_BODY: marker,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'BODY\n');
  const log = fs.readFileSync(path.join(vault, 'cache', 'daily-brief', 'send.log'), 'utf8');
  assert.match(log, /email send failed exit=6/);
  assert.match(log, /telegram send ok/);
  assert.match(log, /retry disabled; failed channel\(s\): email/);
});

test('daily brief wrapper refuses to source an env file outside the vault private dir', (t) => {
  const externalEnv = path.join(os.tmpdir(), `alfred-external-env-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(externalEnv, { force: true }));
  fs.writeFileSync(externalEnv, [
    'ALFRED_EXPECTED_VAULT=/tmp/wrong',
    'ALFRED_EXPECTED_LABEL=child',
    'TELEGRAM_BOT_TOKEN=telegram-token',
    'TELEGRAM_CHAT_ID=12345',
    '',
  ].join('\n'));
  const { vault } = makeVault(t, {
    'daily-brief': dailyBriefScript(),
    'email-digest': `#!/usr/bin/env bash
exit 9
`,
    'telegram-send': `#!/usr/bin/env bash
exit 9
`,
  });

  const result = runWrapper(vault, {
    ENV_FILE: externalEnv,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /ENV_FILE must live under/);
});

test('daily brief wrapper treats env file as inert data, not shell code', (t) => {
  const marker = path.join(os.tmpdir(), `alfred-env-code-${process.pid}-${Date.now()}`);
  const telegramFile = path.join(os.tmpdir(), `alfred-env-code-telegram-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(marker, { force: true });
    fs.rmSync(telegramFile, { force: true });
  });
  const { vault } = makeVault(t, {
    'daily-brief': dailyBriefScript(),
    'email-digest': `#!/usr/bin/env bash
exit 9
`,
    'telegram-send': `#!/usr/bin/env bash
cat > "$TEST_TELEGRAM"
`,
  });

  const result = runWrapper(vault, {
    EMAIL_FROM: `$(touch ${marker})`,
    TEST_TELEGRAM: telegramFile,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsafe shell syntax in ENV_FILE/);
  assert.equal(fs.existsSync(marker), false, 'env-file value must not execute command substitution');
  assert.equal(fs.existsSync(telegramFile), false, 'job should not reach Telegram after unsafe env');
});

test('daily brief wrapper fails before channels when env binding points elsewhere', (t) => {
  const marker = path.join(os.tmpdir(), `alfred-binding-marker-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const { tmp, vault } = makeVault(t, {
    'daily-brief': dailyBriefScript(),
    'email-digest': `#!/usr/bin/env bash
echo touched > "$TEST_MARKER"
`,
    'telegram-send': `#!/usr/bin/env bash
echo touched > "$TEST_MARKER"
`,
  });
  const other = path.join(tmp, 'other-vault');
  fs.mkdirSync(other);

  const result = runWrapper(vault, {
    ALFRED_EXPECTED_VAULT: other,
    TEST_MARKER: marker,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /vault binding mismatch/);
  assert.equal(fs.existsSync(marker), false);
});

test('daily brief wrapper enables strict deployed mode after binding', (t) => {
  const strictMarker = path.join(os.tmpdir(), `alfred-strict-deployed-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(strictMarker, { force: true }));
  const { vault } = makeVault(t, {
    'daily-brief': `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "\${ALFRED_STRICT_DEPLOYED:-}" > "$TEST_STRICT_MARKER"
echo "BODY"
`,
    'email-digest': `#!/usr/bin/env bash
cat >/dev/null
echo "sent to email"
`,
    'telegram-send': `#!/usr/bin/env bash
cat >/dev/null
`,
  });

  const result = runWrapper(vault, {
    TEST_STRICT_MARKER: strictMarker,
    DAILY_BRIEF_RETRY_ON_FAILURE: '0',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(strictMarker, 'utf8'), '1');
});

test('daily brief wrapper preserves an explicit strict-mode repair override', (t) => {
  const strictMarker = path.join(os.tmpdir(), `alfred-strict-deployed-override-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(strictMarker, { force: true }));
  const { vault } = makeVault(t, {
    'daily-brief': `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "\${ALFRED_STRICT_DEPLOYED:-}" > "$TEST_STRICT_MARKER"
echo "BODY"
`,
    'email-digest': `#!/usr/bin/env bash
cat >/dev/null
echo "sent to email"
`,
    'telegram-send': `#!/usr/bin/env bash
cat >/dev/null
`,
  });

  const result = runWrapper(vault, {
    ALFRED_STRICT_DEPLOYED: '0',
    TEST_STRICT_MARKER: strictMarker,
    DAILY_BRIEF_RETRY_ON_FAILURE: '0',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(strictMarker, 'utf8'), '0');
});

test('daily brief wrapper retries only the failed channel once', (t) => {
  const emailCount = path.join(os.tmpdir(), `alfred-email-count-${process.pid}-${Date.now()}`);
  const telegramCount = path.join(os.tmpdir(), `alfred-telegram-count-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(emailCount, { force: true });
    fs.rmSync(telegramCount, { force: true });
  });

  const { vault } = makeVault(t, {
    'daily-brief': dailyBriefScript(),
    'email-digest': `#!/usr/bin/env bash
set -euo pipefail
count=0
[ -f "$TEST_EMAIL_COUNT" ] && count="$(cat "$TEST_EMAIL_COUNT")"
count=$((count + 1))
echo "$count" > "$TEST_EMAIL_COUNT"
cat >/dev/null
if [ "$count" -eq 1 ]; then
  echo "temporary smtp dns failure" >&2
  exit 6
fi
echo "sent to user@example.com"
`,
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
count=0
[ -f "$TEST_TELEGRAM_COUNT" ] && count="$(cat "$TEST_TELEGRAM_COUNT")"
count=$((count + 1))
echo "$count" > "$TEST_TELEGRAM_COUNT"
cat >/dev/null
echo "sent to Telegram chat"
`,
  });

  const result = runWrapper(vault, {
    DAILY_BRIEF_RETRY_AFTER_SECONDS: '0',
    TEST_EMAIL_COUNT: emailCount,
    TEST_TELEGRAM_COUNT: telegramCount,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(emailCount, 'utf8').trim(), '2');
  assert.equal(fs.readFileSync(telegramCount, 'utf8').trim(), '1');
  const log = fs.readFileSync(path.join(vault, 'cache', 'daily-brief', 'send.log'), 'utf8');
  assert.match(log, /email send failed exit=6/);
  assert.match(log, /retrying failed channel\(s\) in 0s: email/);
  assert.match(log, /email send ok/);
  assert.match(log, /all configured channels delivered/);
});

test('daily brief wrapper falls back when subject computation fails', (t) => {
  const subjectFile = path.join(os.tmpdir(), `alfred-subject-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(subjectFile, { force: true }));

  const { vault } = makeVault(t, {
    'daily-brief': `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [ "$arg" = "--print-subject" ]; then
    echo "subject failed" >&2
    exit 9
  fi
done
echo "BODY"
`,
    'email-digest': `#!/usr/bin/env bash
set -euo pipefail
subject=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --subject) subject="$2"; shift 2 ;;
    --to) shift 2 ;;
    *) shift ;;
  esac
done
cat >/dev/null
echo "$subject" > "$TEST_SUBJECT_FILE"
echo "sent to user@example.com"
`,
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
echo "should not send telegram in this test" >&2
exit 7
`,
  });

  const result = runWrapper(vault, {
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    TEST_SUBJECT_FILE: subjectFile,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(subjectFile, 'utf8').trim(), /^Daily brief, \d{4}-\d{2}-\d{2}$/);
  const log = fs.readFileSync(path.join(vault, 'cache', 'daily-brief', 'send.log'), 'utf8');
  assert.match(log, /email send ok/);
  assert.match(log, /all configured channels delivered/);
});
