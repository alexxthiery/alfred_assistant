'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRAPPER = path.join(REPO_ROOT, 'integrations', 'scheduling', 'run-daily-checkin.sh');

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeVault(t, scripts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-checkin-wrapper-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const vault = path.join(tmp, 'vault');
  const bin = path.join(vault, '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# Tate\n\nYou are Tate.\n');
  for (const [name, content] of Object.entries(scripts)) {
    writeExecutable(path.join(bin, name), content);
  }
  return { tmp, vault };
}

function writeEnv(vault, label = 'tate') {
  const envFile = path.join(vault, '.alfred', 'private', 'env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${vault}`,
    `ALFRED_EXPECTED_LABEL=${label}`,
    'TZ=Asia/Singapore',
    'TELEGRAM_BOT_TOKEN=telegram-token',
    'TELEGRAM_CHAT_ID=12345',
    '',
  ].join('\n'));
  return envFile;
}

function runWrapper(vault, args, extraEnv = {}) {
  const envFile = writeEnv(vault, extraEnv.ALFRED_EXPECTED_LABEL || 'tate');
  return spawnSync('bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALFRED_VAULT: vault,
      ALFRED_ASSISTANT_LABEL: extraEnv.ALFRED_ASSISTANT_LABEL || 'tate',
      ENV_FILE: extraEnv.ENV_FILE || envFile,
      TZ: 'Asia/Singapore',
      ...extraEnv,
    },
  });
}

test('daily check-in wrapper sends agent output and records a ledger entry', (t) => {
  const sent = path.join(os.tmpdir(), `alfred-checkin-sent-${process.pid}-${Date.now()}`);
  const allowedToolsFile = path.join(os.tmpdir(), `alfred-checkin-allowed-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(sent, { force: true });
    fs.rmSync(allowedToolsFile, { force: true });
  });

  const { tmp, vault } = makeVault(t, {
    wiki: '#!/usr/bin/env bash\necho "recent context"\n',
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat > "$TEST_SENT_FILE"
echo sent
`,
  });
  const agent = path.join(tmp, 'claude');
  writeExecutable(agent, `#!/usr/bin/env bash
set -euo pipefail
prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allowedTools|--allowed-tools)
      shift
      while [ "$#" -gt 0 ] && [ "$1" != "-p" ]; do
        printf '%s\\n' "$1" >> "$TEST_ALLOWED_TOOLS"
        shift
      done
      ;;
    -p) prompt="$2"; shift 2 ;;
    *) echo "unexpected argument: $1" >&2; exit 7 ;;
  esac
done
case "$prompt" in
  *"Slot: morning"*|*"slot: morning"*) ;;
  *) echo "prompt did not contain slot" >&2; exit 9 ;;
esac
case "$prompt" in
  *"Do not write to the vault"*) ;;
  *) echo "prompt missing no-write rule" >&2; exit 9 ;;
esac
echo "Hi there! Big day or normal day today?"
`);

  const result = runWrapper(vault, ['--slot', 'morning'], {
    ALFRED_AGENT_BIN: agent,
    TEST_SENT_FILE: sent,
    TEST_ALLOWED_TOOLS: allowedToolsFile,
  });

  assert.equal(result.status, 0, result.stderr);
  const allowed = fs.readFileSync(allowedToolsFile, 'utf8').trim().split('\n');
  assert.ok(allowed.includes('Bash(.bin/wiki recent*)'));
  assert.ok(allowed.includes('Bash(.bin/wiki agenda*)'));
  assert.ok(allowed.includes('Bash(.bin/wiki day*)'));
  assert.ok(allowed.includes('Bash(.bin/wiki search*)'));
  assert.ok(allowed.includes(`Bash(${vault}/.bin/wiki search*)`));
  assert.ok(!allowed.includes('Bash(.bin/wiki *)'), 'check-ins must not receive write-capable wiki access');
  assert.equal(fs.readFileSync(sent, 'utf8'), 'Hi there! Big day or normal day today?\n');
  const ledger = fs.readFileSync(path.join(vault, 'cache', 'daily-checkin', 'checkins.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].slot, 'morning');
  assert.equal(ledger[0].message, 'Hi there! Big day or normal day today?');
});

test('daily check-in wrapper dry-run validates binding but does not require Telegram send', (t) => {
  const { tmp, vault } = makeVault(t, {
    wiki: '#!/usr/bin/env bash\necho ok\n',
    'telegram-send': '#!/usr/bin/env bash\nexit 9\n',
  });
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, '#!/usr/bin/env bash\nexit 9\n');

  const result = runWrapper(vault, ['--slot', 'afternoon', '--dry-run'], {
    ALFRED_AGENT_BIN: agent,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scheduled afternoon Telegram check-in/);
  assert.equal(fs.existsSync(path.join(vault, 'cache', 'daily-checkin', 'checkins.jsonl')), false);
});

test('daily check-in wrapper supports the evening slot', (t) => {
  const sent = path.join(os.tmpdir(), `alfred-checkin-evening-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(sent, { force: true }));

  const { tmp, vault } = makeVault(t, {
    wiki: '#!/usr/bin/env bash\necho "recent context"\n',
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat > "$TEST_SENT_FILE"
echo sent
`,
  });
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, `#!/usr/bin/env bash
set -euo pipefail
prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$prompt" in
  *"Slot: evening"*|*"slot: evening"*) ;;
  *) echo "prompt did not contain evening slot" >&2; exit 9 ;;
esac
echo "Anything from today worth remembering?"
`);

  const result = runWrapper(vault, ['--slot', 'evening'], {
    ALFRED_AGENT_BIN: agent,
    TEST_SENT_FILE: sent,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(sent, 'utf8'), 'Anything from today worth remembering?\n');
  const ledger = fs.readFileSync(path.join(vault, 'cache', 'daily-checkin', 'checkins.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].slot, 'evening');
});

test('daily check-in wrapper refuses invalid slots before sending', (t) => {
  const marker = path.join(os.tmpdir(), `alfred-checkin-invalid-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const { vault } = makeVault(t, {
    wiki: '#!/usr/bin/env bash\necho ok\n',
    'telegram-send': `#!/usr/bin/env bash\necho touched > "$TEST_MARKER"\n`,
  });

  const result = runWrapper(vault, ['--slot', 'night'], {
    ALFRED_AGENT_BIN: 'false',
    TEST_MARKER: marker,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--slot must be morning, afternoon, or evening/);
  assert.equal(fs.existsSync(marker), false);
});
