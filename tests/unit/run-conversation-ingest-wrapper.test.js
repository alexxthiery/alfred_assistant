'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WRAPPER = path.join(REPO_ROOT, 'integrations', 'scheduling', 'run-conversation-ingest.sh');

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

function makeVault(t, scripts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alfred-conversation-ingest-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const vault = path.join(tmp, 'vault');
  const bin = path.join(vault, '.bin');
  const persona = path.join(vault, 'persona');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(persona, { recursive: true });
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# Tate\n\nUse the vault pipeline.\n');
  fs.writeFileSync(path.join(persona, 'conversation-ingest.md'), '# Conversation Fact Ingestion\n\nNo over-interpretation.\n');

  for (const [name, content] of Object.entries(scripts)) {
    writeExecutable(path.join(bin, name), content);
  }
  return { tmp, vault };
}

function writeEnv(vault, label = 'tate', overrides = {}) {
  const envFile = path.join(vault, '.alfred', 'private', 'env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  const values = {
    ALFRED_EXPECTED_VAULT: vault,
    ALFRED_EXPECTED_LABEL: label,
    TZ: 'Asia/Singapore',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_CHAT_ID: '12345',
    ...overrides,
  };
  fs.writeFileSync(envFile, [
    `ALFRED_EXPECTED_VAULT=${values.ALFRED_EXPECTED_VAULT}`,
    `ALFRED_EXPECTED_LABEL=${values.ALFRED_EXPECTED_LABEL}`,
    `TZ=${values.TZ}`,
    `TELEGRAM_BOT_TOKEN=${values.TELEGRAM_BOT_TOKEN}`,
    `TELEGRAM_CHAT_ID=${values.TELEGRAM_CHAT_ID}`,
    '',
  ].join('\n'));
  return envFile;
}

function runWrapper(vault, args = [], extraEnv = {}) {
  const envFile = writeEnv(vault, extraEnv.ALFRED_EXPECTED_LABEL || 'tate', extraEnv);
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

function addConversationFile(vault, rel = 'nanoclaw/test-assistant/2026-09-15.md', body = 'The user said they like robotics club.\n') {
  const file = path.join(vault, '.alfred', 'private', 'conversations', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

test('conversation ingest wrapper runs the agent on recent private conversation files and sends questions', (t) => {
  const promptFile = path.join(os.tmpdir(), `alfred-conv-prompt-${process.pid}-${Date.now()}`);
  const wikiArgs = path.join(os.tmpdir(), `alfred-conv-wiki-${process.pid}-${Date.now()}`);
  const telegramFile = path.join(os.tmpdir(), `alfred-conv-telegram-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(wikiArgs, { force: true });
    fs.rmSync(telegramFile, { force: true });
  });

  const { tmp, vault } = makeVault(t, {
    wiki: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >> "$TEST_WIKI_ARGS"
`,
    'telegram-send': `#!/usr/bin/env bash
set -euo pipefail
cat > "$TEST_TELEGRAM"
`,
  });
  addConversationFile(vault);

  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "-p" ]
printf '%s' "$2" > "$TEST_PROMPT"
case "$2" in
  *"persona/conversation-ingest.md"*".bin/wiki ingest"*".bin/wiki patch"*) ;;
  *) echo "prompt missing pipeline policy" >&2; exit 8 ;;
esac
  "$PWD/.bin/wiki" patch user-profile --observation "[fact] The user likes robotics club ^[telegram:2026-09-15]"
printf '%s\\n' "Should I also remember who runs robotics club?"
`);

  const result = runWrapper(vault, [], {
    ALFRED_AGENT_BIN: agent,
    TEST_PROMPT: promptFile,
    TEST_WIKI_ARGS: wikiArgs,
    TEST_TELEGRAM: telegramFile,
  });

  assert.equal(result.status, 0, result.stderr);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /No over-interpretation|conservative ingestion pass/);
  assert.match(prompt, /Recent private conversation files/);
  assert.match(prompt, /\.alfred\/private\/conversations\/nanoclaw\/test-assistant\/2026-09-15\.md/);
  assert.match(fs.readFileSync(wikiArgs, 'utf8'), /patch\nuser-profile\n--observation/);
  assert.equal(fs.readFileSync(telegramFile, 'utf8'), 'Should I also remember who runs robotics club?\n');
  const ledger = fs.readFileSync(path.join(vault, 'cache', 'conversation-ingest', 'ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].recent_file_count, 1);
  assert.equal(ledger[0].telegram_sent, true);
});

test('conversation ingest wrapper is a no-op when there are no recent private conversation files', (t) => {
  const promptFile = path.join(os.tmpdir(), `alfred-conv-empty-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(promptFile, { force: true }));

  const { tmp, vault } = makeVault(t, {
    wiki: '#!/usr/bin/env bash\nexit 0\n',
    'telegram-send': '#!/usr/bin/env bash\nexit 9\n',
  });
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, `#!/usr/bin/env bash
printf '%s' "$2" > "$TEST_PROMPT"
exit 9
`);

  const result = runWrapper(vault, [], {
    ALFRED_AGENT_BIN: agent,
    TEST_PROMPT: promptFile,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(promptFile), false, 'agent should not run without recent private conversation evidence');
  assert.equal(fs.existsSync(path.join(vault, 'cache', 'conversation-ingest', 'ledger.jsonl')), false);
  const log = fs.readFileSync(path.join(vault, 'cache', 'conversation-ingest', 'run.log'), 'utf8');
  assert.match(log, /no recent private conversation files/);
});

test('conversation ingest wrapper can mirror an explicit source before reviewing', (t) => {
  const importArgs = path.join(os.tmpdir(), `alfred-conv-import-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(importArgs, { force: true }));

  const { tmp, vault } = makeVault(t, {
    wiki: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$TEST_IMPORT_ARGS"
if [ "$1" = "conversation-log" ]; then
	  mkdir -p .alfred/private/conversations/nanoclaw/test-assistant
	  printf '%s\\n' "The user said chess was fun." > .alfred/private/conversations/nanoclaw/test-assistant/imported.md
fi
`,
    'telegram-send': '#!/usr/bin/env bash\ncat >/dev/null\n',
  });
  const source = path.join(tmp, 'runtime-conversations');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'session.md'), 'The user said chess was fun.\n');
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, '#!/usr/bin/env bash\nexit 0\n');

  const result = runWrapper(vault, [], {
    ALFRED_AGENT_BIN: agent,
    ALFRED_CONVERSATION_SOURCE: source,
    TEST_IMPORT_ARGS: importArgs,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(importArgs, 'utf8'), /conversation-log\nimport\n--source/);
  assert.ok(fs.existsSync(path.join(vault, 'cache', 'conversation-ingest', 'ledger.jsonl')));
});

test('conversation ingest wrapper passes explicit mirror extensions', (t) => {
  const importArgs = path.join(os.tmpdir(), `alfred-conv-import-ext-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(importArgs, { force: true }));

  const { tmp, vault } = makeVault(t, {
    wiki: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$TEST_IMPORT_ARGS"
if [ "$1" = "conversation-log" ]; then
	  mkdir -p .alfred/private/conversations/nanoclaw/test-assistant
	  printf '%s\\n' '{"type":"user","message":"The user said chess was fun."}' > .alfred/private/conversations/nanoclaw/test-assistant/imported.jsonl
fi
`,
    'telegram-send': '#!/usr/bin/env bash\ncat >/dev/null\n',
  });
  const source = path.join(tmp, 'runtime-conversations');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'session.jsonl'), '{"type":"user","message":"The user said chess was fun."}\n');
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, '#!/usr/bin/env bash\nexit 0\n');

  const result = runWrapper(vault, [], {
    ALFRED_AGENT_BIN: agent,
    ALFRED_CONVERSATION_SOURCE: source,
    ALFRED_CONVERSATION_SOURCE_EXTENSIONS: 'jsonl',
    TEST_IMPORT_ARGS: importArgs,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(importArgs, 'utf8'), /--extensions\njsonl/);
  assert.ok(fs.existsSync(path.join(vault, 'cache', 'conversation-ingest', 'ledger.jsonl')));
});

test('conversation ingest wrapper reviews compact extracted deltas when configured', (t) => {
  const importArgs = path.join(os.tmpdir(), `alfred-conv-import-delta-${process.pid}-${Date.now()}`);
  const promptFile = path.join(os.tmpdir(), `alfred-conv-delta-prompt-${process.pid}-${Date.now()}`);
  t.after(() => {
    fs.rmSync(importArgs, { force: true });
    fs.rmSync(promptFile, { force: true });
  });

  const { tmp, vault } = makeVault(t, {
    wiki: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$TEST_IMPORT_ARGS"
if [ "$1" = "conversation-log" ]; then
	  mkdir -p .alfred/private/conversations/nanoclaw/test-assistant/deltas
	  printf '%s\\n' '{"kind":"conversation_message","role":"user","text":"The user said chess was fun."}' > .alfred/private/conversations/nanoclaw/test-assistant/deltas/2026-09-15.jsonl
	  printf '%s\\n' '{"type":"user","message":"raw should not be reviewed"}' > .alfred/private/conversations/nanoclaw/test-assistant/imported.jsonl
fi
`,
    'telegram-send': '#!/usr/bin/env bash\ncat >/dev/null\n',
  });
  const source = path.join(tmp, 'runtime-conversations');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'session.jsonl'), '{"type":"user","message":"The user said chess was fun."}\n');
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "-p" ]
printf '%s' "$2" > "$TEST_PROMPT"
exit 0
`);

  const result = runWrapper(vault, [], {
    ALFRED_AGENT_BIN: agent,
    ALFRED_CONVERSATION_SOURCE: source,
    ALFRED_CONVERSATION_SOURCE_EXTENSIONS: 'jsonl',
    ALFRED_CONVERSATION_EXCLUDE_DIRS: 'subagents',
    ALFRED_CONVERSATION_EXTRACT: 'claude-jsonl',
    ALFRED_CONVERSATION_EXTRACT_ONLY: '1',
    TEST_IMPORT_ARGS: importArgs,
    TEST_PROMPT: promptFile,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(importArgs, 'utf8'), /--extract\nclaude-jsonl/);
  assert.match(fs.readFileSync(importArgs, 'utf8'), /--extract-only/);
  assert.match(fs.readFileSync(importArgs, 'utf8'), /--exclude-dir\nsubagents/);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /\.alfred\/private\/conversations\/nanoclaw\/test-assistant\/deltas\/2026-09-15\.jsonl/);
  assert.doesNotMatch(prompt, /imported\.jsonl/);
});

test('conversation ingest wrapper fails before agent when env binding points elsewhere', (t) => {
  const promptFile = path.join(os.tmpdir(), `alfred-conv-binding-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(promptFile, { force: true }));

  const { tmp, vault } = makeVault(t, {
    wiki: '#!/usr/bin/env bash\nexit 0\n',
    'telegram-send': '#!/usr/bin/env bash\ncat >/dev/null\n',
  });
  addConversationFile(vault);
  const other = path.join(tmp, 'other-vault');
  fs.mkdirSync(other);
  const agent = path.join(tmp, 'agent');
  writeExecutable(agent, `#!/usr/bin/env bash
printf '%s' "$2" > "$TEST_PROMPT"
exit 9
`);

  const result = runWrapper(vault, [], {
    ALFRED_AGENT_BIN: agent,
    ALFRED_EXPECTED_VAULT: other,
    TEST_PROMPT: promptFile,
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /vault binding mismatch/);
  assert.equal(fs.existsSync(promptFile), false, 'agent should not run after binding failure');
});
