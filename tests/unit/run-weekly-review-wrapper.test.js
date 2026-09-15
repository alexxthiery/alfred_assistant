'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRAPPER = path.join(REPO_ROOT, 'integrations', 'scheduling', 'run-weekly-review.sh');

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeVault(t, scripts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-weekly-wrapper-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const vault = path.join(tmp, 'vault');
  const bin = path.join(vault, '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# Alfred\n\nUse the weekly routine.\n');
  for (const [name, content] of Object.entries(scripts)) {
    writeExecutable(path.join(bin, name), content);
  }
  return { tmp, vault };
}

function writeEnv(vault, label = 'alfred') {
  const envFile = path.join(vault, '.alfred', 'private', 'env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${vault}`,
    `ALFRED_EXPECTED_LABEL=${label}`,
    'EMAIL_FROM=user@example.com',
    'GMAIL_APP_PASSWORD=smtp-password',
    'TZ=Asia/Singapore',
    '',
  ].join('\n'));
  return envFile;
}

function runWrapper(vault, agent, extraEnv = {}) {
  const envFile = writeEnv(vault, extraEnv.ALFRED_EXPECTED_LABEL || 'alfred');
  return spawnSync('bash', [WRAPPER], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALFRED_VAULT: vault,
      ALFRED_ASSISTANT_LABEL: extraEnv.ALFRED_ASSISTANT_LABEL || 'alfred',
      ENV_FILE: extraEnv.ENV_FILE || envFile,
      ALFRED_AGENT_BIN: agent,
      TZ: 'Asia/Singapore',
      ...extraEnv,
    },
  });
}

test('weekly review wrapper gives Claude only read-only weekly wiki permissions', (t) => {
  const allowedToolsFile = path.join(os.tmpdir(), `alfred-weekly-allowed-${process.pid}-${Date.now()}`);
  const emailBodyFile = path.join(os.tmpdir(), `alfred-weekly-email-${process.pid}-${Date.now()}`);
  const emailArgsFile = path.join(os.tmpdir(), `alfred-weekly-email-args-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(allowedToolsFile, { force: true });
    fs.rmSync(emailBodyFile, { force: true });
    fs.rmSync(emailArgsFile, { force: true });
  });

  const { tmp, vault } = makeVault(t, {
    'email-digest': `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$TEST_EMAIL_ARGS"
cat > "$TEST_EMAIL_BODY"
`,
  });
  const agent = path.join(tmp, 'claude');
  writeExecutable(agent, `#!/usr/bin/env bash
set -euo pipefail
prompt=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allowedTools|--allowed-tools)
      shift
      while [ "$#" -gt 0 ] && [ "$1" != "-p" ]; do
        printf '%s\\n' "$1" >> "$TEST_ALLOWED_TOOLS"
        shift
      done
      ;;
    -p)
      shift
      prompt="$1"
      shift
      ;;
    *)
      echo "unexpected argument: $1" >&2
      exit 7
      ;;
  esac
done
case "$prompt" in
  *"Weekly routine"*) ;;
  *) echo "missing weekly prompt" >&2; exit 8 ;;
esac
printf '%s\\n' "Weekly digest body"
`);

  const result = runWrapper(vault, agent, {
    TEST_ALLOWED_TOOLS: allowedToolsFile,
    TEST_EMAIL_ARGS: emailArgsFile,
    TEST_EMAIL_BODY: emailBodyFile,
  });

  assert.equal(result.status, 0, result.stderr);
  const allowed = fs.readFileSync(allowedToolsFile, 'utf8').trim().split('\n');
  assert.ok(allowed.includes('Bash(.bin/wiki agenda*)'));
  assert.ok(allowed.includes('Bash(.bin/wiki review*)'));
  assert.ok(allowed.includes('Bash(.bin/wiki audit*)'));
  assert.ok(allowed.includes(`Bash(${vault}/.bin/wiki audit*)`));
  assert.ok(!allowed.includes('Bash(.bin/wiki *)'), 'weekly review must not receive write-capable wiki access');
  assert.equal(fs.readFileSync(emailBodyFile, 'utf8'), 'Weekly digest body\n');
  assert.match(fs.readFileSync(emailArgsFile, 'utf8'), /--to\nuser@example\.com/);
});
