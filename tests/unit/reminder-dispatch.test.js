// Unit tests for bin/lib/reminder-dispatch.js — the pure firing logic of the
// vault-backed reminder dispatcher.
//
// Locks the wire format of `wiki todo list --reminders` (so a column change in
// bin/wiki that would silently break dispatch is caught here) and the three
// firing conditions: due (epoch compare, timezone-aware), not-yet-stamped,
// notify-includes-telegram.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseReminderLine,
  parseReminderRows,
  filterDue,
  formatTelegram,
  notifiesTelegram,
} = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'reminder-dispatch.js'));

// ─── parseReminderLine ──────────────────────────────────────────────────────

test('parseReminderLine: full row with remind/reminded/notify columns', () => {
  const line = 'open\ttodo-x\tPickleball\tdue 2026-05-23\t\tremind 2026-05-23T14:00+08:00\treminded 2026-05-23T07:00:00Z\tnotify telegram,email';
  const r = parseReminderLine(line);
  assert.equal(r.slug, 'todo-x');
  assert.equal(r.title, 'Pickleball');
  assert.equal(r.remind_at, '2026-05-23T14:00+08:00');
  assert.equal(r.reminded_at, '2026-05-23T07:00:00Z');
  assert.deepEqual(r.notify, ['telegram', 'email']);
});

test('parseReminderLine: unstamped reminder (empty reminded column)', () => {
  const line = 'open\ttodo-x\tPickleball\tdue 2026-05-23\t\tremind 2026-05-23T14:00+08:00\t\tnotify telegram,email';
  const r = parseReminderLine(line);
  assert.equal(r.reminded_at, null);
  assert.equal(r.remind_at, '2026-05-23T14:00+08:00');
});

test('parseReminderLine: null on blank / "(no matching todos)"', () => {
  assert.equal(parseReminderLine(''), null);
  assert.equal(parseReminderLine('(no matching todos)'), null);
});

test('parseReminderRows: filters out non-rows', () => {
  const out = 'open\ttodo-a\tA\t\t\tremind 2026-01-01T00:00Z\t\tnotify telegram\n(no matching todos)\n';
  const rows = parseReminderRows(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, 'todo-a');
});

// ─── filterDue ──────────────────────────────────────────────────────────────

const NOW = '2026-05-23T07:00:00Z'; // 15:00 SGT

function row(over) {
  return Object.assign(
    { slug: 's', title: 't', remind_at: '2026-05-23T06:00:00Z', reminded_at: null, notify: ['telegram'] },
    over
  );
}

test('filterDue: fires when remind_at <= now and unstamped and notifies telegram', () => {
  assert.equal(filterDue([row()], NOW).length, 1);
});

test('filterDue: does NOT fire a future remind_at', () => {
  assert.equal(filterDue([row({ remind_at: '2026-05-23T08:00:00Z' })], NOW).length, 0);
});

test('filterDue: timezone offset is honored (14:00+08:00 == 06:00Z, due at 07:00Z)', () => {
  assert.equal(filterDue([row({ remind_at: '2026-05-23T14:00+08:00' })], NOW).length, 1);
  // 16:00+08:00 == 08:00Z, NOT yet due at 07:00Z
  assert.equal(filterDue([row({ remind_at: '2026-05-23T16:00+08:00' })], NOW).length, 0);
});

test('filterDue: already-stamped reminder does not re-fire (idempotency)', () => {
  assert.equal(filterDue([row({ reminded_at: '2026-05-23T06:30:00Z' })], NOW).length, 0);
});

test('filterDue: notify excluding telegram does not fire', () => {
  assert.equal(filterDue([row({ notify: ['email'] })], NOW).length, 0);
});

test('filterDue: empty/absent notify defaults to firing (both channels)', () => {
  assert.equal(filterDue([row({ notify: [] })], NOW).length, 1);
});

test('filterDue: row without remind_at never fires', () => {
  assert.equal(filterDue([row({ remind_at: null })], NOW).length, 0);
});

test('filterDue: malformed remind_at never fires', () => {
  assert.equal(filterDue([row({ remind_at: 'not-a-date' })], NOW).length, 0);
});

test('filterDue: throws on invalid now', () => {
  assert.throws(() => filterDue([row()], 'garbage'), /invalid now/);
});

// ─── notifiesTelegram ─────────────────────────────────────────────────────────

test('notifiesTelegram: true when list includes telegram or is empty', () => {
  assert.equal(notifiesTelegram({ notify: ['telegram', 'email'] }), true);
  assert.equal(notifiesTelegram({ notify: [] }), true);
  assert.equal(notifiesTelegram({ notify: ['email'] }), false);
});

// ─── formatTelegram ───────────────────────────────────────────────────────────

test('formatTelegram: empty list -> empty string (pipe no-op)', () => {
  assert.equal(formatTelegram([]), '');
});

test('formatTelegram: one line per reminder', () => {
  const out = formatTelegram([{ title: 'A' }, { title: 'B' }]);
  assert.equal(out, 'Reminder: A\nReminder: B');
});
