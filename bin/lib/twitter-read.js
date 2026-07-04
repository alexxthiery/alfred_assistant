'use strict';

const { execSync } = require('child_process');
const { loadConfig } = require('./config.js');
const { detectVaultRoot } = require('./vault-root.js');

const ALFRED_BIRD_BIN_ENV = 'ALFRED_BIRD_BIN';
const ALFRED_BIRD_AUTH_TOKEN_ENV = 'ALFRED_BIRD_AUTH_TOKEN';
const ALFRED_BIRD_CT0_ENV = 'ALFRED_BIRD_CT0';

const READ_ONLY_BIRD_VERBS = Object.freeze([
  'about',
  'bookmarks',
  'check',
  'followers',
  'following',
  'help',
  'likes',
  'list-timeline',
  'mentions',
  'news',
  'read',
  'replies',
  'search',
  'thread',
  'user-tweets',
  'whoami',
]);

const READ_ONLY_BIRD_VERB_SET = new Set(READ_ONLY_BIRD_VERBS);

class TwitterReadError extends Error {
  constructor(message, { exitCode = 1, hint = '' } = {}) {
    super(message);
    this.name = 'TwitterReadError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

function which(bin) {
  try {
    const out = execSync(`command -v ${bin}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function resolveBirdBackend(opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || detectVaultRoot();
  const whichFn = opts.which || which;
  const config = opts.config || loadConfig(cwd);

  if (env[ALFRED_BIRD_BIN_ENV]) {
    return { bin: env[ALFRED_BIRD_BIN_ENV], source: `env:${ALFRED_BIRD_BIN_ENV}` };
  }
  if (config.paths && config.paths.bird_bin) {
    return { bin: config.paths.bird_bin, source: 'config:paths.bird_bin' };
  }
  const pathBin = whichFn('bird');
  if (pathBin) return { bin: pathBin, source: 'PATH' };
  return null;
}

function authFlagsFromEnv(env = process.env) {
  const authToken = env[ALFRED_BIRD_AUTH_TOKEN_ENV] || '';
  const ct0 = env[ALFRED_BIRD_CT0_ENV] || '';
  if (!authToken && !ct0) return { flags: [], source: 'browser-or-bird-config' };
  if (!authToken || !ct0) {
    throw new TwitterReadError(
      `${ALFRED_BIRD_AUTH_TOKEN_ENV} and ${ALFRED_BIRD_CT0_ENV} must be set together`,
      {
        exitCode: 3,
        hint: 'Set both Alfred-specific cookie env vars, or unset both and let bird use browser cookies / ~/.config/bird/config.json5.',
      }
    );
  }
  return {
    flags: ['--auth-token', authToken, '--ct0', ct0],
    source: 'env:alfred-bird-cookies',
  };
}

function buildTwitterReadInvocation(argv, opts = {}) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (!args.length) {
    throw new TwitterReadError('missing verb', {
      exitCode: 1,
      hint: 'Run `twitter-read --help` for usage.',
    });
  }

  const verb = args[0];
  if (!READ_ONLY_BIRD_VERB_SET.has(verb)) {
    throw new TwitterReadError(`unsupported verb: ${verb}`, {
      exitCode: 1,
      hint: `Allowed verbs: ${READ_ONLY_BIRD_VERBS.join(', ')}`,
    });
  }

  const backend = resolveBirdBackend(opts);
  if (!backend) {
    throw new TwitterReadError('bird backend not found', {
      exitCode: 2,
      hint: 'Install `bird`, set ALFRED_BIRD_BIN, or set paths.bird_bin in .alfred.yml. See docs/TWITTER.md.',
    });
  }

  const auth = authFlagsFromEnv(opts.env || process.env);
  return {
    bin: backend.bin,
    args: [...args, ...auth.flags],
    backendSource: backend.source,
    authSource: auth.source,
  };
}

function formatTwitterReadHelp() {
  return [
    'twitter-read — Alfred\'s read-only X/Twitter adapter over `bird`.',
    '',
    'Usage:',
    '  twitter-read <verb> [args...]',
    '  twitter-read --help',
    '',
    'Allowed verbs:',
    `  ${READ_ONLY_BIRD_VERBS.join(', ')}`,
    '',
    'Backend resolution order:',
    `  1. ${ALFRED_BIRD_BIN_ENV}`,
    '  2. .alfred.yml paths.bird_bin',
    '  3. `bird` on PATH',
    '',
    'Auth modes:',
    `  - ${ALFRED_BIRD_AUTH_TOKEN_ENV} + ${ALFRED_BIRD_CT0_ENV} (set both or neither)`,
    '  - otherwise bird uses browser cookies / ~/.config/bird/config.json5',
    '',
    'This wrapper intentionally blocks write verbs such as tweet/reply/unbookmark.',
  ].join('\n');
}

module.exports = {
  ALFRED_BIRD_BIN_ENV,
  ALFRED_BIRD_AUTH_TOKEN_ENV,
  ALFRED_BIRD_CT0_ENV,
  READ_ONLY_BIRD_VERBS,
  TwitterReadError,
  authFlagsFromEnv,
  buildTwitterReadInvocation,
  formatTwitterReadHelp,
  resolveBirdBackend,
  which,
};
