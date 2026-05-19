// Unit tests for bin/lib/secrets.js. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { detectSecrets, redactSecrets, luhnValid } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'secrets.js'),
);

// ─── positive cases — each pattern must fire on a representative shape ────

test('detectSecrets: openai-style sk- key', () => {
  const hits = detectSecrets('config: sk-abc123def456ghi789jklmnop done');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'openai-or-stripe-key');
});

test('detectSecrets: github personal access token', () => {
  const hits = detectSecrets('use ghp_AbCdEfGhIjKlMnOpQrSt12 for auth');
  assert.equal(hits[0].name, 'github-pat');
});

test('detectSecrets: slack bot token', () => {
  const hits = detectSecrets('SLACK_TOKEN=xoxb-1234567890-abcdefg');
  assert.equal(hits[0].name, 'slack-token');
});

test('detectSecrets: AWS access key id', () => {
  const hits = detectSecrets('AKIAIOSFODNN7EXAMPLE in env');
  assert.equal(hits[0].name, 'aws-access-key-id');
});

test('detectSecrets: JWT three-segment', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4';
  const hits = detectSecrets(`token=${jwt}`);
  assert.equal(hits[0].name, 'jwt');
});

test('detectSecrets: Bearer token in HTTP header form', () => {
  const hits = detectSecrets('Authorization: Bearer aBcDeFgHiJkLmNoP1234567890');
  assert.equal(hits[0].name, 'bearer-token');
});

test('detectSecrets: literal password assignment', () => {
  const hits = detectSecrets("db_password: 'hunter2-shouldnt-leak'");
  assert.equal(hits[0].name, 'password-assignment');
});

test('detectSecrets: IBAN-shaped account number', () => {
  // ISO 13616 test vector for Germany.
  const hits = detectSecrets('Wire to DE89370400440532013000 by Friday');
  assert.equal(hits[0].name, 'iban');
});

test('detectSecrets: credit card with Luhn-valid number', () => {
  // Visa test number, Luhn-valid.
  const hits = detectSecrets('card on file 4111-1111-1111-1111');
  assert.equal(hits[0].name, 'credit-card');
});

// ─── negative cases — must NOT misfire ─────────────────────────────────────

test('detectSecrets: empty input returns []', () => {
  assert.deepEqual(detectSecrets(''), []);
  assert.deepEqual(detectSecrets(null), []);
  assert.deepEqual(detectSecrets(undefined), []);
});

test('detectSecrets: plain prose has no hits', () => {
  const hits = detectSecrets('The team met at the conference last Tuesday.');
  assert.deepEqual(hits, []);
});

test('detectSecrets: 16-digit non-Luhn (random tracking id) does not fire', () => {
  // Random sequence, NOT Luhn-valid.
  const hits = detectSecrets('order 1234567890123456 shipped');
  assert.equal(hits.length, 0);
});

test('detectSecrets: short "sk-" prefix without enough chars does not fire', () => {
  const hits = detectSecrets('sk-too-short');
  assert.deepEqual(hits, []);
});

test('detectSecrets: bare word "Bearer" alone does not fire', () => {
  const hits = detectSecrets('She is the bearer of bad news.');
  assert.deepEqual(hits, []);
});

// ─── redactSecrets ────────────────────────────────────────────────────────

test('redactSecrets: replaces each match with <REDACTED:name>', () => {
  const text = 'token=ghp_AbCdEfGhIjKlMnOpQrSt12 and key=sk-abc123def456ghi789jklmnop';
  const out = redactSecrets(text);
  assert.match(out, /<REDACTED:github-pat>/);
  assert.match(out, /<REDACTED:openai-or-stripe-key>/);
  assert.equal(out.includes('ghp_'), false);
  assert.equal(out.includes('sk-abc123'), false);
});

test('redactSecrets: idempotent on already-redacted text', () => {
  const text = 'token=<REDACTED:github-pat> rest of line';
  assert.equal(redactSecrets(text), text);
});

test('redactSecrets: no-secret text passes through unchanged', () => {
  const text = 'Just a regular sentence about persons.';
  assert.equal(redactSecrets(text), text);
});

test('redactSecrets: preserves text on either side of the secret', () => {
  const out = redactSecrets('before sk-abc123def456ghi789jklmnop after');
  assert.match(out, /^before <REDACTED:openai-or-stripe-key> after$/);
});

// ─── luhn check ────────────────────────────────────────────────────────────

test('luhnValid: returns true for known-valid Visa test number', () => {
  assert.equal(luhnValid('4111111111111111'), true);
});

test('luhnValid: returns false for random digits', () => {
  assert.equal(luhnValid('1234567890123456'), false);
});

test('luhnValid: returns false for non-numeric or wrong length', () => {
  assert.equal(luhnValid('abcdef'), false);
  assert.equal(luhnValid('12'), false);
});
