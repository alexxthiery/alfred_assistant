// Unit test for the Claude Code PreToolUse write-guard hook
// (integrations/claude-code/wiki-write-guard.js). Feeds it PreToolUse event
// JSON on stdin and asserts deny (exit 2) on raw wiki/*.md writes, allow
// (exit 0) otherwise.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', '..', 'integrations', 'claude-code', 'wiki-write-guard.js');

function run(event) {
  return spawnSync('node', [HOOK], { input: JSON.stringify(event), encoding: 'utf-8' });
}

test('denies Write to a wiki page', () => {
  const r = run({ tool_name: 'Write', tool_input: { file_path: '/v/wiki/foo.md' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});

test('denies Edit to a wiki page', () => {
  const r = run({ tool_name: 'Edit', tool_input: { file_path: '/v/wiki/bar.md' } });
  assert.equal(r.status, 2);
});

test('allows Write to inbox/', () => {
  const r = run({ tool_name: 'Write', tool_input: { file_path: '/v/inbox/note.md' } });
  assert.equal(r.status, 0);
});

test('allows Write to alfred/scratchpad.md', () => {
  const r = run({ tool_name: 'Write', tool_input: { file_path: '/v/alfred/scratchpad.md' } });
  assert.equal(r.status, 0);
});

test('denies a Bash redirect into a wiki page', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'echo x >> /v/wiki/foo.md' } });
  assert.equal(r.status, 2);
});

test('denies a Bash sed -i into a wiki page', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' /v/wiki/foo.md" } });
  assert.equal(r.status, 2);
});

test('allows a Bash `wiki patch` (no redirect)', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'wiki patch foo --observation bar' } });
  assert.equal(r.status, 0);
});

test('allows a Bash read of a wiki page (cat, no write)', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'cat /v/wiki/foo.md' } });
  assert.equal(r.status, 0);
});

test('does not block on malformed input', () => {
  const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf-8' });
  assert.equal(r.status, 0);
});
