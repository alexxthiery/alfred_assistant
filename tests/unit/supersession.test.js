// Unit tests for bin/lib/supersession.js. Run with `npm run test:unit`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ensureObservationLineId,
  formatSupersedeAnnotations,
  parseReplacedBy,
  supersedeObservationLine,
  validateSupersedeReason,
} = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'supersession.js'));

test('formatSupersedeAnnotations renders until, reason, and replacement handles', () => {
  assert.equal(
    formatSupersedeAnnotations({
      until: '2026-06-22',
      reason: 'split',
      replacedBy: ['obs:abc123', 'target-card#obs:def456'],
    }),
    '[until 2026-06-22] [reason: split] [replaced_by: obs:abc123, target-card#obs:def456]',
  );
});

test('validateSupersedeReason accepts lowercase tokens and rejects prose', () => {
  assert.equal(validateSupersedeReason('reclassified'), null);
  assert.equal(validateSupersedeReason('split-claim'), null);
  assert.match(validateSupersedeReason('split claim'), /invalid supersede reason/);
  assert.match(validateSupersedeReason('[split]'), /invalid supersede reason/);
});

test('parseReplacedBy accepts obs, page, and page-observation handles', () => {
  const out = parseReplacedBy('obs:abc123, target-card, target-card#obs:def456');
  assert.equal(out.error, null);
  assert.deepEqual(out.values, ['obs:abc123', 'target-card', 'target-card#obs:def456']);
});

test('parseReplacedBy rejects malformed handles', () => {
  const out = parseReplacedBy('Obs:ABC123, no spaces');
  assert.match(out.error, /invalid replaced_by handle/);
});

test('ensureObservationLineId preserves existing id and mints missing id', () => {
  const existing = ensureObservationLineId('- [fact] A <!--obs:abc123-->');
  assert.equal(existing.id, 'abc123');
  assert.equal(existing.line, '- [fact] A <!--obs:abc123-->');

  const minted = ensureObservationLineId('- [fact] B');
  assert.match(minted.id, /^[a-z0-9]{6}$/);
  assert.match(minted.line, /^- \[fact\] B <!--obs:[a-z0-9]{6}-->$/);
});

test('supersedeObservationLine wraps the observation and appends structured metadata', () => {
  const out = supersedeObservationLine('- [fact] Old claim ^[t:1] <!--obs:old123-->', {
    until: '2026-06-22',
    reason: 'corrected',
    replacedBy: ['obs:new123'],
  });
  assert.equal(out.error, null);
  assert.equal(
    out.line,
    '- ~~[fact] Old claim ^[t:1] <!--obs:old123-->~~ [until 2026-06-22] [reason: corrected] [replaced_by: obs:new123]',
  );
});

test('supersedeObservationLine rejects already-superseded lines', () => {
  const out = supersedeObservationLine('- ~~[fact] Old~~ [until 2026-01-01]', {
    until: '2026-06-22',
  });
  assert.match(out.error, /already superseded/);
});
