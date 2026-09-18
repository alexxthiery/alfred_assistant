'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function real(p) {
  return fs.realpathSync(path.resolve(expandHome(p)));
}

function realOrNull(p) {
  try {
    return real(p);
  } catch {
    return null;
  }
}

function unwrapNclJson(raw, commandText) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${commandText} did not emit JSON`);
  }
  if (!parsed || parsed.ok !== true) {
    const msg = parsed && parsed.error ? `: ${parsed.error}` : '';
    throw new Error(`${commandText} returned ok=false${msg}`);
  }
  return parsed.data;
}

function validateRuntimeSurface({ runtime, vault }) {
  const issues = [];
  const requiredFiles = [
    ['package.json', 'NanoClaw package.json'],
    [path.join('bin', 'ncl'), 'ncl CLI'],
    [path.join('data', 'v2.db'), 'central DB'],
    [path.join('home', '.config', 'nanoclaw', 'mount-allowlist.json'), 'mount allowlist'],
  ];
  for (const [rel, label] of requiredFiles) {
    const file = path.join(runtime, rel);
    if (!fs.existsSync(file)) issues.push(`missing ${label}: ${file}`);
  }
  for (const dir of ['data', 'home', 'groups']) {
    const p = path.join(runtime, dir);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) issues.push(`missing runtime state dir: ${p}`);
  }
  const envFile = path.join(runtime, '.env');
  if (!fs.existsSync(envFile)) {
    issues.push(`missing runtime .env: ${envFile}`);
  } else if (fs.lstatSync(envFile).isSymbolicLink()) {
    issues.push(`runtime .env must not be a symlink: ${envFile}`);
  }
  if (!fs.existsSync(vault) || !fs.statSync(vault).isDirectory()) issues.push(`missing vault: ${vault}`);
  return issues;
}

function validateMountAllowlist(allowlist, { vault, otherVaults = [] }) {
  const issues = [];
  const allowed = Array.isArray(allowlist.allowedRoots) ? allowlist.allowedRoots : [];
  if (allowed.length !== 1) {
    issues.push(`mount allowlist must contain exactly one allowed root, found ${allowed.length}`);
  }
  for (const [idx, root] of allowed.entries()) {
    const rootPath = root && root.path ? realOrNull(root.path) : null;
    if (!rootPath) {
      issues.push(`mount allowlist root ${idx} is missing or unresolved`);
      continue;
    }
    if (rootPath !== vault) {
      issues.push(`mount allowlist root ${idx} is ${rootPath}, expected ${vault}`);
    }
    if (root.allowReadWrite !== true) {
      issues.push(`mount allowlist root ${idx} must be read-write for the active vault`);
    }
  }
  for (const other of otherVaults) {
    const otherReal = realOrNull(other);
    if (!otherReal) continue;
    if (allowed.some((root) => realOrNull(root.path || '') === otherReal)) {
      issues.push(`mount allowlist includes sibling vault: ${otherReal}`);
    }
  }
  return issues;
}

function validateGroup(group, { groupId, assistantName }) {
  const issues = [];
  if (!group || group.id !== groupId) issues.push(`group id mismatch: expected ${groupId}, got ${group && group.id}`);
  if (assistantName && group && group.name !== assistantName) {
    issues.push(`group name is '${group.name}', expected '${assistantName}'`);
  }
  return issues;
}

function validateGroupConfig(config, { groupId, vault, assistantName, requireDuckdb }) {
  const issues = [];
  if (!config || config.agent_group_id !== groupId) {
    issues.push(`group config id mismatch: expected ${groupId}, got ${config && config.agent_group_id}`);
    return issues;
  }
  if (assistantName && config.assistant_name !== assistantName) {
    issues.push(`assistant_name is '${config.assistant_name}', expected '${assistantName}'`);
  }
  const mounts = Array.isArray(config.additional_mounts) ? config.additional_mounts : [];
  const activeMounts = mounts.filter((m) => realOrNull(m.hostPath || '') === vault);
  if (activeMounts.length !== 1) {
    issues.push(`group config must mount active vault exactly once, found ${activeMounts.length}`);
  } else {
    const mount = activeMounts[0];
    if (mount.containerPath !== 'vault') issues.push(`active vault mount containerPath is '${mount.containerPath}', expected 'vault'`);
    if (mount.readonly !== false) issues.push('active vault mount must be read-write');
  }
  const foreignMounts = mounts.filter((m) => realOrNull(m.hostPath || '') && realOrNull(m.hostPath || '') !== vault);
  if (foreignMounts.length) {
    issues.push(`group config contains non-active vault/host mount(s): ${foreignMounts.map((m) => m.hostPath).join(', ')}`);
  }
  const apt = Array.isArray(config.packages_apt) ? config.packages_apt : [];
  if (requireDuckdb && !apt.includes('duckdb')) issues.push('packages_apt is missing duckdb');
  if (!config.image_tag || !String(config.image_tag).includes(groupId)) {
    issues.push(`image_tag does not identify this group: ${config.image_tag || '(missing)'}`);
  }
  return issues;
}

function validateDestinations(destinations, { groupId, destinationName, requireTelegramDestination }) {
  const issues = [];
  const rows = Array.isArray(destinations) ? destinations : [];
  const own = rows.filter((d) => d.agent_group_id === groupId);
  if (!own.length) issues.push(`no destinations for group ${groupId}`);
  if (destinationName) {
    const d = own.find((row) => row.local_name === destinationName);
    if (!d) {
      issues.push(`missing destination '${destinationName}' for group ${groupId}`);
    } else {
      if (d.target_type !== 'channel') issues.push(`destination '${destinationName}' target_type is '${d.target_type}', expected channel`);
      if (requireTelegramDestination && d.channel_type !== 'telegram') {
        issues.push(`destination '${destinationName}' channel_type is '${d.channel_type}', expected telegram`);
      }
    }
  } else if (requireTelegramDestination && !own.some((d) => d.target_type === 'channel' && d.channel_type === 'telegram')) {
    issues.push(`no Telegram channel destination for group ${groupId}`);
  }
  return issues;
}

function validateSessions(sessions, { groupId }) {
  const issues = [];
  const rows = Array.isArray(sessions) ? sessions : [];
  const own = rows.filter((s) => s.agent_group_id === groupId);
  if (!own.length) issues.push(`no sessions for group ${groupId}`);
  const bad = own.filter((s) => s.status && !['active', 'idle'].includes(s.status));
  if (bad.length) issues.push(`session(s) have unexpected status: ${bad.map((s) => `${s.id}:${s.status}`).join(', ')}`);
  return issues;
}

function validateUpgradeState(state, { expectedCommit }) {
  const issues = [];
  if (!state || typeof state !== 'object') return ['missing or invalid upgrade-state.json'];
  if (!state.version) issues.push('upgrade state missing version');
  if (!state.commit) issues.push('upgrade state missing commit');
  if (expectedCommit && state.commit !== expectedCommit) {
    issues.push(`upgrade state commit is ${state.commit}, expected ${expectedCommit}`);
  }
  return issues;
}

function validateLaunchdList(output, label) {
  if (!label) return [];
  const found = String(output || '')
    .split(/\r?\n/)
    .some((line) => line.trim().endsWith(label) || line.includes(`\t${label}`));
  return found ? [] : [`launchd label not loaded: ${label}`];
}

function runCommand(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed exit=${r.status}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function checkRuntime(args, deps = {}) {
  const run = deps.runCommand || runCommand;
  const runtime = real(args.runtime);
  const vault = real(args.vault);
  const ncl = args.ncl ? real(args.ncl) : path.join(runtime, 'bin', 'ncl');
  const issues = [];
  const checks = [];
  const add = (name, moreIssues) => {
    const list = moreIssues.filter(Boolean);
    checks.push({ name, ok: list.length === 0, issues: list });
    issues.push(...list);
  };

  add('runtime surface', validateRuntimeSurface({ runtime, vault }));

  const allowlistPath = path.join(runtime, 'home', '.config', 'nanoclaw', 'mount-allowlist.json');
  if (fs.existsSync(allowlistPath)) {
    add('mount allowlist', validateMountAllowlist(JSON.parse(fs.readFileSync(allowlistPath, 'utf8')), {
      vault,
      otherVaults: args.otherVaults || [],
    }));
  }

  const upgradePath = path.join(runtime, 'data', 'upgrade-state.json');
  if (fs.existsSync(upgradePath)) {
    add('upgrade marker', validateUpgradeState(JSON.parse(fs.readFileSync(upgradePath, 'utf8')), {
      expectedCommit: args.expectedUpgradeCommit,
    }));
  } else {
    add('upgrade marker', ['missing upgrade-state.json']);
  }

  const group = unwrapNclJson(run(ncl, ['groups', 'get', '--id', args.groupId, '--json'], { cwd: runtime }), 'ncl groups get');
  add('group identity', validateGroup(group, { groupId: args.groupId, assistantName: args.assistantName }));

  const config = unwrapNclJson(
    run(ncl, ['groups', 'config', 'get', '--id', args.groupId, '--json'], { cwd: runtime }),
    'ncl groups config get',
  );
  add('group config', validateGroupConfig(config, {
    groupId: args.groupId,
    vault,
    assistantName: args.assistantName,
    requireDuckdb: args.requireDuckdb,
  }));

  const destinations = unwrapNclJson(
    run(ncl, ['destinations', 'list', '--id', args.groupId, '--json'], { cwd: runtime }),
    'ncl destinations list',
  );
  add('destinations', validateDestinations(destinations, {
    groupId: args.groupId,
    destinationName: args.destinationName,
    requireTelegramDestination: args.requireTelegramDestination,
  }));

  const sessions = unwrapNclJson(
    run(ncl, ['sessions', 'list', '--id', args.groupId, '--json'], { cwd: runtime }),
    'ncl sessions list',
  );
  add('sessions', validateSessions(sessions, { groupId: args.groupId }));

  if (args.launchdLabel && !args.skipLaunchd) {
    const output = run('launchctl', ['list'], { cwd: runtime });
    add('launchd', validateLaunchdList(output, args.launchdLabel));
  }

  return { ok: issues.length === 0, issues, checks, runtime, vault, ncl };
}

module.exports = {
  checkRuntime,
  runCommand,
  unwrapNclJson,
  validateDestinations,
  validateGroup,
  validateGroupConfig,
  validateLaunchdList,
  validateMountAllowlist,
  validateRuntimeSurface,
  validateSessions,
  validateUpgradeState,
};
