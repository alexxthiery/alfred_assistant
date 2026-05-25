// Unit tests for bin/lib/jobs.js — the scheduled-job manifest + pure
// plist/crontab parsing and manifest-vs-installed comparison. No fs/exec here;
// the command module owns those.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  JOBS,
  scheduleToText,
  schedulesEqual,
  parsePlist,
  parseCrontab,
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
    <key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
    </dict></plist>`;
  const p = parsePlist(xml);
  assert.equal(p.label, 'com.alfred.daily-brief');
  assert.equal(p.command, '/path/to/run-daily-brief.sh');
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

test('evaluateJob: ok when installed at default schedule with right wrapper', () => {
  const job = JOBS.find((j) => j.name === 'daily-brief');
  const r = evaluateJob(job, { source: 'launchd', command: '/x/run-daily-brief.sh', schedule: { kind: 'calendar', hour: 7, minute: 0 } });
  assert.equal(r.status, 'ok');
});

test('evaluateJob: custom when right wrapper but non-default schedule', () => {
  const job = JOBS.find((j) => j.name === 'daily-brief');
  const r = evaluateJob(job, { source: 'launchd', command: '/x/run-daily-brief.sh', schedule: { kind: 'calendar', hour: 8, minute: 30 } });
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
