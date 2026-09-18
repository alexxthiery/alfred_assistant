'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  checkRuntime,
  validateDestinations,
  validateGroupConfig,
  validateMountAllowlist,
} = require('../../bin/lib/nanoclaw-runtime-check.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'check-nanoclaw-assistant-runtime.js');
const NODE = process.execPath;

const GROUP_ID = 'group-1';
const MESSAGE_GROUP_ID = 'mg-1';

function makeRuntime(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-runtime-check-'));
  const runtime = path.join(root, 'runtime');
  const vault = path.join(root, 'vault');
  const otherVault = path.join(root, 'other-vault');
  fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'data'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'home', '.config', 'nanoclaw'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'groups'), { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(otherVault, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), '{"name":"nanoclaw"}\n');
  fs.writeFileSync(path.join(runtime, '.env'), 'TELEGRAM_BOT_TOKEN=redacted\n');
  fs.writeFileSync(path.join(runtime, 'data', 'v2.db'), '');
  fs.writeFileSync(path.join(runtime, 'data', 'upgrade-state.json'), JSON.stringify({
    version: '2.3.0',
    commit: overrides.upgradeCommit || 'good-commit',
    tree: 'tree',
    updatedAt: '2026-09-18T00:00:00.000Z',
    via: 'test',
  }, null, 2));
  fs.writeFileSync(path.join(runtime, 'home', '.config', 'nanoclaw', 'mount-allowlist.json'), JSON.stringify({
    allowedRoots: overrides.allowedRoots || [{ path: vault, allowReadWrite: true }],
    blockedPatterns: [],
  }, null, 2));
  fs.writeFileSync(path.join(runtime, 'bin', 'ncl'), '#!/bin/sh\nexit 99\n');
  fs.chmodSync(path.join(runtime, 'bin', 'ncl'), 0o755);
  return { root, runtime, vault, otherVault };
}

function ok(data) {
  return JSON.stringify({ id: 'req', ok: true, data });
}

function fakeRunFactory({ group, config, destinations, sessions, launchd = '' }) {
  return (cmd, args) => {
    if (cmd === 'launchctl') return launchd;
    const key = args.join(' ');
    if (key.startsWith('groups get ')) return ok(group);
    if (key.startsWith('groups config get ')) return ok(config);
    if (key.startsWith('destinations list ')) return ok(destinations);
    if (key.startsWith('sessions list ')) return ok(sessions);
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

function baseNcl(vault) {
  return {
    group: { id: GROUP_ID, name: 'Assistant', folder: 'dm' },
    config: {
      agent_group_id: GROUP_ID,
      assistant_name: 'Assistant',
      image_tag: `nanoclaw-agent:test-${GROUP_ID}`,
      packages_apt: ['python3', 'duckdb'],
      packages_npm: [],
      additional_mounts: [{ hostPath: vault, containerPath: 'vault', readonly: false }],
    },
    destinations: [{
      agent_group_id: GROUP_ID,
      local_name: 'telegram-dm',
      target_type: 'channel',
      target_id: MESSAGE_GROUP_ID,
      channel_type: 'telegram',
      display_name: 'Telegram DM',
    }],
    sessions: [{ id: 'sess-1', agent_group_id: GROUP_ID, status: 'active', container_status: 'stopped' }],
    launchd: `123\t0\tcom.nanoclaw-assistant-v23\n`,
  };
}

function runCheck(fixture, nclOverrides = {}, argOverrides = {}) {
  const ncl = { ...baseNcl(fixture.vault), ...nclOverrides };
  return checkRuntime({
    runtime: fixture.runtime,
    vault: fixture.vault,
    groupId: GROUP_ID,
    assistantName: 'Assistant',
    launchdLabel: 'com.nanoclaw-assistant-v23',
    destinationName: 'telegram-dm',
    otherVaults: [fixture.otherVault],
    requireDuckdb: true,
    requireTelegramDestination: true,
    expectedUpgradeCommit: 'good-commit',
    ...argOverrides,
  }, { runCommand: fakeRunFactory(ncl) });
}

test('passes for a single-vault assistant runtime with DuckDB and Telegram destination', () => {
  const fixture = makeRuntime();
  const result = runCheck(fixture);
  assert.equal(result.ok, true, result.issues.join('\n'));
});

test('detects missing companion destination row', () => {
  const fixture = makeRuntime();
  const result = runCheck(fixture, { destinations: [] });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /missing destination 'telegram-dm'/);
});

test('detects stale assistant identity in group and container config', () => {
  const fixture = makeRuntime();
  const ncl = baseNcl(fixture.vault);
  ncl.group = { ...ncl.group, name: 'PreviousName' };
  ncl.config = { ...ncl.config, assistant_name: 'PreviousName' };
  const result = runCheck(fixture, ncl);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /group name is 'PreviousName'/);
  assert.match(result.issues.join('\n'), /assistant_name is 'PreviousName'/);
});

test('detects missing DuckDB package when search quality depends on it', () => {
  const fixture = makeRuntime();
  const ncl = baseNcl(fixture.vault);
  ncl.config = { ...ncl.config, packages_apt: ['python3'] };
  const result = runCheck(fixture, ncl);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /missing duckdb/);
});

test('detects sibling vaults in the mount allowlist', () => {
  const fixture = makeRuntime({ allowedRoots: [
    { path: path.join(os.tmpdir(), 'placeholder'), allowReadWrite: true },
  ] });
  const allowlist = {
    allowedRoots: [
      { path: fixture.vault, allowReadWrite: true },
      { path: fixture.otherVault, allowReadWrite: false },
    ],
  };
  const issues = validateMountAllowlist(allowlist, { vault: fixture.vault, otherVaults: [fixture.otherVault] });
  assert.match(issues.join('\n'), /exactly one allowed root/);
  assert.match(issues.join('\n'), /sibling vault/);
});

test('detects unsafe extra host mounts in group config', () => {
  const fixture = makeRuntime();
  const issues = validateGroupConfig({
    agent_group_id: GROUP_ID,
    assistant_name: 'Assistant',
    image_tag: `image:${GROUP_ID}`,
    packages_apt: ['duckdb'],
    additional_mounts: [
      { hostPath: fixture.vault, containerPath: 'vault', readonly: false },
      { hostPath: fixture.otherVault, containerPath: 'other', readonly: true },
    ],
  }, { groupId: GROUP_ID, vault: fixture.vault, assistantName: 'Assistant', requireDuckdb: true });
  assert.match(issues.join('\n'), /non-active vault\/host mount/);
});

test('accepts tilde-expanded active vault mounts from NanoClaw config', () => {
  const issues = validateGroupConfig({
    agent_group_id: GROUP_ID,
    assistant_name: 'Assistant',
    image_tag: `image:${GROUP_ID}`,
    packages_apt: ['duckdb'],
    additional_mounts: [
      { hostPath: '~', containerPath: 'vault', readonly: false },
    ],
  }, { groupId: GROUP_ID, vault: fs.realpathSync(os.homedir()), assistantName: 'Assistant', requireDuckdb: true });
  assert.deepEqual(issues, []);
});

test('detects unloaded launchd label', () => {
  const fixture = makeRuntime();
  const result = runCheck(fixture, { launchd: '123\t0\tcom.other\n' });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /launchd label not loaded/);
});

test('detects upgrade marker drift from vetted staging commit', () => {
  const fixture = makeRuntime({ upgradeCommit: 'old-commit' });
  const result = runCheck(fixture);
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /upgrade state commit is old-commit/);
});

test('destination validation can require any Telegram destination when no name is configured', () => {
  const issues = validateDestinations([{
    agent_group_id: GROUP_ID,
    local_name: 'main',
    target_type: 'channel',
    channel_type: 'telegram',
  }], { groupId: GROUP_ID, requireTelegramDestination: true });
  assert.deepEqual(issues, []);
});

test('CLI reports failures without printing secrets from runtime .env', () => {
  const fixture = makeRuntime();
  const fakeNcl = path.join(fixture.runtime, 'bin', 'ncl-fake');
  fs.writeFileSync(fakeNcl, `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
function out(data) { console.log(JSON.stringify({ id: 'x', ok: true, data })); }
if (args.startsWith('groups get')) out({ id: '${GROUP_ID}', name: 'PreviousName', folder: 'dm' });
else if (args.startsWith('groups config get')) out({ agent_group_id: '${GROUP_ID}', assistant_name: 'PreviousName', image_tag: 'image-${GROUP_ID}', packages_apt: ['python3'], additional_mounts: [{ hostPath: ${JSON.stringify(fixture.vault)}, containerPath: 'vault', readonly: false }] });
else if (args.startsWith('destinations list')) out([]);
else if (args.startsWith('sessions list')) out([{ id: 'sess-1', agent_group_id: '${GROUP_ID}', status: 'active' }]);
else process.exit(2);
`);
  fs.chmodSync(fakeNcl, 0o755);
  const r = spawnSync(NODE, [
    TOOL,
    '--runtime', fixture.runtime,
    '--vault', fixture.vault,
    '--group-id', GROUP_ID,
    '--assistant-name', 'Assistant',
    '--destination', 'telegram-dm',
    '--require-duckdb',
    '--skip-launchd',
    '--ncl', fakeNcl,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NanoClaw assistant runtime check failed/);
  assert.doesNotMatch(r.stdout + r.stderr, /redacted/);
});
