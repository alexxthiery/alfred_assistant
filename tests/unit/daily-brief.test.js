// Unit tests for daily-brief.js — pure parsers + formatter consumed by
// bin/daily-brief. Locks the wire formats of the three upstream verbs and
// the exact shape of the email body.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  parseTodoLine,
  parseTodoOutput,
  parseAgendaOnThisDayOutput,
  formatBrief,
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

test('formatBrief: clean-slate body when all sections empty', () => {
  const body = formatBrief({ date: '2026-05-19' });
  assert.ok(body.startsWith('Daily brief — 2026-05-19\n'));
  assert.ok(/Clean slate today\./.test(body));
});

test('formatBrief: all four sections, sorted overdue oldest-first', () => {
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
  // Overdue is sorted by due ascending (oldest first).
  const overdueBlock = body.split('\n\n').find((b) => b.startsWith('Overdue'));
  assert.ok(/todo-a — A — due 2026-05-15 — \[high\]\n  todo-b/.test(overdueBlock));
  // Other sections present
  assert.ok(/Due today \(1\):/.test(body));
  assert.ok(/Today's events \(1\):/.test(body));
  assert.ok(/Birthdays today \(1\):/.test(body));
  assert.ok(/carol/.test(body));
});

test('formatBrief: caps each section at MAX_PER_SECTION and reports omission', () => {
  const many = Array.from({ length: MAX_PER_SECTION + 3 }, (_, i) => ({
    slug: `todo-${i}`, title: `T${i}`, due: `2026-05-${10 + i}`, priority: null,
  }));
  const body = formatBrief({ date: '2026-05-19', overdue: many });
  assert.ok(new RegExp(`Overdue \\(${many.length}\\), showing ${MAX_PER_SECTION}:`).test(body));
  // Last shown slug is index MAX_PER_SECTION-1 after the oldest-first sort.
  assert.ok(body.includes(`todo-${MAX_PER_SECTION - 1}`));
  // Anything beyond the cap is not in the body.
  assert.ok(!body.includes(`todo-${many.length - 1} — T${many.length - 1}`));
});

test('formatBrief: empty sections are omitted (no "Birthdays today (0)" lines)', () => {
  const body = formatBrief({
    date: '2026-05-19',
    overdue: [{ slug: 'todo-a', title: 'A', due: '2026-05-15', priority: null }],
  });
  assert.ok(/Overdue \(1\):/.test(body));
  assert.ok(!/Due today/.test(body));
  assert.ok(!/Today's events/.test(body));
  assert.ok(!/Birthdays/.test(body));
});

test('formatBrief: rejects bad date shape', () => {
  assert.throws(() => formatBrief({ date: 'tomorrow' }), /YYYY-MM-DD/);
});
