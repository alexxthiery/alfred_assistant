// commands/replay.js — `wiki replay`: re-run captured telegram-driven ingest
// specs against a throwaway copy of the vault and diff the result vs the
// captured one (drift detection). Heavy lifting: copy vault, restore pre-state,
// spawn `wiki ingest --replay` in the copy, parse+diff. Capture plumbing +
// spec-version migrations live in lib/replay-capture.js.

'use strict';

const fs = require('fs');
const path = require('path');
const { VAULT_ROOT } = require('../lib/vault.js');
const { REPLAY_DIR, CURRENT_SPEC_VERSION, REPLAY_SPEC_MIGRATIONS, replayPathFor } = require('../lib/replay-capture.js');

// The CLI entrypoint to spawn for the replayed ingest (was __filename when this
// lived in bin/wiki). From bin/commands/ this resolves to bin/wiki, and in a
// deployed vault to .bin/wiki.
const WIKI_BIN = path.join(__dirname, '..', 'wiki');

function parseIngestStdout(stdout) {
  const out = { created: [], modified: [], skipped: [] };
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(created|modified|skipped)(?:\s*\([^)]+\))?:\s*(.+)$/);
    if (m) out[m[1]] = m[2].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

function copyVaultForReplay(src, dst) {
  // Copy only what cmdIngest needs: SCHEMA.md + wiki/. Skip .git, .cache,
  // tests/, raw/, alfred/, inbox/ — none of which cmdIngest reads. raw/ is
  // intentionally excluded so replays don't re-write capture files.
  fs.mkdirSync(dst, { recursive: true });
  const schemaSrc = path.join(src, 'SCHEMA.md');
  if (fs.existsSync(schemaSrc)) fs.copyFileSync(schemaSrc, path.join(dst, 'SCHEMA.md'));
  const wikiSrc = path.join(src, 'wiki');
  const wikiDst = path.join(dst, 'wiki');
  fs.mkdirSync(wikiDst, { recursive: true });
  for (const f of fs.readdirSync(wikiSrc)) {
    const s = path.join(wikiSrc, f);
    const d = path.join(wikiDst, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, d);
  }
}

function diffReplayResults(captured, current) {
  const drift = [];
  if (!captured) {
    drift.push(`no captured result on disk; current exitCode=${current.exitCode}`);
    return drift;
  }
  if (captured.exitCode !== current.exitCode) {
    drift.push(`exitCode: captured=${captured.exitCode} current=${current.exitCode}`);
  }
  for (const key of ['created', 'modified', 'skipped']) {
    const a = new Set(captured[key] || []);
    const b = new Set(current[key] || []);
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length) drift.push(`${key}: now includes ${added.join(', ')}`);
    if (removed.length) drift.push(`${key}: no longer includes ${removed.join(', ')}`);
  }
  // Compare error substrings: if captured errors exist, ensure current still emits them.
  if (Array.isArray(captured.errors) && captured.errors.length) {
    const currentErrText = (current.errors || []).join('\n');
    for (const e of captured.errors) {
      if (!currentErrText.includes(e.slice(0, 40))) {
        drift.push(`error gone: "${e.slice(0, 80)}"`);
      }
    }
  }
  // If captured had no errors but current does, flag.
  if ((!captured.errors || !captured.errors.length) && current.errors && current.errors.length) {
    drift.push(`new errors: ${current.errors.slice(0, 3).map((e) => e.slice(0, 80)).join(' | ')}`);
  }
  return drift;
}

function listReplayMsgIds() {
  if (!fs.existsSync(REPLAY_DIR)) return [];
  const out = [];
  for (const month of fs.readdirSync(REPLAY_DIR)) {
    const monthDir = path.join(REPLAY_DIR, month);
    if (!fs.statSync(monthDir).isDirectory()) continue;
    for (const f of fs.readdirSync(monthDir)) {
      const m = f.match(/^(.+)-spec\.json$/);
      if (m) out.push(m[1]);
    }
  }
  return out.sort();
}

function runReplayOne(msgId) {
  const specPath = replayPathFor(msgId, 'spec.json');
  if (!specPath || !fs.existsSync(specPath)) {
    return { msgId, ok: false, reason: `no captured spec` };
  }
  const resultPath = replayPathFor(msgId, 'result.json');
  const captured = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf-8')) : null;

  // Spec version check + migration. Captures without spec_version are treated
  // as v1 (the pre-versioning shape). If we don't know how to migrate from
  // the captured version up to CURRENT_SPEC_VERSION, skip+warn rather than
  // produce false drift.
  let migratedSpecPath = specPath;
  try {
    const raw = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    let v = raw && typeof raw === 'object' && Number.isInteger(raw.spec_version) ? raw.spec_version : 1;
    if (v > CURRENT_SPEC_VERSION) {
      return { msgId, ok: false, reason: `spec_version ${v} > current ${CURRENT_SPEC_VERSION} (capture from a newer CLI)` };
    }
    if (v < CURRENT_SPEC_VERSION) {
      let migrated = raw;
      while (v < CURRENT_SPEC_VERSION) {
        const xform = REPLAY_SPEC_MIGRATIONS[v];
        if (typeof xform !== 'function') {
          return { msgId, ok: false, reason: `spec_version ${v} has no migration to v${v + 1}` };
        }
        migrated = xform(migrated);
        v++;
      }
      migrated.spec_version = CURRENT_SPEC_VERSION;
      migratedSpecPath = path.join(require('os').tmpdir(), `replay-migrated-${msgId.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
      fs.writeFileSync(migratedSpecPath, JSON.stringify(migrated, null, 2) + '\n');
    }
  } catch (_) {
    // Not valid JSON — let the downstream ingest call produce a real error.
  }

  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), `vault-replay-${msgId.replace(/[^a-zA-Z0-9]/g, '_')}-`));
  try {
    copyVaultForReplay(VAULT_ROOT, tmp);
    // Restore approximate pre-state: delete from the temp vault any slugs the
    // original run had to create. Without this, a create-spec replayed after
    // the page exists produces skipped=[X] vs captured created=[X] — false drift.
    if (captured && Array.isArray(captured.created)) {
      for (const slug of captured.created) {
        const p = path.join(tmp, 'wiki', `${slug}.md`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
    const { spawnSync } = require('child_process');
    const res = spawnSync('node', [WIKI_BIN, 'ingest', '--file', migratedSpecPath, '--replay'], {
      cwd: tmp,
      env: { ...process.env, WIKI_ROOT: tmp },
      encoding: 'utf-8',
    });
    const exit = res.status;
    const stdout = res.stdout || '';
    const stderr = res.stderr || '';
    // Pull validation errors out of stderr.
    const errors = [];
    for (const line of stderr.split('\n')) {
      const m = line.match(/^\s*-\s+(.+)$/);
      if (m && !m[1].startsWith('tamper:')) errors.push(m[1].trim());
    }
    const current = {
      exitCode: exit,
      ...parseIngestStdout(stdout),
      errors,
    };
    const drift = diffReplayResults(captured, current);
    return { msgId, ok: drift.length === 0, drift, captured, current };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

function cmdReplay(args) {
  if (args.all || args._[0] === '--all') {
    const ids = listReplayMsgIds();
    if (!ids.length) { console.log('(no captured replays)'); return; }
    let stable = 0, drift = 0, missing = 0;
    for (const id of ids) {
      const r = runReplayOne(id);
      if (!r.ok && r.reason) { console.log(`SKIP   ${id}   ${r.reason}`); missing++; continue; }
      if (r.ok) { console.log(`stable ${id}`); stable++; }
      else {
        console.log(`drift  ${id}`);
        for (const d of r.drift) console.log(`  ${d}`);
        drift++;
      }
    }
    console.log('');
    console.log(`${stable} stable / ${drift} drift / ${missing} missing (${ids.length} total)`);
    if (drift > 0) process.exit(1);
    return;
  }
  const msgId = args._[0];
  if (!msgId) {
    console.error('Usage: wiki replay <msg-id>   |   wiki replay --all');
    console.error('       captures live at raw/telegram-replay/<YYYY-MM>/');
    process.exit(1);
  }
  const r = runReplayOne(msgId);
  if (!r.ok && r.reason) { console.error(r.reason); process.exit(2); }
  if (r.ok) { console.log(`stable ${msgId}`); return; }
  console.log(`drift ${msgId}`);
  for (const d of r.drift) console.log(`  ${d}`);
  process.exit(1);
}

module.exports = { cmdReplay };
