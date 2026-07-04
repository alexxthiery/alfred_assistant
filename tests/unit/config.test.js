// Unit tests for bin/lib/config.js.
//
// Config loading is a startup gate — a bug here breaks every CLI invocation.
// Tests focus on the pure parseFlatYaml + the DEFAULTS shape; loadConfig path
// resolution is integration-tested by the CLI fixtures.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseFlatYaml, loadConfig, DEFAULTS } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'config.js'));

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

function writeConfig(root, body) {
  fs.writeFileSync(path.join(root, '.alfred.yml'), body);
}

test('parseFlatYaml: parses a 2-level section with scalar children', () => {
  const out = parseFlatYaml('user:\n  slug: alice\n  name: Alice Smith\n');
  assert.deepEqual(out, { user: { slug: 'alice', name: 'Alice Smith' } });
});

test('parseFlatYaml: parses a top-level scalar', () => {
  const out = parseFlatYaml('greeting: hello\n');
  assert.deepEqual(out, { greeting: 'hello' });
});

test('parseFlatYaml: strips end-of-line comments', () => {
  const out = parseFlatYaml('user:\n  slug: alice  # the user slug\n');
  assert.equal(out.user.slug, 'alice');
});

test('parseFlatYaml: coerces booleans and integers', () => {
  const out = parseFlatYaml('weekly_review:\n  enabled: true\n  retries: 3\n  disabled: false\n');
  assert.equal(out.weekly_review.enabled, true);
  assert.equal(out.weekly_review.disabled, false);
  assert.equal(out.weekly_review.retries, 3);
});

test('parseFlatYaml: preserves quoted strings verbatim (no coercion)', () => {
  // Without quotes "true" coerces to boolean; quotes preserve as string.
  const out = parseFlatYaml('flag:\n  literal: "true"\n  apostrophe: \'42\'\n');
  assert.equal(out.flag.literal, 'true');
  assert.equal(out.flag.apostrophe, '42');
});

test('parseFlatYaml: empty value at top level becomes empty string (not section)', () => {
  // Section discriminator is whether the value-after-colon is empty AND we're
  // at indent 0 AND children are indented. Standalone empty value at indent 0
  // creates a section that just stays empty if no children follow.
  const out = parseFlatYaml('empty_section:\n');
  assert.deepEqual(out, { empty_section: {} });
});

test('parseFlatYaml: ignores blank lines and pure-comment lines', () => {
  const out = parseFlatYaml('# header comment\n\nuser:\n\n  slug: alice\n# trailing\n');
  assert.deepEqual(out, { user: { slug: 'alice' } });
});

test('parseFlatYaml: rejects unexpected indent', () => {
  // The parser only supports 0 or 2 spaces. 4-space indent should error.
  assert.throws(
    () => parseFlatYaml('user:\n    slug: alice\n'),
    /unexpected indent/,
  );
});

test('parseFlatYaml: rejects indented key with no parent section', () => {
  assert.throws(
    () => parseFlatYaml('  slug: alice\n'),
    /no parent section/,
  );
});

test('parseFlatYaml: rejects line missing a colon', () => {
  assert.throws(
    () => parseFlatYaml('not a valid line\n'),
    /expected 'key: value'/,
  );
});

test('DEFAULTS: has all expected top-level sections (regression on dropped keys)', () => {
  // If someone removes a section from DEFAULTS, downstream code that expects
  // it (e.g., `cfg.email.from`) will crash with "Cannot read property of
  // undefined". Pin the shape.
  assert.ok(DEFAULTS.user, 'user section exists');
  assert.ok(DEFAULTS.assistant, 'assistant section exists');
  assert.ok(DEFAULTS.email, 'email section exists');
  assert.ok(DEFAULTS.weekly_review, 'weekly_review section exists');
  assert.ok(DEFAULTS.paths, 'paths section exists');
  assert.equal(typeof DEFAULTS.user.slug, 'string');
  assert.equal(typeof DEFAULTS.user.name, 'string');
  assert.equal(typeof DEFAULTS.weekly_review.enabled, 'boolean');
  assert.equal(typeof DEFAULTS.paths.bird_bin, 'string');
});

test('DEFAULTS: is frozen (mutation guard)', () => {
  // Object.freeze prevents accidental mutation at startup; surface it.
  assert.ok(Object.isFrozen(DEFAULTS));
});

test('loadConfig: finds nearest .alfred.yml from nested dir and derives vault_root from it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-load-'));
  const nested = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  writeConfig(root, 'user:\n  slug: sample-user\n  name: Sample User\n');

  const cfg = loadConfig(nested);
  assert.equal(cfg.user.slug, 'sample-user');
  assert.equal(cfg.user.name, 'Sample User');
  assert.equal(cfg.paths.vault_root, root);
  assert.equal(cfg._configPath, path.join(root, '.alfred.yml'));
});

test('loadConfig: EMAIL_FROM and TZ env fallbacks populate missing config fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-env-'));
  writeConfig(root, 'user:\n  slug: sample-user\n  name: Sample User\n');

  withEnv({ EMAIL_FROM: 'sample-user@example.invalid', TZ: 'Asia/Singapore' }, () => {
    const cfg = loadConfig(root);
    assert.equal(cfg.email.from, 'sample-user@example.invalid');
    assert.equal(cfg.email.to, 'sample-user@example.invalid');
    assert.equal(cfg.weekly_review.timezone, 'Asia/Singapore');
  });
});

test('loadConfig: explicit relative paths.vault_root resolves against config dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-relroot-'));
  const expected = path.join(root, 'vault-data');
  writeConfig(root, [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'paths:',
    '  vault_root: ./vault-data',
    '',
  ].join('\n'));

  const cfg = loadConfig(root);
  assert.equal(cfg.paths.vault_root, expected);
});

test('loadConfig: explicit ~ in paths.vault_root expands against HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-homeroot-'));
  writeConfig(root, [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'paths:',
    '  vault_root: ~/vault-home',
    '',
  ].join('\n'));

  withEnv({ HOME: '/tmp/fake-home' }, () => {
    const cfg = loadConfig(root);
    assert.equal(cfg.paths.vault_root, '/tmp/fake-home/vault-home');
  });
});

test('loadConfig: explicit relative paths.bird_bin resolves against config dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-relbird-'));
  const expected = path.join(root, 'tools', 'bird');
  writeConfig(root, [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'paths:',
    '  bird_bin: ./tools/bird',
    '',
  ].join('\n'));

  const cfg = loadConfig(root);
  assert.equal(cfg.paths.bird_bin, expected);
});

test('loadConfig: explicit ~ in paths.bird_bin expands against HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-homebird-'));
  writeConfig(root, [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'paths:',
    '  bird_bin: ~/bin/bird',
    '',
  ].join('\n'));

  withEnv({ HOME: '/tmp/fake-home' }, () => {
    const cfg = loadConfig(root);
    assert.equal(cfg.paths.bird_bin, '/tmp/fake-home/bin/bird');
  });
});

test('loadConfig: preserves unknown keys for forward compatibility and deep-freezes the result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-extra-'));
  writeConfig(root, [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'assistant:',
    '  tone: terse',
    'feature_flags:',
    '  experimental: true',
    '',
  ].join('\n'));

  const cfg = loadConfig(root);
  assert.equal(cfg.assistant.tone, 'terse');
  assert.deepEqual(cfg.feature_flags, { experimental: true });
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.user));
  assert.ok(Object.isFrozen(cfg.assistant));
});

test('loadConfig: invalid user.slug reports the config path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-bad-slug-'));
  writeConfig(root, 'user:\n  slug: Bad Slug\n  name: Sample User\n');

  assert.throws(
    () => loadConfig(root),
    (err) => err instanceof Error &&
      err.message.includes(path.join(root, '.alfred.yml')) &&
      err.message.includes('user.slug'),
  );
});

test('loadConfig: weekly_review.cron must be a 5-field expression when enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-bad-cron-'));
  writeConfig(root, [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'weekly_review:',
    '  enabled: true',
    '  cron: "0 9 * *"',
    '',
  ].join('\n'));

  assert.throws(() => loadConfig(root), /weekly_review\.cron/);
});

test('loadConfig: weekly_review.enabled must remain boolean', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-bad-enabled-'));
  writeConfig(root, [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'weekly_review:',
    '  enabled: maybe',
    '',
  ].join('\n'));

  assert.throws(() => loadConfig(root), /weekly_review\.enabled must be true or false/);
});
