// reminder-dispatch.js — pure parser + filter + formatter for the reminder
// dispatcher.
//
// No fs, no spawn — kept pure so unit tests can lock the wire format of
// `wiki todo list --reminders` and the firing logic. The orchestrator
// (bin/reminder-dispatch) spawns the wiki subprocess, hands its stdout here,
// fires the due ones to stdout, and stamps each via `wiki patch --reminded_at`.
//
// A reminder = a todo page with a `remind_at` datetime. It fires when:
//   1. remind_at <= now (compared as epoch, so timezone offsets are honored), and
//   2. it carries no `reminded_at` stamp (idempotency — fired reminders are
//      stamped so a re-run never double-sends), and
//   3. its `notify` list includes "telegram" (an empty/absent list = both
//      channels, so it fires).
// A reminder is never lost: if the cron was down, it fires (late) on the next
// run. Late beats missed for v1 (one-shot reminders).

'use strict';

// Parse one line of `wiki todo list --reminders` output. Columns (tab-sep):
//   0 status  1 slug  2 title  3 dueStr  4 pStr  5 remindStr  6 remindedStr  7 notifyStr
// remindStr   = "" | "remind <ISO>"
// remindedStr = "" | "reminded <ISO>"
// notifyStr   = "" | "notify <csv>"
// Returns null for blank / "(no matching todos)" lines.
function parseReminderLine(line) {
  if (!line || line.startsWith('(') || /^\s*$/.test(line)) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [status, slug, title, , , remindStr = '', remindedStr = '', notifyStr = ''] = parts;
  const remindMatch = remindStr.match(/^remind (.+)$/);
  const remindedMatch = remindedStr.match(/^reminded (.+)$/);
  const notifyMatch = notifyStr.match(/^notify (.+)$/);
  return {
    status,
    slug,
    title,
    remind_at: remindMatch ? remindMatch[1].trim() : null,
    reminded_at: remindedMatch ? remindedMatch[1].trim() : null,
    notify: notifyMatch ? notifyMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

function parseReminderRows(stdout) {
  return (stdout || '').split('\n').map(parseReminderLine).filter(Boolean);
}

// Channels default to both when the notify list is empty/absent.
function notifiesTelegram(row) {
  return !row.notify || row.notify.length === 0 || row.notify.includes('telegram');
}

// Filter to reminders due to fire now. `now` is an ISO datetime string (the
// orchestrator passes the current time, or a fixed --asof for determinism).
// Comparison is by epoch (Date.parse) so a remind_at with a +08:00 offset is
// compared correctly against a now in any offset.
function filterDue(rows, now) {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new Error(`filterDue: invalid now "${now}"`);
  return rows.filter((r) => {
    if (!r.remind_at) return false;
    if (r.reminded_at) return false;
    if (!notifiesTelegram(r)) return false;
    const t = Date.parse(r.remind_at);
    if (Number.isNaN(t)) return false; // malformed remind_at never fires
    return t <= nowMs;
  });
}

// Compose the Telegram payload: one short line per due reminder. Empty list
// returns "" so the orchestrator pipes nothing and telegram-send is a no-op.
function formatTelegram(rows) {
  if (!rows.length) return '';
  return rows.map((r) => `Reminder: ${r.title}`).join('\n');
}

module.exports = {
  parseReminderLine,
  parseReminderRows,
  filterDue,
  formatTelegram,
  notifiesTelegram,
};
