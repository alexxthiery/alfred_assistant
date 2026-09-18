#!/usr/bin/env node
// check-nanoclaw-assistant-runtime.js — read-only post/pre-promotion check.
//
// This validates one NanoClaw runtime as one assistant security cell: one
// runtime state directory, one mounted vault, one group identity, one Telegram
// destination map, and the package assumptions Alfred relies on.

'use strict';

const { checkRuntime } = require('../bin/lib/nanoclaw-runtime-check.js');

function usage() {
  return [
    'Usage:',
    '  tools/check-nanoclaw-assistant-runtime.js --runtime <path> --vault <path>',
    '      --group-id <id> --assistant-name <name>',
    '      [--launchd-label <label>] [--destination <local-name>]',
    '      [--other-vault <path>] [--expected-upgrade-commit <sha>]',
    '      [--require-duckdb] [--require-telegram-destination]',
    '      [--skip-launchd] [--json]',
    '',
    'Checks:',
    '  - runtime state surface exists (data/home/groups/.env/bin/ncl)',
    '  - mount allowlist contains exactly the active vault and no sibling vault',
    '  - upgrade marker is present and optionally matches a vetted commit',
    '  - ncl group name and assistant_name match the expected assistant',
    '  - group config mounts only the active vault read-write',
    '  - destination map has the expected Telegram destination',
    '  - sessions exist and launchd label is loaded unless skipped',
    '',
    'This command is read-only and never prints secrets.',
  ].join('\n');
}

function parseArgv(argv) {
  const out = {
    otherVaults: [],
    requireDuckdb: false,
    requireTelegramDestination: false,
    skipLaunchd: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--runtime': out.runtime = value(); break;
      case '--vault': out.vault = value(); break;
      case '--group-id': out.groupId = value(); break;
      case '--assistant-name': out.assistantName = value(); break;
      case '--launchd-label': out.launchdLabel = value(); break;
      case '--destination': out.destinationName = value(); break;
      case '--other-vault': out.otherVaults.push(value()); break;
      case '--expected-upgrade-commit': out.expectedUpgradeCommit = value(); break;
      case '--ncl': out.ncl = value(); break;
      case '--require-duckdb': out.requireDuckdb = true; break;
      case '--require-telegram-destination': out.requireTelegramDestination = true; break;
      case '--skip-launchd': out.skipLaunchd = true; break;
      case '--json': out.json = true; break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  if (out.help) return out;
  for (const key of ['runtime', 'vault', 'groupId', 'assistantName']) {
    if (!out[key]) throw new Error(`--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} is required`);
  }
  if (out.destinationName) out.requireTelegramDestination = true;
  return out;
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgv(argv);
    if (args.help) {
      console.log(usage());
      return;
    }
    const result = checkRuntime(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`NanoClaw runtime: ${result.runtime}`);
      console.log(`Vault: ${result.vault}`);
      for (const check of result.checks) {
        if (check.ok) {
          console.log(`OK   ${check.name}`);
        } else {
          console.log(`FAIL ${check.name}`);
          for (const issue of check.issues) console.log(`     - ${issue}`);
        }
      }
      console.log(result.ok ? '\nNanoClaw assistant runtime check passed.' : '\nNanoClaw assistant runtime check failed.');
    }
    if (!result.ok) process.exitCode = 1;
  } catch (err) {
    console.error(`FAIL ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgv };
