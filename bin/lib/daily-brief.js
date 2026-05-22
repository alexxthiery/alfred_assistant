// daily-brief.js — pure parsers + formatter for the daily morning brief.
//
// No fs, no spawn — kept pure so unit tests can lock the exact wire formats
// of the three upstream wiki verbs (`wiki todo list --overdue/--due-today`
// and `wiki agenda --on MM-DD`) and the resulting email body.
//
// The orchestrator (bin/daily-brief) spawns the three subprocesses, hands
// their stdout strings to the parsers below, then calls formatBrief().

'use strict';

const { isISODate } = require('./date.js');

const MAX_PER_SECTION = 5;

// Parse one line of `wiki todo list` output.
//   "<status>\t<slug>\t<title>\t<dueStr>\t<pStr>"
// dueStr is either empty or "due YYYY-MM-DD"; pStr is either empty or "[priority]".
// Returns null for blank / "(no matching todos)" lines.
function parseTodoLine(line) {
  if (!line || line.startsWith('(') || /^\s*$/.test(line)) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [status, slug, title, dueStr = '', pStr = ''] = parts;
  const dueMatch = dueStr.match(/^due (\d{4}-\d{2}-\d{2})$/);
  const prioMatch = pStr.match(/^\[([a-z]+)\]$/);
  return {
    status,
    slug,
    title,
    due: dueMatch ? dueMatch[1] : null,
    priority: prioMatch ? prioMatch[1] : null,
  };
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

function fmtTodoRow(t) {
  const parts = [t.slug, t.title];
  if (t.due) parts.push(`due ${t.due}`);
  if (t.priority) parts.push(`[${t.priority}]`);
  return `  ${parts.join(' — ')}`;
}

function fmtEventRow(e) { return `  ${e.when} — [[${e.slug}]]`; }

function fmtBirthdayRow(b) {
  const age = b.age != null ? ` (turns ${b.age})` : '';
  return `  ${b.born} — [[${b.slug}]]${age}`;
}

function capSection(rows, max = MAX_PER_SECTION) {
  if (rows.length <= max) return { shown: rows, omitted: 0 };
  return { shown: rows.slice(0, max), omitted: rows.length - max };
}

// Compose the email body. All four data lists may be empty; if all are
// empty we return the "clean slate" line so the channel keeps being
// trustworthy (an absent email is indistinguishable from a broken cron).
function formatBrief({ date, overdue = [], dueToday = [], events = [], birthdays = [] }) {
  if (!isISODate(date)) {
    throw new Error('formatBrief: date must be YYYY-MM-DD');
  }
  const total = overdue.length + dueToday.length + events.length + birthdays.length;
  if (total === 0) {
    return `Daily brief — ${date}\n\nClean slate today. Nothing overdue, nothing due, no events, no birthdays.\n`;
  }
  const sections = [];
  if (overdue.length) {
    const { shown, omitted } = capSection(overdue.slice().sort((a, b) => (a.due || '').localeCompare(b.due || '')));
    sections.push(`Overdue (${overdue.length})${omitted ? `, showing ${shown.length}` : ''}:\n${shown.map(fmtTodoRow).join('\n')}`);
  }
  if (dueToday.length) {
    const { shown, omitted } = capSection(dueToday);
    sections.push(`Due today (${dueToday.length})${omitted ? `, showing ${shown.length}` : ''}:\n${shown.map(fmtTodoRow).join('\n')}`);
  }
  if (events.length) {
    const { shown, omitted } = capSection(events);
    sections.push(`Today's events (${events.length})${omitted ? `, showing ${shown.length}` : ''}:\n${shown.map(fmtEventRow).join('\n')}`);
  }
  if (birthdays.length) {
    const { shown, omitted } = capSection(birthdays);
    sections.push(`Birthdays today (${birthdays.length})${omitted ? `, showing ${shown.length}` : ''}:\n${shown.map(fmtBirthdayRow).join('\n')}`);
  }
  return `Daily brief — ${date}\n\n${sections.join('\n\n')}\n`;
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

module.exports = { parseTodoLine, parseTodoOutput, parseAgendaOnThisDayOutput, formatBrief, localDate, MAX_PER_SECTION };
