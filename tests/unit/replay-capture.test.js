// Unit tests for bin/lib/replay-capture.js — telegram-replay capture plumbing.
// WIKI_ROOT points lib/vault.js at a temp vault before require.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'replaycap-'));
process.env.WIKI_ROOT = TMP;

const {
  REPLAY_DIR,
  CURRENT_SPEC_VERSION,
  replayPathFor,
  replayMsgIdRequired,
  missingRequiredReplayMsgId,
  captureReplaySpec,
  captureReplayResult,
} =
  require('../../bin/lib/replay-capture.js');

test('REPLAY_DIR is under the vault raw/ tree', () => {
  assert.equal(REPLAY_DIR, path.join(TMP, 'raw', 'telegram-replay'));
});

test('replayPathFor: null msgId returns null; valid msgId returns a month path', () => {
  assert.equal(replayPathFor(null, 'spec.json'), null);
  const p = replayPathFor('msg-1', 'spec.json');
  assert.match(p, /raw\/telegram-replay\/\d{4}-\d{2}\/msg-1-spec\.json$/);
});

test('replayPathFor: sanitizes unsafe characters in msgId', () => {
  const p = replayPathFor('a/b:c d', 'result.json');
  assert.match(path.basename(p), /^a_b_c_d-result\.json$/);
});

test('captureReplaySpec: writes spec and stamps spec_version when missing', () => {
  captureReplaySpec('msg-2', JSON.stringify({ source: 'telegram:x', facts: ['a'] }));
  const p = replayPathFor('msg-2', 'spec.json');
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(obj.spec_version, CURRENT_SPEC_VERSION);
  assert.deepEqual(obj.facts, ['a']);
});

test('captureReplayResult: writes the result JSON', () => {
  captureReplayResult('msg-3', { ok: true, created: ['x'] });
  const p = replayPathFor('msg-3', 'result.json');
  const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.equal(obj.ok, true);
  assert.deepEqual(obj.created, ['x']);
});

test('replay msg_id guard: disabled by default, enabled by env', () => {
  const prior = process.env.WIKI_REQUIRE_REPLAY_MSG_ID;
  try {
    delete process.env.WIKI_REQUIRE_REPLAY_MSG_ID;
    assert.equal(replayMsgIdRequired(), false);
    assert.equal(missingRequiredReplayMsgId({ source: 'telegram:1' }), false);

    process.env.WIKI_REQUIRE_REPLAY_MSG_ID = '1';
    assert.equal(replayMsgIdRequired(), true);
    assert.equal(missingRequiredReplayMsgId({ source: 'telegram:1' }), true);
    assert.equal(missingRequiredReplayMsgId({ source: 'telegram:1', msg_id: 'telegram:42' }), false);
    assert.equal(missingRequiredReplayMsgId({ source: 'telegram:1' }, { replay: true }), false);
  } finally {
    if (prior == null) delete process.env.WIKI_REQUIRE_REPLAY_MSG_ID;
    else process.env.WIKI_REQUIRE_REPLAY_MSG_ID = prior;
  }
});
