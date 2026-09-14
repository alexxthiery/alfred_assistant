#!/usr/bin/env node
// nanoclaw-upgrade-gate.js - repeatable Alfred/NanoClaw upgrade gate.
//
// The gate is a phase runner for a staging NanoClaw checkout. It does not fetch,
// merge, deploy, or modify production. It answers one question: is this staging
// checkout ready for the next canary step under Alfred's integration contract?

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function usage() {
  return [
    'Usage:',
    '  tools/nanoclaw-upgrade-gate.js --nanoclaw <staging> [--prod <production>] [--mode fast|full]',
    '      [--log-dir <dir>] [--skip-alfred] [--skip-nanoclaw] [--skip-smoke] [--keep-smoke]',
    '',
    'Modes:',
    '  fast  Alfred unit/persona checks + disposable smoke with focused NanoClaw guard tests',
    '  full  fast + Alfred full test suite + NanoClaw build/root/typecheck/agent-runner tests',
    '',
    'Logs:',
    '  by default, writes one log per subcommand under audit/nanoclaw-gates/',
    '',
    'This command never touches production and refuses if --nanoclaw and --prod',
    'resolve to the same checkout.',
  ].join('\n');
}

function parseArgv(argv) {
  const out = {
    mode: 'fast',
    nanoclaw: '',
    prod: '',
    skipAlfred: false,
    skipNanoclaw: false,
    skipSmoke: false,
    keepSmoke: false,
    logDir: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--nanoclaw':
        out.nanoclaw = value();
        break;
      case '--prod':
        out.prod = value();
        break;
      case '--mode':
        out.mode = value();
        if (!['fast', 'full'].includes(out.mode)) throw new Error('--mode must be fast or full');
        break;
      case '--skip-alfred':
        out.skipAlfred = true;
        break;
      case '--skip-nanoclaw':
        out.skipNanoclaw = true;
        break;
      case '--skip-smoke':
        out.skipSmoke = true;
        break;
      case '--keep-smoke':
        out.keepSmoke = true;
        break;
      case '--log-dir':
        out.logDir = value();
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      default:
        throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!out.help && !out.nanoclaw) throw new Error('--nanoclaw is required');
  return out;
}

function real(p) {
  return fs.realpathSync(path.resolve(p));
}

function validatePaths(args) {
  const staging = real(args.nanoclaw);
  const agentRunner = path.join(staging, 'container', 'agent-runner', 'package.json');
  if (!fs.existsSync(path.join(staging, 'package.json'))) throw new Error(`not a NanoClaw checkout: ${staging}`);
  if (!fs.existsSync(agentRunner)) throw new Error(`missing NanoClaw agent-runner package: ${agentRunner}`);
  let prod = '';
  if (args.prod) {
    prod = real(args.prod);
    if (prod === staging) throw new Error('--prod and --nanoclaw resolve to the same path');
  }
  return { staging, prod };
}

function timestampForPath(d = new Date()) {
  return d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function defaultLogDir(mode, d = new Date()) {
  return path.join(ROOT, 'audit', 'nanoclaw-gates', `${timestampForPath(d)}-${mode}`);
}

function sanitizeLogName(name) {
  const clean = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'step';
}

function tailLines(text, n = 80) {
  return String(text || '').split(/\r?\n/).slice(-n).join('\n');
}

function displayPath(file) {
  const rel = path.relative(ROOT, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  return rel;
}

function run(cmd, args, opts = {}) {
  const commandText = [cmd, ...args].join(' ');
  process.stdout.write(`\n$ ${commandText}\n`);
  const logFile = opts.logDir
    ? path.join(opts.logDir, `${String(opts.index || 0).padStart(2, '0')}-${sanitizeLogName(opts.stepName || cmd)}.log`)
    : '';
  if (logFile) process.stdout.write(`  log: ${displayPath(logFile)}\n`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: opts.env || process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, [
      `$ ${commandText}`,
      `cwd: ${opts.cwd || ROOT}`,
      `exit: ${r.status}`,
      '',
      '--- stdout ---',
      r.stdout || '',
      '',
      '--- stderr ---',
      r.stderr || '',
    ].join('\n'));
  } else {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const tail = tailLines(`${r.stdout || ''}\n${r.stderr || ''}`);
    if (tail.trim()) process.stderr.write(`\nLast output from failed command:\n${tail}\n`);
    throw new Error(`${cmd} ${args.join(' ')} failed with exit ${r.status}`);
  }
}

function runStep(results, name, fn) {
  const start = Date.now();
  try {
    fn();
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    results.push({ name, ok: true, seconds });
    console.log(`PASS ${name} (${seconds}s)`);
  } catch (err) {
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    results.push({ name, ok: false, seconds, error: err && err.message ? err.message : String(err) });
    console.error(`FAIL ${name} (${seconds}s): ${err && err.message ? err.message : err}`);
  }
}

function alfredCommands(mode) {
  const cmds = [
    ['node', ['bin/wiki', 'persona-lint']],
    ['git', ['diff', '--check']],
  ];
  if (mode === 'full') cmds.push(['npm', ['test']]);
  else cmds.push(['npm', ['run', 'test:unit']]);
  return cmds;
}

function nanoclawCommands(staging, mode) {
  if (mode !== 'full') return [];
  return [
    ['pnpm', ['run', 'build'], staging],
    ['pnpm', ['test', '--', '--reporter=dot'], staging],
    ['pnpm', ['exec', 'tsc', '-p', 'container/agent-runner/tsconfig.json', '--noEmit'], staging],
    ['bun', ['test'], path.join(staging, 'container', 'agent-runner')],
  ];
}

function printSummary(results, mode) {
  console.log('\nUpgrade gate summary');
  console.log(`mode: ${mode}`);
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(`${status} ${r.name} (${r.seconds}s)${r.error ? ` - ${r.error}` : ''}`);
  }
  if (results.some((r) => !r.ok)) throw new Error('upgrade gate failed');
  console.log('\nUpgrade gate passed. Staging is ready for the next documented canary step.');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgv(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const paths = validatePaths(args);
  const results = [];
  const logDir = path.resolve(args.logDir || defaultLogDir(args.mode));
  let commandIndex = 0;
  const runLogged = (cmd, cmdArgs, opts = {}) => run(cmd, cmdArgs, {
    ...opts,
    logDir,
    index: ++commandIndex,
  });

  console.log(`NanoClaw staging: ${paths.staging}`);
  if (paths.prod) console.log(`NanoClaw production: ${paths.prod}`);
  console.log(`Mode: ${args.mode}`);
  console.log(`Log dir: ${logDir}`);

  if (args.skipAlfred) {
    results.push({ name: 'Alfred checks', ok: true, seconds: '0.0', error: 'skipped' });
  } else {
    runStep(results, args.mode === 'full' ? 'Alfred full checks' : 'Alfred fast checks', () => {
      for (const [cmd, cmdArgs] of alfredCommands(args.mode)) {
        runLogged(cmd, cmdArgs, { cwd: ROOT, stepName: `alfred-${cmdArgs.join('-')}` });
      }
    });
  }

  if (args.skipNanoclaw) {
    results.push({ name: 'NanoClaw root checks', ok: true, seconds: '0.0', error: 'skipped' });
  } else {
    runStep(results, args.mode === 'full' ? 'NanoClaw full checks' : 'NanoClaw fast checks', () => {
      const commands = nanoclawCommands(paths.staging, args.mode);
      if (!commands.length) {
        runLogged('git', ['-C', paths.staging, 'status', '--short', '--branch'], { stepName: 'nanoclaw-git-status' });
        return;
      }
      for (const [cmd, cmdArgs, cwd] of commands) {
        runLogged(cmd, cmdArgs, { cwd, stepName: `nanoclaw-${cmdArgs.join('-')}` });
      }
    });
  }

  if (args.skipSmoke) {
    results.push({ name: 'Disposable contract smoke', ok: true, seconds: '0.0', error: 'skipped' });
  } else {
    runStep(results, 'Disposable contract smoke', () => {
      const cmdArgs = ['tools/nanoclaw-disposable-smoke.js', '--nanoclaw', paths.staging];
      if (args.keepSmoke) cmdArgs.push('--keep');
      runLogged(process.execPath, cmdArgs, { cwd: ROOT, stepName: 'disposable-contract-smoke' });
    });
  }

  printSummary(results, args.mode);
  console.log(`Logs written to: ${logDir}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\n${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = {
  parseArgv,
  validatePaths,
  alfredCommands,
  nanoclawCommands,
  defaultLogDir,
  sanitizeLogName,
  tailLines,
  displayPath,
};
