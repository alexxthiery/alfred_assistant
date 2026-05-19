// Unit tests for bin/lib/obsid.js — observation ID minting/parsing primitives.
// TDD: these tests are written before the module exists. `npm run test:unit`
// should fail with "Cannot find module" until the implementation lands.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { mintId, extractId, stripIdMarker, mintIdsForBody } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'obsid.js'),
);

// ─── mintId ────────────────────────────────────────────────────────────────

test('mintId returns a 6-char base36 string matching /^[a-z0-9]{6}$/', () => {
  const id = mintId();
  assert.match(id, /^[a-z0-9]{6}$/);
});

test('mintId returns different ids on 1000 consecutive calls (collision-rate sanity check)', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(mintId());
  // 1000 picks from ~2.2B space: collision probability < 1e-4. Allow at most 1.
  assert.ok(seen.size >= 999, `expected ≥999 unique ids, got ${seen.size}`);
});

// ─── extractId ─────────────────────────────────────────────────────────────

test('extractId returns the id when marker is present at end of line', () => {
  const line = '- [fact] Born 14 November 2012 ^[t:1] <!--obs:a3f7q9-->';
  assert.equal(extractId(line), 'a3f7q9');
});

test('extractId returns the id when marker is mid-line (marker can sit anywhere)', () => {
  const line = '- [fact] Body text <!--obs:abc123--> with trailing prose';
  assert.equal(extractId(line), 'abc123');
});

test('extractId returns null when no marker', () => {
  assert.equal(extractId('- [fact] no marker here ^[t:1]'), null);
});

test('extractId ignores false-positive substrings (other HTML comments)', () => {
  // A comment that isn't an obs marker must not match.
  const line = '- [fact] body <!--note:abc123--> ^[t:1]';
  assert.equal(extractId(line), null);
});

test('extractId returns null on malformed marker (wrong length)', () => {
  // The marker namespace is exactly 6 chars in [a-z0-9]; anything else is invalid.
  assert.equal(extractId('- [fact] body <!--obs:abc-->'), null); // too short
  assert.equal(extractId('- [fact] body <!--obs:abcdefg-->'), null); // too long
  assert.equal(extractId('- [fact] body <!--obs:ABC123-->'), null); // uppercase rejected
});

// ─── stripIdMarker ─────────────────────────────────────────────────────────

test('stripIdMarker removes the marker', () => {
  const line = '- [fact] body <!--obs:a3f7q9--> ^[t:1]';
  assert.equal(stripIdMarker(line), '- [fact] body  ^[t:1]');
});

test('stripIdMarker is idempotent on no-marker input', () => {
  const line = '- [fact] no marker';
  assert.equal(stripIdMarker(line), line);
});

test('stripIdMarker only strips well-formed obs: markers, leaves other HTML comments alone', () => {
  const line = '- [fact] body <!--note:abc--> middle <!--obs:a3f7q9--> end';
  assert.equal(stripIdMarker(line), '- [fact] body <!--note:abc--> middle  end');
});

// ─── mintIdsForBody ────────────────────────────────────────────────────────

test('mintIdsForBody mints ids on observation lines lacking them', () => {
  const body = '- [fact] A\n- [hypothesis] B\n';
  const out = mintIdsForBody(body);
  // Each observation line gains a marker.
  const matches = out.match(/<!--obs:[a-z0-9]{6}-->/g);
  assert.ok(matches);
  assert.equal(matches.length, 2);
});

test('mintIdsForBody is idempotent — second call adds no new ids', () => {
  const body = '- [fact] A\n- [hypothesis] B\n';
  const once = mintIdsForBody(body);
  const twice = mintIdsForBody(once);
  assert.equal(once, twice);
});

test('mintIdsForBody preserves non-observation lines (relations, prose, blank lines) verbatim', () => {
  const body = [
    '- [fact] A',
    '- works_at [[example-corp]]',
    'just a paragraph of prose',
    '',
    '## a heading',
    '- [hypothesis] B',
  ].join('\n');
  const out = mintIdsForBody(body);
  // Non-observation lines must appear unchanged in the output.
  assert.ok(out.includes('- works_at [[example-corp]]'));
  assert.ok(out.includes('just a paragraph of prose'));
  assert.ok(out.includes('## a heading'));
  // The two observation lines pick up markers.
  const matches = out.match(/<!--obs:[a-z0-9]{6}-->/g);
  assert.equal(matches.length, 2);
});

test('mintIdsForBody handles superseded observations (id placed before strikethrough close, after the body content)', () => {
  // The marker should land such that ~~ wraps the fact body but does not eat the marker.
  // Concretely: `- ~~[fact] body~~ [until 2026-05-19] <!--obs:XXXXXX-->` is the right shape.
  const body = '- ~~[fact] retired observation~~ [until 2026-05-19]\n';
  const out = mintIdsForBody(body);
  const m = out.match(/<!--obs:[a-z0-9]{6}-->/);
  assert.ok(m, 'superseded line should still receive a marker');
  // The marker should NOT be inside the ~~~~ wrap (would corrupt the strikethrough).
  const tildeOpen = out.indexOf('~~');
  const tildeClose = out.lastIndexOf('~~');
  const markerPos = out.indexOf('<!--obs:');
  assert.ok(markerPos > tildeClose, 'marker must sit after the closing ~~');
});

test('mintIdsForBody on empty body is a no-op', () => {
  assert.equal(mintIdsForBody(''), '');
});

test('mintIdsForBody preserves trailing newline behaviour', () => {
  const body = '- [fact] A';
  const out = mintIdsForBody(body);
  // Input had no trailing newline; output may or may not, but it must end with what we added (no spurious blank lines).
  assert.match(out, /^- \[fact\] A <!--obs:[a-z0-9]{6}-->$/);
});

test('mintIdsForBody preserves provenance markers, dates, [confidence:], strikethrough when adding ids', () => {
  // The marker must be appended without disturbing any inline tag.
  const body = [
    '- [fact] Joined [since 2024-01] ^[telegram:2026-05-17]',
    '- [prediction] X happens [by 2027-06] [confidence: 0.7] ^[t:1]',
    '- ~~[fact] outdated~~ [until 2025-06]',
  ].join('\n');
  const out = mintIdsForBody(body);
  // Every inline tag survives unchanged.
  assert.ok(out.includes('[since 2024-01]'), 'since date preserved');
  assert.ok(out.includes('^[telegram:2026-05-17]'), 'provenance preserved');
  assert.ok(out.includes('[by 2027-06]'), 'by date preserved');
  assert.ok(out.includes('[confidence: 0.7]'), 'confidence preserved');
  assert.ok(out.includes('[until 2025-06]'), 'until date preserved');
  assert.ok(out.includes('~~[fact] outdated~~'), 'strikethrough wrap preserved');
  // Three observation lines, three markers.
  const matches = out.match(/<!--obs:[a-z0-9]{6}-->/g);
  assert.equal(matches.length, 3);
});
