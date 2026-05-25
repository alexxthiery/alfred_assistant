// commands/jobs.js — `wiki jobs` (list the scheduled-job manifest) and
// `wiki jobs --check` (validate installed launchd/cron entries against it).
//
// Read-only and non-mutating by design: the OS scheduler stays the executor.
// This verb adds observability + config validation only; it never installs,
// edits, or removes a schedule. Last-run status is a deferred follow-up.
//
// Pure manifest/parse/compare logic lives in bin/lib/jobs.js; this file does the
// fs reads (LaunchAgents plists) and the `crontab -l` shell-out.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JOBS, scheduleToText, parsePlist, parseCrontab, evaluateJob } = require('../lib/jobs.js');

// Read installed launchd plist for a label, if present (user then system dir).
function readLaunchdPlist(label) {
  const candidates = [
    path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    path.join('/Library', 'LaunchAgents', `${label}.plist`),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const parsed = parsePlist(fs.readFileSync(p, 'utf-8'));
        if (parsed && parsed.label === label) return parsed;
      }
    } catch {
      /* unreadable plist: treat as absent */
    }
  }
  return null;
}

// Best-effort `crontab -l`. Returns parsed entries, or [] if no crontab / no cron.
function readCrontab() {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf-8' });
    if (r.status !== 0 || !r.stdout) return [];
    return parseCrontab(r.stdout);
  } catch {
    return [];
  }
}

// Locate the installed entry for a job: prefer a launchd plist by label, else a
// crontab line whose command references the job's wrapper.
function findInstalled(job, cronEntries) {
  const plist = readLaunchdPlist(job.label);
  if (plist) return { source: 'launchd', command: plist.command, schedule: plist.schedule };
  const hit = cronEntries.find((e) => e.command && e.command.includes(job.wrapper));
  if (hit) return { source: 'cron', command: hit.command, schedule: hit.schedule };
  return null;
}

const STATUS_ORDER = { drift: 0, missing: 1, custom: 2, ok: 3 };

function cmdJobs(args) {
  const json = !!args.json;

  if (!args.check) {
    // List the manifest.
    if (json) {
      process.stdout.write(`${JSON.stringify(JOBS, null, 2)}\n`);
      return;
    }
    console.log('Scheduled jobs (manifest). The OS (launchd/cron) is the executor;');
    console.log('run `wiki jobs --check` to validate what is actually installed.\n');
    for (const j of JOBS) {
      const agent = j.needsAgent ? ' [needs agent]' : '';
      console.log(`  ${j.name.padEnd(18)} ${scheduleToText(j.schedule).padEnd(16)} ${j.wrapper}${agent}`);
      console.log(`  ${' '.repeat(18)} ${j.purpose}`);
    }
    return;
  }

  // --check: compare manifest against installed launchd/cron entries.
  const cronEntries = readCrontab();
  const results = JOBS.map((job) => {
    const installed = findInstalled(job, cronEntries);
    const { status, detail } = evaluateJob(job, installed);
    return { name: job.name, label: job.label, status, detail };
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    console.log('wiki jobs --check — scheduled-job health\n');
    for (const r of [...results].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])) {
      console.log(`  ${r.status.padEnd(7)} ${r.name.padEnd(18)} ${r.detail}`);
    }
    const tally = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
    const parts = ['ok', 'custom', 'missing', 'drift'].map((s) => `${tally[s] || 0} ${s}`);
    console.log(`\n${parts.join(', ')}`);
    if (tally.drift) {
      console.error('\njobs --check: drift detected (an installed entry points at the wrong target). Re-point or reinstall the plist/cron entry.');
    }
  }

  // Exit nonzero only on drift (installed but wrong target) — the actionable
  // failure. 'missing' is informational (the job may be intentionally not set up).
  if (results.some((r) => r.status === 'drift')) process.exit(1);
}

module.exports = { cmdJobs };
