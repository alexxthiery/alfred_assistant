// daily-brief.js — pure parsers + formatter for the daily morning brief.
//
// No fs, no spawn — kept pure so unit tests can lock the exact wire formats
// of the upstream wiki verbs (`wiki todo list --overdue/--due-today`,
// `wiki agenda today --asof YYYY-MM-DD`, and `wiki agenda --on YYYY-MM-DD`)
// and the resulting email body.
//
// The orchestrator (bin/daily-brief) spawns the subprocesses, hands
// their stdout strings to the parsers below, then calls formatBrief().

'use strict';

const { isISODate } = require('./date.js');

const MAX_PER_SECTION = 5;

// Parse one line of `wiki todo list` output.
//   "<status>\t<slug>\t<title>\t<dueStr>\t<pStr>\t<remindStr>\t<remindedStr>\t<notifyStr>"
// dueStr is either empty or "due YYYY-MM-DD"; pStr is either empty or "[priority]".
// Reminder columns are optional and appended after the original five columns.
// Returns null for blank / "(no matching todos)" lines.
function parseTodoLine(line) {
  if (!line || line.startsWith('(') || /^\s*$/.test(line)) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [status, slug, title, dueStr = '', pStr = '', remindStr = '', remindedStr = '', notifyStr = ''] = parts;
  const dueMatch = dueStr.match(/^due (\d{4}-\d{2}-\d{2})$/);
  const prioMatch = pStr.match(/^\[([a-z]+)\]$/);
  const remindMatch = remindStr.match(/^remind (.+)$/);
  const remindedMatch = remindedStr.match(/^reminded (.+)$/);
  const notifyMatch = notifyStr.match(/^notify (.+)$/);
  const row = {
    status,
    slug,
    title,
    due: dueMatch ? dueMatch[1] : null,
    priority: prioMatch ? prioMatch[1] : null,
  };
  if (remindMatch) row.remind_at = remindMatch[1].trim();
  if (remindedMatch) row.reminded_at = remindedMatch[1].trim();
  if (notifyMatch) row.notify = notifyMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
  return row;
}

function parseTodoOutput(stdout) {
  return (stdout || '').split('\n').map(parseTodoLine).filter(Boolean);
}

// Parse `wiki agenda --on MM-DD` output:
//   ## events on MM-DD (any year)
//     YYYY-MM-DD  [[slug]]
//
//   ## birthdays on MM-DD
//     <born>  [[slug]] (turns N)
// Returns { events: [{slug, when}], birthdays: [{slug, born, age}] }.
function parseAgendaOnThisDayOutput(stdout) {
  const events = [];
  const birthdays = [];
  let mode = null;
  for (const raw of (stdout || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^## events on /.test(line)) { mode = 'events'; continue; }
    if (/^## birthdays on /.test(line)) { mode = 'birthdays'; continue; }
    if (!line.trim()) { mode = null; continue; }
    if (line.startsWith('(nothing on')) return { events, birthdays };
    if (mode === 'events') {
      const m = line.match(/^\s+(\d{4}-\d{2}-\d{2})\s+\[\[([a-z0-9][a-z0-9-]*)\]\]/);
      if (m) events.push({ slug: m[2], when: m[1] });
    } else if (mode === 'birthdays') {
      const m = line.match(/^\s+(\S+)\s+\[\[([a-z0-9][a-z0-9-]*)\]\](?:\s+\(turns (\d+)\))?/);
      if (m) birthdays.push({ slug: m[2], born: m[1], age: m[3] ? Number(m[3]) : null });
    }
  }
  return { events, birthdays };
}

// Parse `wiki agenda today --asof YYYY-MM-DD` output:
//   YYYY-MM-DD  [[slug]]
//   YYYY-MM-DD HH:MM  [[slug]]
// Returns only exact dated events from the agenda window. This is separate
// from parseAgendaOnThisDayOutput because `agenda --on` deliberately means
// "same MM-DD in any year" and is too broad for a daily schedule.
function parseAgendaWindowOutput(stdout) {
  const events = [];
  for (const raw of (stdout || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.startsWith('(')) continue;
    const m = line.match(/^\s*(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2})?(?:\s+\([^)]+\))?\s+\[\[([a-z0-9][a-z0-9-]*)\]\]/);
    if (m) events.push({ when: m[1], slug: m[2] });
  }
  return events;
}

function isDeliveredPastReminder(todo, date) {
  return !!(todo && todo.remind_at && todo.reminded_at && todo.due && todo.due < date);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Parse an ISO date (YYYY-MM-DD) as UTC midnight. We format in UTC throughout
// so a pure date never drifts by a day under a local timezone.
function isoToUTC(iso) { return new Date(`${iso}T00:00:00Z`); }
function fmtDayMon(iso) { const d = isoToUTC(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }
function fmtNiceDate(iso) {
  const d = isoToUTC(iso);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function daysBetween(fromIso, toIso) {
  return Math.round((isoToUTC(toIso) - isoToUTC(fromIso)) / 86400000);
}

// Slugs are internal keys; an email reader wants a name. Strip the dashes and
// capitalize the first letter. Lossy but far more readable than a raw slug,
// and we don't have a title for event/birthday pages at this layer.
function prettifySlug(slug) {
  const s = String(slug).replace(/-/g, ' ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Title-first todo line. The slug is omitted (it is noise in a human email);
// priority, when present, trails as a small tag.
function fmtTodoTitle(t) {
  return `- ${t.title}${t.priority ? ` [${t.priority}]` : ''}`;
}

// Overdue row: title, then an aging line ("3 days overdue (was 22 May)") so the
// urgency is legible at a glance rather than as a bare ISO due date.
function fmtOverdueRow(t, asof) {
  const title = fmtTodoTitle(t);
  if (!t.due) return title;
  const n = daysBetween(t.due, asof);
  const aging = n > 0
    ? `  ${n} day${n === 1 ? '' : 's'} overdue (was ${fmtDayMon(t.due)})`
    : `  was due ${fmtDayMon(t.due)}`;
  return `${title}\n${aging}`;
}

function fmtEventRow(e) { return `- ${prettifySlug(e.slug)}`; }

function fmtBirthdayRow(b) {
  return `- ${prettifySlug(b.slug)}${b.age != null ? ` (turns ${b.age})` : ''}`;
}

// Background ("ongoing") todo: open work that is neither overdue nor due today
// (future-dated, undated, or scheduled reminders). Title-first, with the due
// date as a small trailing tag so the horizon is legible at a glance.
function fmtBackgroundRow(t) {
  const tag = t.priority ? ` [${t.priority}]` : '';
  return `- ${t.title}${tag}${t.due ? ` (due ${fmtDayMon(t.due)})` : ''}`;
}

function capSection(rows, max = MAX_PER_SECTION) {
  if (rows.length <= max) return { shown: rows, omitted: 0 };
  return { shown: rows.slice(0, max), omitted: rows.length - max };
}

// Compose the email body. The two action sections (overdue, due today) always
// render, even when empty, so the channel stays trustworthy: a structured
// "nothing" still proves the cron fired. Events and birthdays are
// informational and shown only when present. A fully empty day collapses to a
// single clean-slate line.
function formatBrief({ date, overdue = [], dueToday = [], events = [], birthdays = [], background = [] }) {
  if (!isISODate(date)) {
    throw new Error('formatBrief: date must be YYYY-MM-DD');
  }
  const header = `Daily brief, ${fmtNiceDate(date)}`;
  const total = overdue.length + dueToday.length + events.length + birthdays.length + background.length;
  if (total === 0) {
    return `${header}\n\nClean slate. Nothing overdue, nothing due, no events, no birthdays.\n`;
  }
  const sections = [];

  // OVERDUE — always shown, oldest first.
  const overdueSorted = overdue.slice().sort((a, b) => (a.due || '').localeCompare(b.due || ''));
  const od = capSection(overdueSorted);
  sections.push(
    `OVERDUE (${overdue.length})${od.omitted ? `, showing ${od.shown.length}` : ''}\n`
    + (overdue.length ? od.shown.map((t) => fmtOverdueRow(t, date)).join('\n') : 'Nothing overdue.')
  );

  // DUE TODAY — always shown.
  const dt = capSection(dueToday);
  sections.push(
    `DUE TODAY (${dueToday.length})${dt.omitted ? `, showing ${dt.shown.length}` : ''}\n`
    + (dueToday.length ? dt.shown.map(fmtTodoTitle).join('\n') : 'Nothing due.')
  );

  if (events.length) {
    const { shown, omitted } = capSection(events);
    sections.push(`EVENTS (${events.length})${omitted ? `, showing ${shown.length}` : ''}\n${shown.map(fmtEventRow).join('\n')}`);
  }
  if (birthdays.length) {
    const { shown, omitted } = capSection(birthdays);
    sections.push(`BIRTHDAYS (${birthdays.length})${omitted ? `, showing ${shown.length}` : ''}\n${shown.map(fmtBirthdayRow).join('\n')}`);
  }

  // ONGOING — open work in the background: neither overdue nor due today
  // (future-dated, undated, or scheduled reminders). Informational, so shown
  // only when present; soonest due first, undated last.
  if (background.length) {
    const sorted = background.slice().sort((a, b) => {
      if (!a.due) return b.due ? 1 : 0;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
    const { shown, omitted } = capSection(sorted);
    sections.push(`ONGOING (${background.length})${omitted ? `, showing ${shown.length}` : ''}\n${shown.map(fmtBackgroundRow).join('\n')}`);
  }
  return `${header}\n\n${sections.join('\n\n')}\n`;
}

// One-line email subject that surfaces the actionable counts up front, e.g.
// "Daily brief: 2 overdue, 1 due (Mon 25 May)". Birthdays are included (socially
// time-sensitive); events are not (they vary in importance). A clear day reads
// "Daily brief: clear (Mon 25 May)".
function subjectFor({ date, overdue = [], dueToday = [], birthdays = [] }) {
  if (!isISODate(date)) {
    throw new Error('subjectFor: date must be YYYY-MM-DD');
  }
  const bits = [];
  if (overdue.length) bits.push(`${overdue.length} overdue`);
  if (dueToday.length) bits.push(`${dueToday.length} due`);
  if (birthdays.length) bits.push(`${birthdays.length} birthday${birthdays.length === 1 ? '' : 's'}`);
  const summary = bits.length ? bits.join(', ') : 'clear';
  const d = isoToUTC(date);
  return `Daily brief: ${summary} (${WEEKDAYS[d.getUTCDay()]} ${fmtDayMon(date)})`;
}

// "Today" (YYYY-MM-DD) in an IANA timezone. Uses Intl.formatToParts rather than
// Date#toISOString (which is ALWAYS UTC) so the brief's date is correct in the
// user's zone — firing at 07:00 SGT is 23:00 UTC the day before, and the UTC
// date would list yesterday's todos/events. `tz` undefined → runtime default.
function localDate(d, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = {
  parseTodoLine,
  parseTodoOutput,
  parseAgendaOnThisDayOutput,
  parseAgendaWindowOutput,
  isDeliveredPastReminder,
  formatBrief,
  subjectFor,
  localDate,
  MAX_PER_SECTION,
};
