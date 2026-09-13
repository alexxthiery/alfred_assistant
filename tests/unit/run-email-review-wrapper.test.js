'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRAPPER = path.join(REPO_ROOT, 'integrations', 'scheduling', 'run-email-review.sh');

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeVault(t, scripts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-email-review-wrapper-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const vault = path.join(tmp, 'vault');
  const bin = path.join(vault, '.bin');
  const persona = path.join(vault, 'persona');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(persona, { recursive: true });
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), 'fake agent persona\n');
  fs.writeFileSync(path.join(persona, 'email-review.md'), 'fake email review policy\n');

  for (const [name, content] of Object.entries(scripts)) {
    writeExecutable(path.join(bin, name), content);
  }
  return { tmp, vault };
}

function makeAgent(t, body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-email-agent-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, body);
  return agent;
}

function runWrapper(vault, agent, extraEnv = {}) {
  const envFile = path.join(vault, '.alfred', 'private', 'env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  const fileEnv = {
    ALFRED_EXPECTED_VAULT: vault,
    ALFRED_EXPECTED_LABEL: 'child',
    EMAIL_FROM: 'user@example.com',
    GMAIL_IMAP_APP_PASSWORD: 'imap-password',
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
    `GMAIL_IMAP_APP_PASSWORD=${fileEnv.GMAIL_IMAP_APP_PASSWORD}`,
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
      ALFRED_AGENT_BIN: agent,
      ...extraEnv,
    },
  });
}

test('email review wrapper scans Gmail before invoking the headless agent', (t) => {
  const emailArgs = path.join(os.tmpdir(), `alfred-email-args-${process.pid}-${Date.now()}`);
  const promptFile = path.join(os.tmpdir(), `alfred-email-prompt-${process.pid}-${Date.now()}`);
  const telegramFile = path.join(os.tmpdir(), `alfred-email-telegram-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(emailArgs, { force: true });
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(telegramFile, { force: true });
  });

  const { vault } = makeVault(t, {
    'email-review': `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$TEST_EMAIL_ARGS"
cat <<'REPORT'
# Email Review - last 1 day

Reviewed: 3 messages; skipped already-reviewed: 0; surfaced: 1; questions: 1.

## 1. Action item
- Category: todo candidate
- Provenance: gmail:uid=123 date=2026-09-10 from=sender@example.com subject="Thing"
REPORT
`,
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat > "$TEST_TELEGRAM"
`,
  });
  const agent = makeAgent(t, `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "-p" ]
printf '%s' "$2" > "$TEST_PROMPT"
printf '%s\\n' "Please confirm whether I should create the Thing todo."
`);

  const result = runWrapper(vault, agent, {
    TEST_EMAIL_ARGS: emailArgs,
    TEST_PROMPT: promptFile,
    TEST_TELEGRAM: telegramFile,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(emailArgs, 'utf8'),
    '--days\n1\n--max-questions\n7\n--record-ledger\n',
  );
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /EMAIL REVIEW REPORT/);
  assert.match(prompt, /Action item/);
  assert.match(prompt, /Do NOT run \.bin\/email-review, \.bin\/gmail/);
  assert.equal(
    fs.readFileSync(telegramFile, 'utf8'),
    'Please confirm whether I should create the Thing todo.\n',
  );
});

test('email review wrapper fails before Gmail scan when env binding points elsewhere', (t) => {
  const emailArgs = path.join(os.tmpdir(), `alfred-email-binding-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(emailArgs, { force: true }));

  const { tmp, vault } = makeVault(t, {
    'email-review': `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$TEST_EMAIL_ARGS"
`,
    'telegram-send': `#!/usr/bin/env bash
cat >/dev/null
`,
  });
  const other = path.join(tmp, 'other-vault');
  fs.mkdirSync(other);
  const agent = makeAgent(t, `#!/usr/bin/env bash
exit 9
`);

  const result = runWrapper(vault, agent, {
    ALFRED_EXPECTED_VAULT: other,
    TEST_EMAIL_ARGS: emailArgs,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /vault binding mismatch/);
  assert.equal(fs.existsSync(emailArgs), false, 'Gmail scanner should not run after binding failure');
});

test('email review wrapper stays silent when the report has no surfaced candidates', (t) => {
  const promptFile = path.join(os.tmpdir(), `alfred-empty-prompt-${process.pid}-${Date.now()}`);
  const telegramFile = path.join(os.tmpdir(), `alfred-empty-telegram-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(telegramFile, { force: true });
  });

  const { vault } = makeVault(t, {
    'email-review': `#!/usr/bin/env bash
set -euo pipefail
cat <<'REPORT'
# Email Review - last 1 day

Reviewed: 51 messages; skipped already-reviewed: 36; surfaced: 0; questions: 0.

No action-worthy or vault-worthy email candidates found.
REPORT
`,
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat > "$TEST_TELEGRAM"
`,
  });
  const agent = makeAgent(t, `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$2" > "$TEST_PROMPT"
exit 9
`);

  const result = runWrapper(vault, agent, {
    TEST_PROMPT: promptFile,
    TEST_TELEGRAM: telegramFile,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(promptFile), false, 'agent should not run for empty report');
  assert.equal(fs.existsSync(telegramFile), false, 'telegram should not run for empty report');
  const log = fs.readFileSync(path.join(vault, 'cache', 'email-review', 'run.log'), 'utf8');
  assert.match(log, /completed: no surfaced email-review candidates/);
});

test('email review wrapper logs and preserves scanner failures', (t) => {
  const promptFile = path.join(os.tmpdir(), `alfred-fail-prompt-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(promptFile, { force: true }));

  const { vault } = makeVault(t, {
    'email-review': `#!/usr/bin/env bash
set -euo pipefail
echo "imap unavailable" >&2
exit 6
`,
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
`,
  });
  const agent = makeAgent(t, `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "$2" > "$TEST_PROMPT"
exit 9
`);

  const result = runWrapper(vault, agent, {
    TEST_PROMPT: promptFile,
  });

  assert.equal(result.status, 6);
  assert.equal(fs.existsSync(promptFile), false, 'agent should not run after scanner failure');
  const log = fs.readFileSync(path.join(vault, 'cache', 'email-review', 'run.log'), 'utf8');
  assert.match(log, /email-review failed exit=6/);
  const scannerStderr = fs.readFileSync(path.join(vault, 'cache', 'email-review', 'email-review.stderr'), 'utf8');
  assert.match(scannerStderr, /imap unavailable/);
});
