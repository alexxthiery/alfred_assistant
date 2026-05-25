// replay-capture.js — the telegram-replay capture plumbing: where captured
// ingest specs/results live on disk (REPLAY_DIR), the spec-version constant +
// migration table, the path resolver, and the two capture writers. Extracted so
// cmdIngest (which captures) and the replay verb (which reads/migrates) share
// one source. fs-touching; the heavy replay logic stays with the replay verb.

'use strict';

const fs = require('fs');
const path = require('path');
const { VAULT_ROOT, nowISO } = require('./vault.js');

const REPLAY_DIR = path.join(VAULT_ROOT, 'raw', 'telegram-replay');

function replayPathFor(msgId, suffix) {
  if (!msgId) return null;
  const safe = String(msgId).replace(/[^a-zA-Z0-9._-]/g, '_');
  // If a file for this msgId already exists in any month subdir, return that path.
  if (fs.existsSync(REPLAY_DIR)) {
    for (const month of fs.readdirSync(REPLAY_DIR)) {
      const monthDir = path.join(REPLAY_DIR, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      const p = path.join(monthDir, `${safe}-${suffix}`);
      if (fs.existsSync(p)) return p;
    }
  }
  // New entry → current month.
  const month = nowISO().slice(0, 7);
  const dir = path.join(REPLAY_DIR, month);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safe}-${suffix}`);
}

// Bump when the JSON ingest-spec shape changes in a way that older captures
// can't replay cleanly. Add a transform from each old version to the current
// in REPLAY_SPEC_MIGRATIONS below. Captures without a spec_version field are
// treated as v1 (the shape at the time this versioning was introduced).
const CURRENT_SPEC_VERSION = 1;
const REPLAY_SPEC_MIGRATIONS = {
  // Example for future use:
  // 1: (spec) => { spec.someNewField = []; return spec; },  // 1 → 2
};

function captureReplaySpec(msgId, specJson) {
  const p = replayPathFor(msgId, 'spec.json');
  if (!p) return;
  try {
    // Stamp spec_version onto the captured JSON if missing. We re-serialize
    // through JSON.parse/stringify so the field lands at the top level
    // regardless of where the source had it (or didn't).
    let toWrite = specJson;
    try {
      const obj = JSON.parse(specJson);
      if (obj && typeof obj === 'object' && obj.spec_version == null) {
        obj.spec_version = CURRENT_SPEC_VERSION;
        toWrite = JSON.stringify(obj, null, 2) + '\n';
      }
    } catch (_) {
      // Spec wasn't valid JSON — fall back to writing as-is and let replay handle it.
    }
    fs.writeFileSync(p, toWrite);
  } catch (e) { console.error(`(replay capture failed: ${e.message.split('\n')[0]})`); }
}

function captureReplayResult(msgId, result) {
  const p = replayPathFor(msgId, 'result.json');
  if (!p) return;
  try { fs.writeFileSync(p, JSON.stringify(result, null, 2) + '\n'); }
  catch (e) { console.error(`(replay capture failed: ${e.message.split('\n')[0]})`); }
}

module.exports = { REPLAY_DIR, CURRENT_SPEC_VERSION, REPLAY_SPEC_MIGRATIONS, replayPathFor, captureReplaySpec, captureReplayResult };
