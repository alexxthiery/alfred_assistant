// Unit tests for lib/date.js — the single source of truth for ISO-date
// (YYYY-MM-DD) shape validation. Consolidates a regex that had drifted across
// ~6 call sites.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { isISODate, ISO_RE } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'date.js'),
);

test('accepts a well-formed ISO date', () => {
  assert.equal(isISODate('2026-05-19'), true);
});

test('accepts edge dates (leading/trailing valid)', () => {
  assert.equal(isISODate('0001-01-01'), true);
  assert.equal(isISODate('9999-12-31'), true);
});

test('rejects non-zero-padded month/day', () => {
  assert.equal(isISODate('2026-5-9'), false);
});

test('rejects natural-language and partial dates', () => {
  assert.equal(isISODate('tomorrow'), false);
  assert.equal(isISODate('2026-05'), false);
  assert.equal(isISODate('05-19'), false);
  assert.equal(isISODate(''), false);
});

test('rejects trailing/leading junk', () => {
  assert.equal(isISODate('2026-05-19 '), false);
  assert.equal(isISODate(' 2026-05-19'), false);
  assert.equal(isISODate('2026-05-19T10:00:00'), false);
});

test('rejects non-string inputs without throwing', () => {
  assert.equal(isISODate(null), false);
  assert.equal(isISODate(undefined), false);
  assert.equal(isISODate(20260519), false);
  assert.equal(isISODate({}), false);
});

test('does NOT validate calendar correctness (shape only)', () => {
  // The regex is a shape gate, not a calendar validator. 2026-13-40 is the
  // right SHAPE; downstream Date parsing catches impossible dates where it
  // matters. Documented so callers do not assume semantic validation.
  assert.equal(isISODate('2026-13-40'), true);
});

test('ISO_RE is exported and matches the same shape', () => {
  assert.ok(ISO_RE instanceof RegExp);
  assert.equal(ISO_RE.test('2026-05-19'), true);
  assert.equal(ISO_RE.test('nope'), false);
});
