'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ALFRED_BIRD_BIN_ENV,
  ALFRED_BIRD_AUTH_TOKEN_ENV,
  ALFRED_BIRD_CT0_ENV,
  READ_ONLY_BIRD_VERBS,
  TwitterReadError,
  authFlagsFromEnv,
  buildTwitterReadInvocation,
  resolveBirdBackend,
} = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'twitter-read.js'));

function mkConfig(overrides = {}) {
  return {
    paths: { bird_bin: '', ...overrides.paths },
  };
}

test('READ_ONLY_BIRD_VERBS stays non-empty and includes the core morning-read verbs', () => {
  assert.ok(Array.isArray(READ_ONLY_BIRD_VERBS));
  for (const verb of ['whoami', 'user-tweets', 'bookmarks', 'mentions', 'likes', 'check']) {
    assert.ok(READ_ONLY_BIRD_VERBS.includes(verb), `${verb} must stay allowed`);
  }
});

test('resolveBirdBackend: env override beats config and PATH', () => {
  const got = resolveBirdBackend({
    env: { [ALFRED_BIRD_BIN_ENV]: '/env/bird' },
    config: mkConfig({ paths: { bird_bin: '/cfg/bird' } }),
    which: () => '/path/bird',
  });
  assert.deepEqual(got, { bin: '/env/bird', source: `env:${ALFRED_BIRD_BIN_ENV}` });
});

test('resolveBirdBackend: config path beats PATH when env is absent', () => {
  const got = resolveBirdBackend({
    env: {},
    config: mkConfig({ paths: { bird_bin: '/cfg/bird' } }),
    which: () => '/path/bird',
  });
  assert.deepEqual(got, { bin: '/cfg/bird', source: 'config:paths.bird_bin' });
});

test('resolveBirdBackend: falls back to PATH bird', () => {
  const got = resolveBirdBackend({
    env: {},
    config: mkConfig(),
    which: () => '/path/bird',
  });
  assert.deepEqual(got, { bin: '/path/bird', source: 'PATH' });
});

test('resolveBirdBackend: returns null when no backend is configured', () => {
  const got = resolveBirdBackend({
    env: {},
    config: mkConfig(),
    which: () => null,
  });
  assert.equal(got, null);
});

test('authFlagsFromEnv: appends Alfred-specific cookie flags when both vars are set', () => {
  const got = authFlagsFromEnv({
    [ALFRED_BIRD_AUTH_TOKEN_ENV]: 'tok123',
    [ALFRED_BIRD_CT0_ENV]: 'ct0123',
  });
  assert.deepEqual(got, {
    flags: ['--auth-token', 'tok123', '--ct0', 'ct0123'],
    source: 'env:alfred-bird-cookies',
  });
});

test('authFlagsFromEnv: rejects partial Alfred cookie env', () => {
  assert.throws(
    () => authFlagsFromEnv({ [ALFRED_BIRD_AUTH_TOKEN_ENV]: 'tok-only' }),
    (err) => err instanceof TwitterReadError && err.exitCode === 3,
  );
});

test('buildTwitterReadInvocation: forwards allowed read verb and leaves extra args untouched', () => {
  const got = buildTwitterReadInvocation(['bookmarks', '-n', '20'], {
    env: {},
    config: mkConfig({ paths: { bird_bin: '/cfg/bird' } }),
    which: () => null,
  });
  assert.deepEqual(got, {
    bin: '/cfg/bird',
    args: ['bookmarks', '-n', '20'],
    backendSource: 'config:paths.bird_bin',
    authSource: 'browser-or-bird-config',
  });
});

test('buildTwitterReadInvocation: rejects unsupported verbs before spawn time', () => {
  assert.throws(
    () => buildTwitterReadInvocation(['tweet', 'hello'], {
      env: {},
      config: mkConfig({ paths: { bird_bin: '/cfg/bird' } }),
      which: () => null,
    }),
    (err) => err instanceof TwitterReadError &&
      /unsupported verb/.test(err.message) &&
      err.exitCode === 1,
  );
});
