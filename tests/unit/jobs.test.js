// Unit tests for bin/lib/jobs.js — the scheduled-job manifest + pure
// plist/crontab parsing and manifest-vs-installed comparison. No fs/exec here;
// the command module owns those.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  JOBS,
  jobsForLabel,
  scheduleToText,
  schedulesEqual,
  parsePlist,
  parseCrontab,
  parseLeadingEnv,
  cronToSchedule,
  evaluateJob,
} = require('../../bin/lib/jobs.js');

test('JOBS manifest: every job has the fields the verb and validator rely on', () => {
  assert.ok(JOBS.length >= 4);
  for (const j of JOBS) {
    assert.ok(j.name && j.label && j.wrapper && j.schedule && j.purpose, `incomplete job: ${j.name}`);
    assert.match(j.label, /^com\.alfred\./);
    assert.ok(['calendar', 'interval'].includes(j.schedule.kind));
  }
});

test('jobsForLabel: namespaces launchd labels per assistant without changing job contracts', () => {
  const child = jobsForLabel('child');
  assert.equal(child.length, JOBS.length);
  assert.equal(child.find((j) => j.name === 'daily-brief').label, 'com.child.daily-brief');
  assert.equal(child.find((j) => j.name === 'email-review').label, 'com.child.email-review');
  assert.equal(child.find((j) => j.name === 'daily-brief').wrapper, JOBS.find((j) => j.name === 'daily-brief').wrapper);
  assert.deepEqual(child.find((j) => j.name === 'email-review').schedule, JOBS.find((j) => j.name === 'email-review').schedule);
});

test('jobsForLabel: rejects labels that are unsafe as launchd namespaces', () => {
  assert.throws(() => jobsForLabel('Child'), /invalid assistant label/);
  assert.throws(() => jobsForLabel('../child'), /invalid assistant label/);
  assert.throws(() => jobsForLabel(''), /invalid assistant label/);
});

test('JOBS manifest: docker-watchdog is registered as a 2-min interval job', () => {
  const wd = JOBS.find((j) => j.name === 'docker-watchdog');
  assert.ok(wd, 'docker-watchdog job must be in the manifest so `wiki jobs --check` tracks it');
  assert.equal(wd.label, 'com.alfred.docker-watchdog');
  assert.equal(wd.wrapper, 'docker-watchdog');
  assert.deepEqual(wd.schedule, { kind: 'interval', seconds: 120 });
  assert.equal(wd.needsAgent, false);
  assert.equal(scheduleToText(wd.schedule), 'every 2 min');
});

test('JOBS manifest: email-review is registered as a 10:00 daily agentic job', () => {
  const job = JOBS.find((j) => j.name === 'email-review');
  assert.ok(job, 'email-review job must be in the manifest so `wiki jobs --check` tracks it');
  assert.equal(job.label, 'com.alfred.email-review');
  assert.equal(job.wrapper, 'run-email-review.sh');
  assert.deepEqual(job.schedule, { kind: 'calendar', hour: 10, minute: 0 });
  assert.equal(job.needsAgent, true);
  assert.equal(scheduleToText(job.schedule), '10:00 daily');
});

test('JOBS manifest: weekly-review is registered as a Monday 09:00 agentic job', () => {
  const job = JOBS.find((j) => j.name === 'weekly-review');
  assert.ok(job, 'weekly-review job must be in the manifest so `wiki jobs --check` tracks it');
  assert.equal(job.label, 'com.alfred.weekly-review');
  assert.equal(job.wrapper, 'run-weekly-review.sh');
  assert.deepEqual(job.schedule, { kind: 'calendar', hour: 9, minute: 0, weekday: 1 });
  assert.equal(job.needsAgent, true);
  assert.equal(scheduleToText(job.schedule), 'Mon 09:00');
});

test('scheduleToText: calendar daily, calendar weekday, interval', () => {
  assert.equal(scheduleToText({ kind: 'calendar', hour: 7, minute: 0 }), '07:00 daily');
  assert.equal(scheduleToText({ kind: 'calendar', hour: 9, minute: 5, weekday: 1 }), 'Mon 09:05');
  assert.equal(scheduleToText({ kind: 'interval', seconds: 900 }), 'every 15 min');
  assert.equal(scheduleToText({ kind: 'interval', seconds: 3600 }), 'every 1h');
});

test('schedulesEqual: matches on kind + fields, weekday distinguishes', () => {
  assert.ok(schedulesEqual({ kind: 'calendar', hour: 7, minute: 0 }, { kind: 'calendar', hour: 7, minute: 0 }));
  assert.ok(!schedulesEqual({ kind: 'calendar', hour: 7, minute: 0 }, { kind: 'calendar', hour: 8, minute: 0 }));
  assert.ok(!schedulesEqual({ kind: 'calendar', hour: 9, minute: 0, weekday: 1 }, { kind: 'calendar', hour: 9, minute: 0 }));
  assert.ok(schedulesEqual({ kind: 'interval', seconds: 900 }, { kind: 'interval', seconds: 900 }));
  assert.ok(!schedulesEqual({ kind: 'interval', seconds: 900 }, { kind: 'calendar', hour: 0, minute: 0 }));
});

test('parsePlist: StartCalendarInterval -> calendar schedule + command', () => {
  const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>Label</key><string>com.alfred.daily-brief</string>
    <key>ProgramArguments</key><array><string>/path/to/run-daily-brief.sh</string></array>
    <key>EnvironmentVariables</key><dict>
      <key>ALFRED_VAULT</key><string>/vault</string>
      <key>ALFRED_ASSISTANT_LABEL</key><string>alfred</string>
      <key>ENV_FILE</key><string>/vault/.alfred/private/env</string>
    </dict>
    <key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    </dict></plist>`;
  const p = parsePlist(xml);
  assert.equal(p.label, 'com.alfred.daily-brief');
  assert.equal(p.command, '/path/to/run-daily-brief.sh');
  assert.deepEqual(p.args, ['/path/to/run-daily-brief.sh']);
  assert.deepEqual(p.environment, {
    ALFRED_VAULT: '/vault',
    ALFRED_ASSISTANT_LABEL: 'alfred',
    ENV_FILE: '/vault/.alfred/private/env',
  });
  assert.deepEqual(p.schedule, { kind: 'calendar', hour: 7, minute: 0 });
});

test('parsePlist: StartInterval -> interval; Weekday captured', () => {
  const interval = parsePlist(`<plist><dict><key>Label</key><string>com.alfred.reminder-dispatch</string>
    <key>ProgramArguments</key><array><string>/x/run-reminder-dispatch.sh</string></array>
    <key>StartInterval</key><integer>900</integer></dict></plist>`);
  assert.deepEqual(interval.schedule, { kind: 'interval', seconds: 900 });

  const weekly = parsePlist(`<plist><dict><key>Label</key><string>com.alfred.weekly-review</string>
    <key>ProgramArguments</key><array><string>/x/run-weekly-review.sh</string></array>
    <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>1</integer></dict></dict></plist>`);
  assert.deepEqual(weekly.schedule, { kind: 'calendar', hour: 9, minute: 0, weekday: 1 });
});

test('parsePlist: non-plist or label-less input returns null', () => {
  assert.equal(parsePlist('not xml'), null);
  assert.equal(parsePlist('<plist><dict></dict></plist>'), null);
  assert.equal(parsePlist(null), null);
});

test('cronToSchedule: step interval, daily time, weekly time, unknown', () => {
  assert.deepEqual(cronToSchedule('*/15', '*', '*', '*', '*'), { kind: 'interval', seconds: 900 });
  assert.deepEqual(cronToSchedule('0', '7', '*', '*', '*'), { kind: 'calendar', hour: 7, minute: 0 });
  assert.deepEqual(cronToSchedule('0', '9', '*', '*', '1'), { kind: 'calendar', hour: 9, minute: 0, weekday: 1 });
  assert.equal(cronToSchedule('0', '0', '1', '*', '*').kind, 'unknown');
});

test('parseCrontab: parses command lines, skips comments/blanks/@shortcuts', () => {
  const out = parseCrontab([
    '# a comment',
    '',
    '@reboot /x/foo.sh',
    '0 7 * * * ALFRED_VAULT=/v /path/run-daily-brief.sh',
    '*/15 * * * * /path/run-reminder-dispatch.sh',
  ].join('\n'));
  assert.equal(out.length, 2);
  assert.match(out[0].command, /run-daily-brief\.sh/);
  assert.deepEqual(out[0].schedule, { kind: 'calendar', hour: 7, minute: 0 });
  assert.deepEqual(out[1].schedule, { kind: 'interval', seconds: 900 });
});

test('parseLeadingEnv: extracts simple leading cron env assignments', () => {
  assert.deepEqual(parseLeadingEnv('ALFRED_VAULT=/vault ALFRED_ASSISTANT_LABEL=alfred ENV_FILE=/vault/.alfred/private/env /x/run-daily-brief.sh'), {
    ALFRED_VAULT: '/vault',
    ALFRED_ASSISTANT_LABEL: 'alfred',
    ENV_FILE: '/vault/.alfred/private/env',
  });
  assert.deepEqual(parseLeadingEnv('/x/run-daily-brief.sh'), {});
});

test('evaluateJob: ok when installed at default schedule with right wrapper', () => {
  const job = JOBS.find((j) => j.name === 'daily-brief');
  const r = evaluateJob(job, {
    source: 'launchd',
    command: '/x/run-daily-brief.sh',
    schedule: { kind: 'calendar', hour: 7, minute: 0 },
    environment: {
      ALFRED_VAULT: '/vault',
      ALFRED_ASSISTANT_LABEL: 'alfred',
      ENV_FILE: '/vault/.alfred/private/env',
    },
  }, { expectedVault: '/vault', labelSlug: 'alfred' });
  assert.equal(r.status, 'ok');
});

test('evaluateJob: custom when right wrapper but non-default schedule', () => {
  const job = JOBS.find((j) => j.name === 'daily-brief');
  const r = evaluateJob(job, {
    source: 'launchd',
    command: '/x/run-daily-brief.sh',
    schedule: { kind: 'calendar', hour: 8, minute: 30 },
    environment: {
      ALFRED_VAULT: '/vault',
      ALFRED_ASSISTANT_LABEL: 'alfred',
      ENV_FILE: '/vault/.alfred/private/env',
    },
  }, { expectedVault: '/vault', labelSlug: 'alfred' });
  assert.equal(r.status, 'custom');
  assert.match(r.detail, /08:30/);
});

test('evaluateJob: missing when nothing installed', () => {
  const job = JOBS.find((j) => j.name === 'weekly-review');
  assert.equal(evaluateJob(job, null).status, 'missing');
});

test('evaluateJob: drift when installed entry points at the wrong target', () => {
  const job = JOBS.find((j) => j.name === 'daily-brief');
  const r = evaluateJob(job, { source: 'launchd', command: '/old/path/some-other.sh', schedule: { kind: 'calendar', hour: 7, minute: 0 } });
  assert.equal(r.status, 'drift');
  assert.match(r.detail, /run-daily-brief\.sh/);
});

test('evaluateJob: drift when a bound job uses an env file outside the vault private dir', () => {
  const job = JOBS.find((j) => j.name === 'daily-brief');
  const r = evaluateJob(job, {
    source: 'launchd',
    command: '/x/run-daily-brief.sh',
    schedule: { kind: 'calendar', hour: 7, minute: 0 },
    environment: {
      ALFRED_VAULT: '/vault',
      ALFRED_ASSISTANT_LABEL: 'alfred',
      ENV_FILE: '/external/shared.env',
    },
  }, { expectedVault: '/vault', labelSlug: 'alfred' });
  assert.equal(r.status, 'drift');
  assert.match(r.detail, /invalid vault binding/);
  assert.match(r.detail, /expected under \/vault\/\.alfred\/private\//);
});

test('evaluateJob: ok when backup job points at the expected vault argument', () => {
  const job = JOBS.find((j) => j.name === 'vault-backup-push');
  const r = evaluateJob(job, {
    source: 'launchd',
    command: '/x/vault-backup-push.sh',
    args: ['/x/vault-backup-push.sh', '/vault-a'],
    schedule: { kind: 'calendar', hour: 22, minute: 0 },
  }, { expectedVault: '/vault-a', labelSlug: 'alfred' });
  assert.equal(r.status, 'ok');
});

test('evaluateJob: drift when backup job points at another assistant vault', () => {
  const job = JOBS.find((j) => j.name === 'vault-backup-push');
  const r = evaluateJob(job, {
    source: 'launchd',
    command: '/x/vault-backup-push.sh',
    args: ['/x/vault-backup-push.sh', '/vault-b'],
    schedule: { kind: 'calendar', hour: 22, minute: 0 },
  }, { expectedVault: '/vault-a', labelSlug: 'alfred' });
  assert.equal(r.status, 'drift');
  assert.match(r.detail, /invalid vault target/);
  assert.match(r.detail, /\/vault-a/);
});
