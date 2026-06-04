// Integration regression for WIKI_REQUIRE_REPLAY_MSG_ID.
//
// Drives the real `wiki ingest --stdin` command against a temp vault. The guard
// must abort before writing when a Telegram-driven ingest lacks msg_id, while a
// valid msg_id should both write the card and capture replay artifacts.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WIKI = path.join(REPO, 'bin', 'wiki');
const TEMPLATE = path.join(REPO, 'tests', 'vault');

function cpDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) cpDir(s, d); else fs.copyFileSync(s, d);
  }
}

function freshVault() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-replay-guard-'));
  cpDir(TEMPLATE, tmp);
  return tmp;
}

function ingest(cwd, spec) {
  return spawnSync('node', [WIKI, 'ingest', '--stdin'], {
    cwd,
    input: JSON.stringify(spec),
    encoding: 'utf-8',
    env: {
      ...process.env,
      WIKI_ROOT: cwd,
      WIKI_NO_AUTO_COMMIT: '1',
      WIKI_REQUIRE_REPLAY_MSG_ID: '1',
      ALFRED_NO_RTK: '1',
    },
  });
}

function findFiles(root, predicate, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) findFiles(p, predicate, out);
    else if (predicate(p)) out.push(p);
  }
  return out;
}

function replaySpec(msgId) {
  return {
    source: 'telegram:2026-06-03',
    msg_id: msgId,
    entities: [
      {
        slug: 'replay-guard-person',
        title: 'Replay Guard Person',
        type: 'entity',
        tags: ['person'],
        facts: [
          { body: 'Replay guard test fact one.' },
          { body: 'Replay guard test fact two.' },
        ],
      },
    ],
  };
}

test('ingest requires top-level msg_id when replay capture is mandatory', () => {
  const v = freshVault();
  try {
    const spec = replaySpec('telegram:123');
    delete spec.msg_id;

    const r = ingest(v, spec);
    assert.equal(r.status, 2, `missing msg_id should be a usage failure: ${r.stderr}`);
    assert.match(r.stderr, /top-level "msg_id" is required/);
    assert.equal(fs.existsSync(path.join(v, 'wiki', 'replay-guard-person.md')), false);
    assert.equal(fs.existsSync(path.join(v, 'raw', 'telegram-replay')), false);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('ingest with msg_id writes the page and captures replay artifacts', () => {
  const v = freshVault();
  try {
    const r = ingest(v, replaySpec('telegram:123'));
    assert.equal(r.status, 0, `ingest should succeed: stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.equal(fs.existsSync(path.join(v, 'wiki', 'replay-guard-person.md')), true);

    const replayRoot = path.join(v, 'raw', 'telegram-replay');
    const specFiles = findFiles(replayRoot, (p) => path.basename(p) === 'telegram_123-spec.json');
    const resultFiles = findFiles(replayRoot, (p) => path.basename(p) === 'telegram_123-result.json');
    assert.equal(specFiles.length, 1);
    assert.equal(resultFiles.length, 1);

    const capturedSpec = JSON.parse(fs.readFileSync(specFiles[0], 'utf-8'));
    const capturedResult = JSON.parse(fs.readFileSync(resultFiles[0], 'utf-8'));
    assert.equal(capturedSpec.msg_id, 'telegram:123');
    assert.equal(capturedResult.exitCode, 0);
    assert.deepEqual(capturedResult.created, ['replay-guard-person']);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});
