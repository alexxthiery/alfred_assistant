// page-io.js — the side-effecting write-path helpers shared by every write
// verb: safe page read, auto-maintained index, the append-to-log + auto-commit
// chain, and the pre-write tamper check.
//
// This is an fs/git-touching module (like vault.js, the controlled fs
// boundary), NOT a pure helper. It is extracted from bin/wiki so the verb
// handlers that call it can move into bin/commands/ without dragging the git
// plumbing along. Behavior is identical to the former inline versions.
//
// Stage-all signal: a `--accept-tamper` / `wiki bless` invocation must stage
// everything (the accepted out-of-band edit may be a stray root file), not just
// wiki/ + raw/. The former inline code used a module-level `let` for this; here
// it is the env var WIKI_AUTOCOMMIT_STAGE_ALL, mirroring WIKI_NO_AUTO_COMMIT, so
// the helper carries no cross-call mutable state. bin/wiki sets it in dispatch.

'use strict';

const fs = require('fs');
const path = require('path');
const { VAULT_ROOT, WIKI_DIR, INDEX_PATH, LOG_PATH, nowISO, forEachPage } = require('./vault.js');
const { parseFrontmatter } = require('./frontmatter.js');
const { formatIndex, formatLogLine } = require('./maintenance.js');
const { redactSecrets } = require('./secrets.js');

// HR06: read + parse + refuse if the frontmatter block is opened but not
// closed. Use at any site that intends to mutate the parsed fm and write
// the page back (the unsafe pattern: lose all original metadata silently).
// Read-only callers (audit, list, context, etc.) keep using parseFrontmatter
// directly — tolerating malformed input is the documented contract there.
function readPageForWrite(absPath) {
  const raw = fs.readFileSync(absPath, 'utf-8');
  const parsed = parseFrontmatter(raw);
  if (parsed.malformed) {
    console.error(`error: page ${absPath} has malformed frontmatter (opened with --- but no closing ---)`);
    console.error(`  Refusing to re-serialize; this would silently drop all original metadata.`);
    console.error(`  Fix the page by hand: add a closing --- line where the frontmatter block ends.`);
    process.exit(2);
  }
  return parsed;
}

function regenerateIndex() {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
  const pages = [];
  forEachPage(({ slug, fm, body }) => pages.push({ slug, fm, body }));
  fs.writeFileSync(INDEX_PATH, formatIndex(pages, { now: nowISO() }));
}

function appendLog(op, detail, opts = {}) {
  fs.mkdirSync(WIKI_DIR, { recursive: true });
  const ts = nowISO().replace('T', ' ').slice(0, 19);
  // Defense in depth: redact known secret shapes from BOTH the log line
  // (wiki/log.md is auto-committed) AND the commit subject (passed to
  // autoCommit). Even if the contains-secret strict rule misses a novel
  // shape, the value never reaches the persisted log/git surfaces.
  const safeDetail = typeof detail === 'string' ? redactSecrets(detail) : detail;
  const line = formatLogLine(ts, op, safeDetail);
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, `# Wiki Log\n\n${line}`);
  } else {
    fs.appendFileSync(LOG_PATH, line);
  }
  autoCommit(op, safeDetail, opts);
}

// Auto-commit every CLI mutation to the vault's git repo. Best-effort:
// if .git doesn't exist (vault not initialised), we silently no-op. Git failures
// are loud (multi-line stderr block) but never crash the verb — git is a recovery
// layer, not a precondition for correctness. Skipping auto-commit is also legal,
// via either the per-invocation flag --no-auto-commit or the env var
// WIKI_NO_AUTO_COMMIT (both honored at the global-args layer; see below).
function autoCommitDisabled() {
  return !!(process.env.WIKI_NO_AUTO_COMMIT && process.env.WIKI_NO_AUTO_COMMIT !== '0' && process.env.WIKI_NO_AUTO_COMMIT !== 'false');
}

function strictDeployedMode() {
  return !!(process.env.ALFRED_STRICT_DEPLOYED && process.env.ALFRED_STRICT_DEPLOYED !== '0' && process.env.ALFRED_STRICT_DEPLOYED !== 'false');
}

// True for the lifetime of a `--accept-tamper` / `wiki bless` invocation so the
// ensuing write's auto-commit folds in the accepted out-of-band edit (which may
// be outside wiki/raw). Normal writes leave it unset → scoped staging. Read from
// the env (set by bin/wiki dispatch) so this module holds no cross-call state.
function stageAllRequested() {
  const v = process.env.WIKI_AUTOCOMMIT_STAGE_ALL;
  return !!(v && v !== '0' && v !== 'false');
}

function autoCommit(op, detail, opts = {}) {
  if (autoCommitDisabled()) {
    if (strictDeployedMode()) {
      console.error('auto-commit: WIKI_NO_AUTO_COMMIT is not allowed when ALFRED_STRICT_DEPLOYED=1.');
      process.exit(2);
    }
    console.error('auto-commit: skipped (WIKI_NO_AUTO_COMMIT / --no-auto-commit). Run `git -C $VAULT_ROOT add -A && git commit` to capture this write.');
    return;
  }
  const gitDir = path.join(VAULT_ROOT, '.git');
  if (!fs.existsSync(gitDir)) {
    if (strictDeployedMode()) {
      console.error(`auto-commit: refusing write because ALFRED_STRICT_DEPLOYED=1 and ${gitDir} is missing.`);
      process.exit(2);
    }
    return;
  }
  try {
    const { spawnSync } = require('child_process');
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    // Array-form spawnSync: argv is passed through verbatim, no shell interpolation.
    const git = (args) => {
      const r = spawnSync('git', args, { cwd: VAULT_ROOT, env, encoding: 'utf-8' });
      if (r.error) throw r.error;
      if (r.status !== 0) {
        throw new Error(`git ${args[0]}: ${(r.stderr || '').split('\n')[0] || `exit ${r.status}`}`);
      }
      return r;
    };
    // Normal writes stage ONLY the directories the CLI itself writes (wiki/
    // pages + index + log; raw/ for `measure` TSVs and replay captures). The
    // old `git add -A` swept EVERY dirty/untracked file — so a hand-edited
    // AGENTS.md or a stray root doc got folded into the next wiki commit
    // indistinguishably, defeating the tamper-check meant to flag exactly those.
    // Scoping restores that: anything outside wiki/raw stays uncommitted and is
    // surfaced by tamperCheck on the next write.
    //
    // The escape hatches deliberately stage EVERYTHING: `wiki bless` and
    // `--accept-tamper` mean "I accept the current out-of-band state" — which
    // can include stray root files — so they must be able to clear them.
    if (opts.all || stageAllRequested()) {
      git(['add', '-A']);
    } else {
      const owned = ['wiki', 'raw'].filter((d) => fs.existsSync(path.join(VAULT_ROOT, d)));
      if (owned.length) git(['add', '-A', '--', ...owned]);
    }
    // Skip commit if nothing staged (e.g. only ignored files changed).
    const staged = git(['diff', '--cached', '--name-only']).stdout.trim();
    if (!staged) return;
    // Slice to 200 chars to keep commit subject sane; quotes preserved as-is
    // (no shell parsing now that we use array form).
    const safeMsg = `${op} | ${detail}`.slice(0, 200);
    git(['-c', 'commit.gpgsign=false', 'commit', '-m', safeMsg]);
  } catch (e) {
    // Loud failure: stderr block that any human or scraper-of-stderr will see.
    const msg = e && e.message ? e.message.split('\n')[0] : String(e);
    console.error('');
    console.error('!!! auto-commit failed !!!');
    console.error(`    error: ${msg}`);
    console.error(`    vault: ${VAULT_ROOT}`);
    console.error('    The write succeeded but is uncommitted. Recover with:');
    console.error('      cd ' + VAULT_ROOT + ' && git status   # see the dirty state');
    console.error('      git add -A && git commit -m "<message>"');
    console.error('    Or skip auto-commit entirely on subsequent writes:');
    console.error('      wiki <verb> --no-auto-commit ...   # per invocation');
    console.error('      WIKI_NO_AUTO_COMMIT=1 wiki ...     # process-scoped');
    console.error('');
    if (strictDeployedMode()) process.exit(2);
  }
}

// Tamper detection: refuse to run a write-class verb while the vault has
// uncommitted changes that didn't come through the CLI. Because every CLI
// mutation auto-commits, a dirty tree means either (a) something edited the
// vault outside `wiki`, or (b) a prior auto-commit failed. Either way we block
// rather than silently fold the change into the next commit. This is the
// runtime-independent write-guard: it works regardless of which agent/runtime
// made the out-of-band edit, because it operates at the git layer.
//
// Escape hatches: `--accept-tamper` (fold it in this once) or `wiki bless`
// (commit the current state as accepted). No-op when the vault isn't a git repo
// or when auto-commit is disabled (a dirty tree is then expected).
function tamperCheck({ accept = false } = {}) {
  if (autoCommitDisabled()) {
    if (strictDeployedMode()) {
      console.error('tamper-check: WIKI_NO_AUTO_COMMIT is not allowed when ALFRED_STRICT_DEPLOYED=1.');
      process.exit(2);
    }
    return;
  }
  const gitDir = path.join(VAULT_ROOT, '.git');
  if (!fs.existsSync(gitDir)) {
    if (strictDeployedMode()) {
      console.error(`tamper-check: refusing write because ALFRED_STRICT_DEPLOYED=1 and ${gitDir} is missing.`);
      process.exit(2);
    }
    return;
  }
  let lines = [];
  try {
    const { spawnSync } = require('child_process');
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: VAULT_ROOT, env, encoding: 'utf-8' });
    if (r.error) throw r.error;
    const dirty = (r.stdout || '').trim();
    if (!dirty) return;
    // Filter to vault content (ignore alfred/scratchpad.md, tamper.log etc which are gitignored)
    lines = dirty.split('\n').filter((l) => /\s(wiki|inbox|raw|SCHEMA\.md|\.bin)\//.test(l));
    if (lines.length === 0) return;
    const tamperLog = path.join(VAULT_ROOT, 'alfred', 'tamper.log');
    fs.mkdirSync(path.dirname(tamperLog), { recursive: true });
    const ts = nowISO();
    for (const l of lines) fs.appendFileSync(tamperLog, `${ts}\ttamper-or-uncommitted\t${l.trim()}\n`);
  } catch (e) {
    // Fail-open on a git hiccup: a transient git error shouldn't brick writes.
    const msg = e && e.message ? e.message.split('\n')[0] : String(e);
    if (strictDeployedMode()) {
      console.error(`tamper-check: refusing write because git status failed under ALFRED_STRICT_DEPLOYED=1: ${msg}`);
      process.exit(2);
    }
    console.error(`(tamper-check failed, proceeding: ${msg})`);
    return;
  }
  if (accept) {
    console.error(`(tamper: ${lines.length} uncommitted vault file(s) accepted via --accept-tamper — folding into the next commit)`);
    return;
  }
  console.error('');
  console.error(`!!! tamper-check: ${lines.length} uncommitted vault change(s) not made through wiki !!!`);
  for (const l of lines.slice(0, 10)) console.error(`    ${l.trim()}`);
  console.error('');
  console.error('  The vault was edited outside the CLI (or a prior auto-commit failed).');
  console.error('  Refusing to proceed so the change is not silently folded into the next commit. Resolve:');
  console.error(`    git -C ${VAULT_ROOT} restore .     # discard the out-of-band edit, OR`);
  console.error('    wiki bless                         # accept + commit the current state, OR');
  console.error('    wiki <verb> --accept-tamper ...    # proceed this once, folding it in');
  console.error('');
  process.exit(3);
}

module.exports = { readPageForWrite, regenerateIndex, appendLog, autoCommit, autoCommitDisabled, strictDeployedMode, tamperCheck };
