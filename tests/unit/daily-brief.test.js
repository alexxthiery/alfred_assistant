// Unit tests for daily-brief.js — pure parsers + formatter consumed by
// bin/daily-brief. Locks the wire formats of the upstream verbs and the exact
// shape of the email body.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseTodoLine,
  parseTodoOutput,
  parseAgendaOnThisDayOutput,
  parseAgendaWindowOutput,
  isDeliveredPastReminder,
  formatBrief,
  subjectFor,
  localDate,
  MAX_PER_SECTION,
} = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'daily-brief.js'));

test('parseTodoLine: full row with due + priority', () => {
  const row = parseTodoLine('open\ttodo-pay-tax\tPay tax\tdue 2026-05-21\t[high]');
  assert.deepEqual(row, { status: 'open', slug: 'todo-pay-tax', title: 'Pay tax', due: '2026-05-21', priority: 'high' });
});

test('parseTodoLine: row with only due, no priority', () => {
  const row = parseTodoLine('open\ttodo-call-mom\tCall mom\tdue 2026-05-19\t');
  assert.deepEqual(row, { status: 'open', slug: 'todo-call-mom', title: 'Call mom', due: '2026-05-19', priority: null });
});

test('parseTodoLine: bare row, no due no priority', () => {
  const row = parseTodoLine('open\ttodo-stretch\tStretch\t\t');
  assert.deepEqual(row, { status: 'open', slug: 'todo-stretch', title: 'Stretch', due: null, priority: null });
});

test('parseTodoLine: skips blank lines and "(no matching todos)"', () => {
  assert.equal(parseTodoLine(''), null);
  assert.equal(parseTodoLine('(no matching todos)'), null);
});

test('parseTodoLine: preserves appended reminder metadata', () => {
  const row = parseTodoLine(
    'open\ttodo-ac\tAircon visit\tdue 2026-05-29\t\tremind 2026-05-28T20:00:00+08:00\treminded 2026-05-28T12:13:36Z\tnotify telegram,email',
  );
  assert.equal(row.remind_at, '2026-05-28T20:00:00+08:00');
  assert.equal(row.reminded_at, '2026-05-28T12:13:36Z');
  assert.deepEqual(row.notify, ['telegram', 'email']);
});

test('parseTodoOutput: multiple rows', () => {
  const stdout = [
    'open\ttodo-a\tA\tdue 2026-05-18\t',
    'open\ttodo-b\tB\tdue 2026-05-19\t[med]',
    '',
  ].join('\n');
  const rows = parseTodoOutput(stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].slug, 'todo-a');
  assert.equal(rows[1].priority, 'med');
});

test('parseAgendaOnThisDayOutput: events + birthdays', () => {
  const stdout = [
    '## events on 03-14 (any year)',
    '  2024-03-14  [[eclipse-day]]',
    '',
    '## birthdays on 03-14',
    '  1985-03-14  [[carol]] (turns 41)',
    '  03-14  [[dave]]',
  ].join('\n');
  const { events, birthdays } = parseAgendaOnThisDayOutput(stdout);
  assert.deepEqual(events, [{ slug: 'eclipse-day', when: '2024-03-14' }]);
  assert.equal(birthdays.length, 2);
  assert.deepEqual(birthdays[0], { slug: 'carol', born: '1985-03-14', age: 41 });
  assert.deepEqual(birthdays[1], { slug: 'dave', born: '03-14', age: null });
});

test('parseAgendaOnThisDayOutput: empty day', () => {
  const { events, birthdays } = parseAgendaOnThisDayOutput('(nothing on 05-19)\n');
  assert.deepEqual(events, []);
  assert.deepEqual(birthdays, []);
});

test('parseAgendaWindowOutput: parses exact-date agenda rows', () => {
  const stdout = [
    '2026-05-30  [[pickleball-2026-05-30]]',
    '2026-05-30 09:00  [[aircon-visit]]  @ home',
    '(ignored line)',
  ].join('\n');
  assert.deepEqual(parseAgendaWindowOutput(stdout), [
    { when: '2026-05-30', slug: 'pickleball-2026-05-30' },
    { when: '2026-05-30', slug: 'aircon-visit' },
  ]);
});

test('isDeliveredPastReminder: true only after a reminder has fired and due date passed', () => {
  const fired = {
    due: '2026-05-29',
    remind_at: '2026-05-28T20:00:00+08:00',
    reminded_at: '2026-05-28T12:13:36Z',
  };
  assert.equal(isDeliveredPastReminder(fired, '2026-05-30'), true);
  assert.equal(isDeliveredPastReminder(fired, '2026-05-29'), false);
  assert.equal(isDeliveredPastReminder({ ...fired, reminded_at: null }, '2026-05-30'), false);
  assert.equal(isDeliveredPastReminder({ due: '2026-05-29' }, '2026-05-30'), false);
});

test('formatBrief: clean-slate body when all sections empty', () => {
  const body = formatBrief({ date: '2026-05-19' });
  assert.ok(body.startsWith('Daily brief, '));
  assert.ok(/Clean slate\./.test(body));
  // No em dashes anywhere (project style rule).
  assert.ok(!body.includes('—'));
});

test('formatBrief: all sections, title-first, overdue aged oldest-first', () => {
  const body = formatBrief({
    date: '2026-05-19',
    overdue: [
      { slug: 'todo-b', title: 'B', due: '2026-05-17', priority: null },
      { slug: 'todo-a', title: 'A', due: '2026-05-15', priority: 'high' },
    ],
    dueToday: [{ slug: 'todo-c', title: 'C', due: '2026-05-19', priority: 'med' }],
    events: [{ slug: 'mtg-x', when: '2026-05-19' }],
    birthdays: [{ slug: 'carol', born: '1985-05-19', age: 41 }],
  });
  // Title leads; slug is gone; overdue shows relative aging; oldest first.
  assert.ok(/OVERDUE \(2\)\n- A \[high\]\n {2}4 days overdue \(was 15 May\)\n- B\n {2}2 days overdue \(was 17 May\)/.test(body));
  assert.ok(!body.includes('todo-a'), 'slug must not leak into the body');
  // Due-today: title-first, no aging line.
  assert.ok(/DUE TODAY \(1\)\n- C \[med\]/.test(body));
  // Events and birthdays prettified, no [[wikilinks]].
  assert.ok(/EVENTS \(1\)\n- Mtg x/.test(body));
  assert.ok(/BIRTHDAYS \(1\)\n- Carol \(turns 41\)/.test(body));
  assert.ok(!body.includes('[['), 'no raw wikilinks in the email');
  assert.ok(!body.includes('—'), 'no em dashes');
});

test('formatBrief: caps each section at MAX_PER_SECTION and reports omission', () => {
  const many = Array.from({ length: MAX_PER_SECTION + 3 }, (_, i) => ({
    slug: `todo-${i}`, title: `T${i}`, due: `2026-05-${10 + i}`, priority: null,
  }));
  const body = formatBrief({ date: '2026-05-19', overdue: many });
  assert.ok(new RegExp(`OVERDUE \\(${many.length}\\), showing ${MAX_PER_SECTION}`).test(body));
  // Oldest-first: T0..T4 shown, the rest omitted.
  assert.ok(body.includes('- T4'));
  assert.ok(!body.includes('- T7'));
});

test('formatBrief: action sections always render; events/birthdays omitted when empty', () => {
  const body = formatBrief({
    date: '2026-05-19',
    overdue: [{ slug: 'todo-a', title: 'A', due: '2026-05-15', priority: null }],
  });
  assert.ok(/OVERDUE \(1\)/.test(body));
  assert.ok(/DUE TODAY \(0\)\nNothing due\./.test(body));
  assert.ok(!/EVENTS/.test(body));
  assert.ok(!/BIRTHDAYS/.test(body));
});

test('formatBrief: ONGOING lists background todos, soonest-due first, undated last', () => {
  const body = formatBrief({
    date: '2026-05-19',
    background: [
      { slug: 'todo-x', title: 'Book trip', due: '2026-08-01', priority: null },
      { slug: 'todo-y', title: 'Backup folder', due: null, priority: null },
      { slug: 'todo-z', title: 'Renew passport', due: '2026-06-15', priority: 'high' },
    ],
  });
  assert.ok(/ONGOING \(3\)\n- Renew passport \[high\] \(due 15 Jun\)\n- Book trip \(due 1 Aug\)\n- Backup folder/.test(body), body);
  assert.ok(!body.includes('—'), 'no em dashes');
});

test('formatBrief: ONGOING omitted when no background todos', () => {
  const body = formatBrief({ date: '2026-05-19', dueToday: [{ slug: 'todo-c', title: 'C', due: '2026-05-19', priority: null }] });
  assert.ok(!/ONGOING/.test(body));
});

test('formatBrief: a day with only background todos is not a clean slate', () => {
  const body = formatBrief({ date: '2026-05-19', background: [{ slug: 'todo-x', title: 'Book trip', due: '2026-08-01', priority: null }] });
  assert.ok(!/Clean slate/.test(body));
  assert.ok(/ONGOING \(1\)/.test(body));
});

test('formatBrief: rejects bad date shape', () => {
  assert.throws(() => formatBrief({ date: 'tomorrow' }), /YYYY-MM-DD/);
});

test('subjectFor: counts lead, friendly date', () => {
  const s = subjectFor({ date: '2026-05-25', overdue: [{}, {}], dueToday: [{}] });
  assert.match(s, /^Daily brief: 2 overdue, 1 due \(\w{3} 25 May\)$/);
});

test('subjectFor: clear day', () => {
  assert.match(subjectFor({ date: '2026-05-25' }), /^Daily brief: clear \(\w{3} 25 May\)$/);
});

test('subjectFor: birthdays pluralize and are included', () => {
  assert.match(subjectFor({ date: '2026-05-25', birthdays: [{}, {}] }), /2 birthdays/);
  assert.match(subjectFor({ date: '2026-05-25', birthdays: [{}] }), /1 birthday\b/);
});

// ─── localDate: timezone-correct "today" (not UTC) ───────────────────────────

test('localDate: 07:30 SGT is "today" in Asia/Singapore, not yesterday (UTC bug)', () => {
  // 2026-05-21T23:30:00Z == 2026-05-22 07:30 in Singapore (UTC+8).
  const instant = new Date('2026-05-21T23:30:00Z');
  assert.equal(localDate(instant, 'Asia/Singapore'), '2026-05-22', 'must be the local date');
  // The old toISOString().slice(0,10) would have returned the UTC date:
  assert.equal(instant.toISOString().slice(0, 10), '2026-05-21', 'documents the old buggy value');
});

test('localDate: honors the given zone (UTC vs SGT differ across midnight)', () => {
  const instant = new Date('2026-05-22T16:00:00Z'); // 2026-05-23 00:00 SGT
  assert.equal(localDate(instant, 'UTC'), '2026-05-22');
  assert.equal(localDate(instant, 'Asia/Singapore'), '2026-05-23');
});

test('localDate: returns zero-padded YYYY-MM-DD', () => {
  assert.match(localDate(new Date('2026-01-05T12:00:00Z'), 'UTC'), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localDate(new Date('2026-01-05T12:00:00Z'), 'UTC'), '2026-01-05');
});
