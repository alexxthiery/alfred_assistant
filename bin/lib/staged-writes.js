// staged-writes.js — atomic-per-file multi-write flush helper.
//
// Used by write-class verbs that mutate multiple pages in one logical
// operation (`cmdIngest` M08, `cmdMerge` HR03, future: `cmdMv` HR04).
// The pattern: accumulate {path, content} pairs in a Map during the
// compute phase; if anything throws mid-compute, the catch path skips
// the flush and the vault is untouched. Only after every staged write
// computed cleanly does flushStaged() write each file via temp+rename
// for filesystem-level per-file atomicity.
//
// Why not just write each file inline? See audit/12-coherence-robustness.md
// § concurrency-atomicity and the M08 commit for context.
//
// Exported:
//   flushStaged(staged, opts) — flush a Map<absPath, content> to disk.
//     opts.tag — short string used in temp filename (e.g., 'ingest', 'merge').
//                Default: 'staged'. Helps debugging if a process is killed
//                mid-flush and temp files remain.
//     opts.pid — override process.pid (for testability).
//   STAGED_TMP_RE(tag) — regex matching the temp-file pattern for the given tag,
//                       useful in cleanup / debug tooling.
//
// No process state. No globals. Re-entrant.

'use strict';

const fs = require('node:fs');

function flushStaged(staged, opts = {}) {
  const tag = opts.tag || 'staged';
  const pid = opts.pid !== undefined ? opts.pid : process.pid;
  for (const [p, content] of staged) {
    const tmp = `${p}.tmp-${tag}-${pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, p);
  }
}

function STAGED_TMP_RE(tag) {
  return new RegExp(`\\.tmp-${tag}-\\d+$`);
}

module.exports = { flushStaged, STAGED_TMP_RE };
