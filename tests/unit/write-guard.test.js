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

test('denies a Bash wiki patch with unescaped dollar amount inside double quotes', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'wiki patch foo --observation "[fact] Budget ~$400M"' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /observation-stdin/);
});

test('allows a Bash wiki patch with escaped dollar amount inside double quotes', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'wiki patch foo --observation "[fact] Budget ~\\$400M"' } });
  assert.equal(r.status, 0);
});

test('allows a Bash wiki patch with dollar amount inside single quotes', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: "wiki patch foo --observation '[fact] Budget ~$400M'" } });
  assert.equal(r.status, 0);
});

test('allows a Bash wiki patch using --observation-stdin with a single-quoted heredoc', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: "wiki patch foo --observation-stdin <<'EOF'\n[fact] Budget ~$400M\nEOF" } });
  assert.equal(r.status, 0);
});

test('denies a Bash wiki predict with unescaped dollar amount in the quoted body arg', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'wiki predict foo "Budget ~$400M" --by 2027-06' } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--stdin\/--file/);
});

test('allows a Bash read of a wiki page (cat, no write)', () => {
  const r = run({ tool_name: 'Bash', tool_input: { command: 'cat /v/wiki/foo.md' } });
  assert.equal(r.status, 0);
});

test('does not block on malformed input', () => {
  const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf-8' });
  assert.equal(r.status, 0);
});
