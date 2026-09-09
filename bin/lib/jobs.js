// jobs.js — the scheduled-job manifest + pure parsing/comparison logic for
// `wiki jobs` and `wiki jobs --check`.
//
// The manifest (JOBS) is the canonical list of jobs Alfred expects the OS
// scheduler to run. The CLI never installs or edits schedules — launchd/cron
// stay the executor; this module only describes the expected set and compares
// it against what is actually installed, so drift surfaces.
//
// Everything here is pure: no fs, no exec. The command module reads the
// installed plists / crontab and hands the text in. `schedule` objects are one
// of { kind:'calendar', hour, minute, weekday? } or { kind:'interval', seconds }
// or { kind:'unknown', raw }.

'use strict';

// Canonical job set. `wrapper` is the basename the installed entry's command
// must reference (catches stale paths after a repo move). `schedule` is the
// DEFAULT cadence; a user running a custom time is reported as 'custom', not an
// error. `label` is the launchd Label (also the conventional cron-comment tag).
const JOBS = [
  {
    name: 'daily-brief',
    label: 'com.alfred.daily-brief',
    wrapper: 'run-daily-brief.sh',
    schedule: { kind: 'calendar', hour: 7, minute: 0 },
    needsAgent: false,
    purpose: 'Deterministic morning brief (overdue + due-today todos, events) emailed/Telegrammed.',
  },
  {
    name: 'reminder-dispatch',
    label: 'com.alfred.reminder-dispatch',
    wrapper: 'run-reminder-dispatch.sh',
    schedule: { kind: 'interval', seconds: 900 },
    needsAgent: false,
    purpose: 'Fires vault todos whose remind_at is due; idempotent. Silent when nothing is due.',
  },
  {
    name: 'vault-backup-push',
    label: 'com.alfred.vault-backup-push',
    wrapper: 'vault-backup-push.sh',
    schedule: { kind: 'calendar', hour: 22, minute: 0 },
    needsAgent: false,
    purpose: 'Pushes the vault to its git origin if ahead. For a local vault this IS the backup.',
  },
  {
    name: 'weekly-review',
    label: 'com.alfred.weekly-review',
    wrapper: 'run-weekly-review.sh',
    schedule: { kind: 'calendar', hour: 9, minute: 0, weekday: 1 },
    needsAgent: true,
    purpose: 'Headless agent reviews the vault and emails a three-section digest (Mondays).',
  },
  {
    name: 'email-review',
    label: 'com.alfred.email-review',
    wrapper: 'run-email-review.sh',
    schedule: { kind: 'calendar', hour: 10, minute: 0 },
    needsAgent: true,
    purpose: 'Headless agent reviews recent Gmail via email-review and sends only actionable questions/updates to Telegram.',
  },
  {
    name: 'docker-watchdog',
    label: 'com.alfred.docker-watchdog',
    wrapper: 'docker-watchdog',
    schedule: { kind: 'interval', seconds: 120 },
    needsAgent: false,
    purpose: 'Restarts Docker / the OneCLI gateway when the engine wedges, so the agent runtime can spawn containers. macOS only.',
  },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Human-readable cadence string for a schedule object.
function scheduleToText(s) {
  if (!s || !s.kind) return '(unknown)';
  if (s.kind === 'interval') {
    const sec = s.seconds;
    if (sec % 3600 === 0) return `every ${sec / 3600}h`;
    if (sec % 60 === 0) return `every ${sec / 60} min`;
    return `every ${sec}s`;
  }
  if (s.kind === 'calendar') {
    const hh = String(s.hour ?? 0).padStart(2, '0');
    const mm = String(s.minute ?? 0).padStart(2, '0');
    const when = `${hh}:${mm}`;
    if (s.weekday === undefined || s.weekday === null) return `${when} daily`;
    const d = DAYS[s.weekday % 7] || `weekday ${s.weekday}`;
    return `${d} ${when}`;
  }
  return s.raw ? `(unparsed: ${s.raw})` : '(unknown)';
}

function schedulesEqual(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'interval') return a.seconds === b.seconds;
  if (a.kind === 'calendar') {
    const wa = a.weekday ?? null;
    const wb = b.weekday ?? null;
    return (a.hour ?? 0) === (b.hour ?? 0) && (a.minute ?? 0) === (b.minute ?? 0) && wa === wb;
  }
  return false;
}

// Parse a (simple, known-format) launchd plist into { label, command, schedule }.
// Returns null if it is not a parseable Alfred plist. Regex-based on purpose:
// these plists are template/tool-generated with a flat, predictable shape, and
// a zero-dep XML parser would be overkill.
function parsePlist(xml) {
  if (typeof xml !== 'string' || !xml.includes('<plist')) return null;
  const label = (xml.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
  if (!label) return null;
  // First ProgramArguments string is the executable/script.
  const argsBlock = (xml.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1] || '';
  const command = (argsBlock.match(/<string>([^<]+)<\/string>/) || [])[1] || '';
  let schedule = { kind: 'unknown', raw: '' };
  const interval = xml.match(/<key>\s*StartInterval\s*<\/key>\s*<integer>(\d+)<\/integer>/);
  const calBlock = xml.match(/<key>\s*StartCalendarInterval\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (interval) {
    schedule = { kind: 'interval', seconds: parseInt(interval[1], 10) };
  } else if (calBlock) {
    const grab = (k) => {
      const m = calBlock[1].match(new RegExp(`<key>\\s*${k}\\s*<\\/key>\\s*<integer>(\\d+)<\\/integer>`));
      return m ? parseInt(m[1], 10) : undefined;
    };
    schedule = { kind: 'calendar', hour: grab('Hour') ?? 0, minute: grab('Minute') ?? 0 };
    const wd = grab('Weekday');
    if (wd !== undefined) schedule.weekday = wd;
  }
  return { label, command, schedule };
}

// Parse a crontab dump into [{ schedule, command, raw }]. Skips comments/blanks
// and @-shortcuts (not used by Alfred's jobs).
function parseCrontab(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('@')) continue;
    const m = t.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const [, min, hour, dom, mon, dow, command] = m;
    out.push({ schedule: cronToSchedule(min, hour, dom, mon, dow), command, raw: t });
  }
  return out;
}

// Best-effort cron-field -> schedule object. Handles the two shapes Alfred uses:
// a fixed daily/weekly time (`0 7 * * *`, `0 9 * * 1`) and a step interval
// (`*/15 * * * *`). Anything else is { kind:'unknown', raw }.
function cronToSchedule(min, hour, dom, mon, dow) {
  const raw = `${min} ${hour} ${dom} ${mon} ${dow}`;
  const stepMin = min.match(/^\*\/(\d+)$/);
  if (stepMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { kind: 'interval', seconds: parseInt(stepMin[1], 10) * 60 };
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    const sched = { kind: 'calendar', hour: parseInt(hour, 10), minute: parseInt(min, 10) };
    if (/^\d+$/.test(dow)) sched.weekday = parseInt(dow, 10) % 7;
    return sched;
  }
  return { kind: 'unknown', raw };
}

// Compare a manifest job against what was found installed (or null).
// Returns { status, detail }:
//   'ok'      installed, points at the right wrapper, default schedule
//   'custom'  installed + right wrapper, but a non-default schedule (fine)
//   'missing' no installed entry found (informational — may be intentional)
//   'drift'   installed but the command does not reference the expected wrapper
//             (actionable: stale path or wrong target) -> the only failure
function evaluateJob(job, installed) {
  if (!installed) return { status: 'missing', detail: 'no launchd/cron entry found' };
  if (!installed.command || !installed.command.includes(job.wrapper)) {
    return {
      status: 'drift',
      detail: `${installed.source} entry runs "${installed.command || '(none)'}", expected to reference ${job.wrapper}`,
    };
  }
  if (!schedulesEqual(installed.schedule, job.schedule)) {
    return {
      status: 'custom',
      detail: `scheduled ${scheduleToText(installed.schedule)} (default ${scheduleToText(job.schedule)})`,
    };
  }
  return { status: 'ok', detail: `${installed.source}, ${scheduleToText(installed.schedule)}` };
}

module.exports = {
  JOBS,
  scheduleToText,
  schedulesEqual,
  parsePlist,
  parseCrontab,
  cronToSchedule,
  evaluateJob,
};
