// jobs.js — the scheduled-job manifest + pure parsing/comparison logic for
// `wiki jobs` and `wiki jobs --check`.
//
// The manifest (JOBS) is the canonical list of jobs the assistant expects the OS
// scheduler to run. The CLI never installs or edits schedules — launchd/cron
// stay the executor; this module only describes the expected set and compares
// it against what is actually installed, so drift surfaces.
//
// Everything here is pure: no fs, no exec. The command module reads the
// installed plists / crontab and hands the text in. `schedule` objects are one
// of { kind:'calendar', hour, minute, weekday? } or { kind:'interval', seconds }
// or { kind:'unknown', raw }.

'use strict';

const LABEL_SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// Canonical job set, without the assistant-specific launchd namespace.
// `wrapper` is the basename the installed entry's command must reference
// (catches stale paths after a repo move). `schedule` is the DEFAULT cadence; a
// user running a custom time is reported as 'custom', not an error.
const JOB_SPECS = [
  {
    name: 'daily-brief',
    wrapper: 'run-daily-brief.sh',
    schedule: { kind: 'calendar', hour: 7, minute: 0 },
    needsAgent: false,
    requiresVaultBinding: true,
    purpose: 'Deterministic morning brief (overdue + due-today todos, events) emailed/Telegrammed.',
  },
  {
    name: 'daily-checkin-morning',
    wrapper: 'run-daily-checkin.sh',
    requiredArgs: ['--slot', 'morning'],
    schedule: { kind: 'calendar', hour: 7, minute: 0 },
    needsAgent: true,
    requiresVaultBinding: true,
    purpose: 'Headless agent sends a short, memory-aware morning Telegram check-in.',
  },
  {
    name: 'daily-checkin-afternoon',
    wrapper: 'run-daily-checkin.sh',
    requiredArgs: ['--slot', 'afternoon'],
    schedule: { kind: 'calendar', hour: 17, minute: 0 },
    needsAgent: true,
    requiresVaultBinding: true,
    purpose: 'Headless agent sends a short, memory-aware afternoon Telegram check-in.',
  },
  {
    name: 'daily-checkin-evening',
    wrapper: 'run-daily-checkin.sh',
    requiredArgs: ['--slot', 'evening'],
    schedule: { kind: 'calendar', hour: 22, minute: 0 },
    needsAgent: true,
    requiresVaultBinding: true,
    purpose: 'Headless agent sends a short, memory-aware evening Telegram check-in.',
  },
  {
    name: 'reminder-dispatch',
    wrapper: 'run-reminder-dispatch.sh',
    schedule: { kind: 'interval', seconds: 900 },
    needsAgent: false,
    requiresVaultBinding: true,
    purpose: 'Fires vault todos whose remind_at is due; idempotent. Silent when nothing is due.',
  },
  {
    name: 'vault-backup-push',
    wrapper: 'vault-backup-push.sh',
    schedule: { kind: 'calendar', hour: 22, minute: 0 },
    needsAgent: false,
    requiresVaultArg: true,
    purpose: 'Pushes the vault to its git origin if ahead. For a local vault this IS the backup.',
  },
  {
    name: 'weekly-review',
    wrapper: 'run-weekly-review.sh',
    schedule: { kind: 'calendar', hour: 9, minute: 0, weekday: 1 },
    needsAgent: true,
    requiresVaultBinding: true,
    purpose: 'Headless agent reviews the vault and emails a three-section digest (Mondays).',
  },
  {
    name: 'email-review',
    wrapper: 'run-email-review.sh',
    schedule: { kind: 'calendar', hour: 10, minute: 0 },
    needsAgent: true,
    requiresVaultBinding: true,
    purpose: 'Wrapper scans recent Gmail via email-review, then headless agent reviews the report and sends only actionable questions/updates to Telegram.',
  },
  {
    name: 'conversation-ingest',
    wrapper: 'run-conversation-ingest.sh',
    schedule: { kind: 'calendar', hour: 21, minute: 30 },
    needsAgent: true,
    requiresVaultBinding: true,
    purpose: 'Headless agent conservatively ingests durable facts from private conversation mirrors through wiki.',
  },
  {
    name: 'docker-watchdog',
    wrapper: 'docker-watchdog',
    schedule: { kind: 'interval', seconds: 120 },
    needsAgent: false,
    purpose: 'Restarts Docker / the OneCLI gateway when the engine wedges, so the agent runtime can spawn containers. macOS only.',
  },
];

function assertLabelSlug(labelSlug) {
  if (!LABEL_SLUG_RE.test(labelSlug || '')) {
    throw new Error(`invalid assistant label '${labelSlug}' (use lowercase letters, digits, hyphens)`);
  }
}

function jobsForLabel(labelSlug = 'alfred') {
  assertLabelSlug(labelSlug);
  return JOB_SPECS.map((job) => ({ ...job, label: `com.${labelSlug}.${job.name}` }));
}

// Backward-compatible default manifest for the primary assistant.
const JOBS = jobsForLabel('alfred');

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

// Parse a (simple, known-format) launchd plist into { label, command, args, schedule }.
// Returns null if it is not a parseable assistant plist. Regex-based on purpose:
// these plists are template/tool-generated with a flat, predictable shape, and
// a zero-dep XML parser would be overkill.
function parsePlist(xml) {
  if (typeof xml !== 'string' || !xml.includes('<plist')) return null;
  const label = (xml.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
  if (!label) return null;
  // First ProgramArguments string is the executable/script.
  const argsBlock = (xml.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1] || '';
  const args = [];
  const argRe = /<string>([^<]+)<\/string>/g;
  let argMatch;
  while ((argMatch = argRe.exec(argsBlock)) !== null) args.push(argMatch[1]);
  const command = args[0] || '';
  const envBlock = (xml.match(/<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/) || [])[1] || '';
  const environment = {};
  if (envBlock) {
    const re = /<key>\s*([^<]+)\s*<\/key>\s*<string>([^<]*)<\/string>/g;
    let m;
    while ((m = re.exec(envBlock)) !== null) environment[m[1]] = m[2];
  }
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
  return { label, command, args, schedule, environment };
}

// Parse a crontab dump into [{ schedule, command, raw }]. Skips comments/blanks
// and @-shortcuts (not used by assistant jobs).
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

function parseLeadingEnv(command) {
  const environment = {};
  if (typeof command !== 'string') return environment;
  for (const part of command.trim().split(/\s+/)) {
    const m = part.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (!m) break;
    environment[m[1]] = m[2];
  }
  return environment;
}

// Best-effort cron-field -> schedule object. Handles the two shapes this project uses:
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
function evaluateVaultBinding(job, installed, opts) {
  if (!job.requiresVaultBinding) return null;
  const expectedVault = opts.expectedVault;
  const expectedLabel = opts.labelSlug || 'alfred';
  if (!expectedVault) return null;

  const env = installed.environment || parseLeadingEnv(installed.command || '');
  if (!env.ALFRED_VAULT) return 'missing ALFRED_VAULT in scheduler environment';
  if (!env.ALFRED_ASSISTANT_LABEL) return 'missing ALFRED_ASSISTANT_LABEL in scheduler environment';
  if (!env.ENV_FILE) return 'missing ENV_FILE in scheduler environment';
  if (env.ALFRED_VAULT !== expectedVault) {
    return `ALFRED_VAULT=${env.ALFRED_VAULT}, expected ${expectedVault}`;
  }
  if (env.ALFRED_ASSISTANT_LABEL !== expectedLabel) {
    return `ALFRED_ASSISTANT_LABEL=${env.ALFRED_ASSISTANT_LABEL}, expected ${expectedLabel}`;
  }
  const privatePrefix = `${expectedVault}/.alfred/private/`;
  if (!env.ENV_FILE.startsWith(privatePrefix)) {
    return `ENV_FILE=${env.ENV_FILE}, expected under ${privatePrefix}`;
  }
  return null;
}

function evaluateVaultArgument(job, installed, opts) {
  if (!job.requiresVaultArg) return null;
  const expectedVault = opts.expectedVault;
  if (!expectedVault) return null;
  const args = Array.isArray(installed.args) ? installed.args : [];
  if (args.includes(expectedVault)) return null;
  const commandParts = String(installed.command || '').trim().split(/\s+/).filter(Boolean);
  if (commandParts.includes(expectedVault)) return null;
  return `missing vault argument ${expectedVault}`;
}

function hasRequiredArgSequence(args, required) {
  if (!required || !required.length) return true;
  if (!Array.isArray(args) || args.length < required.length) return false;
  for (let i = 0; i <= args.length - required.length; i += 1) {
    let ok = true;
    for (let j = 0; j < required.length; j += 1) {
      if (args[i + j] !== required[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function evaluateRequiredArgs(job, installed) {
  if (!job.requiredArgs || !job.requiredArgs.length) return null;
  const args = Array.isArray(installed.args) && installed.args.length
    ? installed.args
    : String(installed.command || '').trim().split(/\s+/).filter(Boolean);
  if (hasRequiredArgSequence(args, job.requiredArgs)) return null;
  return `missing required args: ${job.requiredArgs.join(' ')}`;
}

function evaluateJob(job, installed, opts = {}) {
  if (!installed) return { status: 'missing', detail: 'no launchd/cron entry found' };
  if (!installed.command || !installed.command.includes(job.wrapper)) {
    return {
      status: 'drift',
      detail: `${installed.source} entry runs "${installed.command || '(none)'}", expected to reference ${job.wrapper}`,
    };
  }
  const argDrift = evaluateRequiredArgs(job, installed);
  if (argDrift) {
    return { status: 'drift', detail: `${installed.source} entry has invalid arguments: ${argDrift}` };
  }
  const bindingDrift = evaluateVaultBinding(job, installed, opts);
  if (bindingDrift) {
    return { status: 'drift', detail: `${installed.source} entry has invalid vault binding: ${bindingDrift}` };
  }
  const vaultArgDrift = evaluateVaultArgument(job, installed, opts);
  if (vaultArgDrift) {
    return { status: 'drift', detail: `${installed.source} entry has invalid vault target: ${vaultArgDrift}` };
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
  JOB_SPECS,
  jobsForLabel,
  scheduleToText,
  schedulesEqual,
  parsePlist,
  parseCrontab,
  parseLeadingEnv,
  cronToSchedule,
  hasRequiredArgSequence,
  evaluateJob,
};
