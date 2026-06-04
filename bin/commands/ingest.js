// commands/ingest.js — `wiki ingest`: the JSON-spec batch writer. Validates the
// whole spec up front, fuzzy-resolves targets, stages every page write, flushes
// atomically (a mid-run failure leaves the vault untouched), then runs
// inverse-closure, autolink, index regen, per-page audit, and telegram-replay
// capture. The largest handler; all pure/shared logic lives in the libs below.

'use strict';

const fs = require('fs');
const path = require('path');
const { WIKI_DIR, INDEX_PATH, SCHEMA_PATH, nowISO, wikiPath, listWikiPages, forEachPage } = require('../lib/vault.js');
const { knownRelationVerbs, loadSchema: _loadSchema } = require('../lib/schema.js');
const { parseFrontmatter, serializeFrontmatter } = require('../lib/frontmatter.js');
const { parseRelations, parseRelationLine } = require('../lib/graph.js');
const { validateIngestSpec } = require('../lib/ingest.js');
const { mintIdsForBody } = require('../lib/obsid.js');
const { auditPage, severityScore } = require('../lib/audit.js');
const { flushStaged } = require('../lib/staged-writes.js');
const { buildTitleEntries } = require('../lib/autolink.js');
const { computeMissingInverses, groupByTarget } = require('../lib/inverse-closure.js');
const { formatIndex, batchHookWarnings } = require('../lib/maintenance.js');
const { formatObservation, formatRelation, buildBodyFromSpec } = require('../lib/ingest-body.js');
const { resolveSlugCandidates } = require('../lib/resolve.js');
const { captureReplaySpec, captureReplayResult, missingRequiredReplayMsgId } = require('../lib/replay-capture.js');
const { buildTitleMap, autolinkSlug } = require('../lib/autolink-runtime.js');
const { regenerateIndex, appendLog } = require('../lib/page-io.js');
const { warnHooks } = require('../lib/write-validate.js');
const { auditSlug } = require('../lib/audit-runtime.js');

const loadSchema = () => _loadSchema(SCHEMA_PATH);

function cmdIngest(args) {
  // Read JSON spec from stdin or --file
  let jsonText = '';
  if (args.stdin) {
    jsonText = fs.readFileSync(0, 'utf-8');
  } else if (args.file) {
    if (!fs.existsSync(args.file)) { console.error(`error: file not found: ${args.file}`); process.exit(1); }
    jsonText = fs.readFileSync(args.file, 'utf-8');
  } else {
    console.error('Usage: wiki ingest --stdin   |   wiki ingest --file <path.json>');
    process.exit(1);
  }

  // Sanity size guard — spec is hand-written JSON describing entities; should be small.
  const MAX_SPEC_BYTES = 2_000_000; // 2 MB
  if (jsonText.length > MAX_SPEC_BYTES) {
    console.error(`error: spec too large: ${jsonText.length} bytes (max ${MAX_SPEC_BYTES}); split into multiple ingests`);
    process.exit(2);
  }

  let spec;
  try {
    spec = JSON.parse(jsonText);
  } catch (e) {
    console.error(`error: invalid JSON: ${e.message}`);
    process.exit(2);
  }

  // B2 replay capture: persist the spec for any Telegram-driven ingest carrying
  // a msg_id. Disabled when running under --replay (we're replaying a captured
  // spec; don't overwrite the artifact we're re-running).
  if (missingRequiredReplayMsgId(spec, { replay: !!args.replay })) {
    console.error('error: top-level "msg_id" is required because WIKI_REQUIRE_REPLAY_MSG_ID=1');
    console.error('       Telegram-triggered ingests must be replay-capturable; include the inbound message id.');
    process.exit(2);
  }
  const replayMsgId = spec && typeof spec.msg_id === 'string' ? spec.msg_id.trim() : spec && spec.msg_id;
  if (replayMsgId && !args.replay) captureReplaySpec(replayMsgId, jsonText);

  // ─── VALIDATE ─────────────────────────────────────────────────────────
  // Pure validator (./lib/ingest.js) — caller injects schema, vault state,
  // and fuzzy resolver; gets back {errors, parsed sections, createdSlugs}.
  const schema = loadSchema();
  const knownVerbs = knownRelationVerbs(schema);
  const existingSlugs = new Set(listWikiPages().map((f) => f.replace(/\.md$/, '')));
  const { errors, stubs, entities, events, patches, createdSlugs } = validateIngestSpec(spec, {
    schema,
    knownVerbs,
    existingSlugs,
    fuzzyMatchFn: (title, opts) => resolveSlugCandidates(title, opts),
    allowDuplicates: !!args['allow-duplicates'],
    allowDuplicateSlugs: new Set(
      String(args['allow-duplicate-slug'] || '').split(',').map((s) => s.trim()).filter(Boolean),
    ),
  });

  if (errors.length) {
    if (replayMsgId && !args.replay) {
      captureReplayResult(replayMsgId, { exitCode: 3, errors, created: [], modified: [], skipped: [] });
    }
    console.error('# ingest validation failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(3);
  }

  // ─── EXECUTE ──────────────────────────────────────────────────────────
  // M08: staged writes. All page mutations accumulate in `stagedWrites` (path
  // -> content). Nothing touches the vault until the final flush at the end
  // of the EXECUTE phase. If any loop throws, the catch below skips the flush
  // and the vault is unchanged. Flush itself uses temp-file + renameSync per
  // page for filesystem-level atomicity of each write.
  const source = spec.source;
  // Hook vocabulary for the near-duplicate hint (warnHooks): existing vault
  // hooks ∪ every hook this spec declares. The batch union matters because the
  // common case is one ingest minting both `density-ratio` and
  // `density-ratio-estimation` (neither pre-existing) — vault-only vocab would
  // miss it. Built once here; passed to the entity + patch warnHooks calls.
  const hookVocab = new Set();
  forEachPage(({ fm }) => { for (const h of (Array.isArray(fm.hooks) ? fm.hooks : [])) if (typeof h === 'string' && h) hookVocab.add(h); });
  for (const e of entities) for (const h of (Array.isArray(e.hooks) ? e.hooks : [])) if (typeof h === 'string' && h) hookVocab.add(h);
  for (const p of patches) for (const h of (Array.isArray(p.add_hooks) ? p.add_hooks : [])) if (typeof h === 'string' && h) hookVocab.add(h);
  const created = [], modified = [], skipped = [];
  /** @type {Map<string,string>} absolute-path -> file content */
  const stagedWrites = new Map();
  const stagedExists = (p) => stagedWrites.has(p) || fs.existsSync(p);
  const stagedRead = (p) => stagedWrites.has(p) ? stagedWrites.get(p) : fs.readFileSync(p, 'utf-8');
  const stagePage = (p, content) => stagedWrites.set(p, content);

  try {
  // 1) Stubs first
  for (const s of stubs) {
    if (stagedExists(wikiPath(s.slug))) { skipped.push(s.slug); continue; }
    const fm = {
      id: s.slug, title: s.title,
      type: s.type || 'entity',
      created: nowISO(), updated: nowISO(),
      tags: s.tags || [],
    };
    const body = `Stub. ^[${source}]\n`;
    stagePage(wikiPath(s.slug), serializeFrontmatter(fm, mintIdsForBody(body)));
    created.push(s.slug);
  }

  // 2) Entities
  for (const e of entities) {
    const type = e.type || 'entity';
    let fmCreated = nowISO();
    const exists = stagedExists(wikiPath(e.slug));
    if (exists) {
      const cur = parseFrontmatter(stagedRead(wikiPath(e.slug)));
      if (cur.fm.created) fmCreated = cur.fm.created;
    }
    const fm = {
      id: e.slug, title: e.title,
      type, created: fmCreated, updated: nowISO(),
      tags: e.tags || [],
    };
    // Optional extras
    if (e.aliases) fm.aliases = Array.isArray(e.aliases) ? e.aliases : [e.aliases];
    if (e.hooks) { fm.hooks = Array.isArray(e.hooks) ? e.hooks : [e.hooks]; warnHooks(fm.hooks, hookVocab); }
    if (e.summary) fm.summary = e.summary;
    for (const k of ['homepage', 'scholar', 'orcid', 'github', 'linkedin', 'twitter', 'arxiv', 'email']) {
      if (e[k]) fm[k] = e[k];
    }
    const body = buildBodyFromSpec(e, source);
    stagePage(wikiPath(e.slug), serializeFrontmatter(fm, mintIdsForBody(body)));
    (exists ? modified : created).push(e.slug);
  }

  // 3) Events
  for (const e of events) {
    let fmCreated = nowISO();
    const exists = stagedExists(wikiPath(e.slug));
    if (exists) {
      const cur = parseFrontmatter(stagedRead(wikiPath(e.slug)));
      if (cur.fm.created) fmCreated = cur.fm.created;
    }
    const fm = {
      id: e.slug, title: e.title,
      type: 'event', created: fmCreated, updated: nowISO(),
      tags: e.tags,
      when: e.when,
    };
    if (e.duration) fm.duration = e.duration;
    if (e.location) fm.location = e.location;
    if (Array.isArray(e.attendees) && e.attendees.length) fm.attendees = e.attendees;
    if (e.recurrence) fm.recurrence = e.recurrence;
    if (e.summary) fm.summary = e.summary;
    const body = buildBodyFromSpec(e, source);
    stagePage(wikiPath(e.slug), serializeFrontmatter(fm, mintIdsForBody(body)));
    (exists ? modified : created).push(e.slug);
  }

  // 4) Patches
  for (const p of patches) {
    const { fm, body } = parseFrontmatter(stagedRead(wikiPath(p.slug)));
    let newBody = body;
    const additions = [];
    if (Array.isArray(p.supersede)) {
      for (const sup of p.supersede) {
        const needle = sup.match;
        const lines = newBody.split('\n');
        const matches = [];
        for (let i = 0; i < lines.length; i++) {
          if (/^- (?:~~)?\[/.test(lines[i]) && lines[i].includes(needle)) matches.push(i);
        }
        if (matches.length === 0) {
          console.error(`patches[${p.slug}]: supersede needle "${needle}" matched 0 observations — skipped`);
        } else if (matches.length > 1) {
          console.error(`patches[${p.slug}]: supersede needle "${needle}" matched ${matches.length} observations — ambiguous, skipped (use a more specific substring)`);
        } else {
          const idx = matches[0];
          if (!/^- ~~/.test(lines[idx])) {
            const today = nowISO().slice(0, 10);
            lines[idx] = lines[idx].replace(/^- (\[[a-z]+\][\s\S]+?)\s*$/, `- ~~$1~~ [until ${today}]`);
            newBody = lines.join('\n');
          }
        }
        if (sup.replacement_fact) {
          const line = formatObservation(sup.replacement_fact, 'fact', source);
          if (line) additions.push(line);
        }
      }
    }
    const obsGroups = [
      ['fact', p.add_facts],
      ['hypothesis', p.add_hypotheses],
      ['opinion', p.add_opinions],
      ['claim', p.add_claims],
    ];
    for (const [cat, arr] of obsGroups) {
      if (!Array.isArray(arr)) continue;
      for (const obs of arr) {
        const line = formatObservation(obs, cat, source);
        if (line) additions.push(line);
      }
    }
    if (Array.isArray(p.add_relations)) {
      // V4: dedup against the page's existing relations AND within this batch,
      // so re-running a spec never doubles an edge (mirrors add_hooks below).
      const existingRels = parseRelations(newBody);
      const seenRel = new Set(existingRels.map((r) => `${r.verb}\x1f${r.target}`));
      for (const r of p.add_relations) {
        const line = formatRelation(r);
        if (!line) continue;
        const pr = parseRelationLine(line);
        const key = pr ? `${pr.verb}\x1f${pr.target}` : null;
        if (key && seenRel.has(key)) continue;
        if (key) seenRel.add(key);
        additions.push(line);
      }
    }
    if (additions.length) {
      newBody = newBody.trimEnd() + '\n' + additions.join('\n') + '\n';
    }
    // add_hooks: union connective hooks into frontmatter (deduped, order-preserving).
    if (Array.isArray(p.add_hooks) && p.add_hooks.length) {
      const merged = Array.isArray(fm.hooks) ? [...fm.hooks] : [];
      for (const h of p.add_hooks) {
        if (typeof h === 'string' && h && !merged.includes(h)) merged.push(h);
      }
      fm.hooks = merged;
      warnHooks(p.add_hooks, hookVocab);
    }
    fm.updated = nowISO();
    stagePage(wikiPath(p.slug), serializeFrontmatter(fm, mintIdsForBody(newBody)));
    modified.push(p.slug);
  }
  } catch (e) {
    // Staged-write failure mid-EXECUTE. The vault is untouched (no flush yet).
    if (replayMsgId && !args.replay) {
      captureReplayResult(replayMsgId, { exitCode: 2, errors: [e.message], created: [], modified: [], skipped: [] });
    }
    console.error(`# ingest aborted before any writes: ${e.message}`);
    process.exit(2);
  }

  // ─── DRY-RUN (E3) ─────────────────────────────────────────────────────
  // Validation + staging already ran (in-memory only — nothing on disk yet),
  // so we can report the full plan plus a simulated audit and dangling-target
  // check without writing or committing. Turns B1/C1/E1/E2 from post-write
  // cleanups into pre-write diagnostics.
  if (args['dry-run']) {
    const list = (a) => { const u = [...new Set(a)]; return u.length ? ' — ' + u.join(', ') : ''; };
    console.log('# ingest --dry-run (no writes, no commit)');
    console.log(`  would create: ${[...new Set(created)].length}${list(created)}`);
    console.log(`  would modify: ${[...new Set(modified)].length}${list(modified)}`);
    console.log(`  would skip:   ${[...new Set(skipped)].length}${list(skipped)}`);
    const allSlugs = new Set([...existingSlugs, ...createdSlugs]);
    const auditDeps = { schema, knownVerbs };
    const sev = { low: 0, medium: 0, high: 0 };
    const dangling = [];
    const blockers = [];
    for (const [p, content] of stagedWrites) {
      const s = path.basename(p).replace(/\.md$/, '');
      const { fm, body } = parseFrontmatter(content);
      for (const r of parseRelations(body)) {
        if (!allSlugs.has(r.target)) dangling.push(`${s} -[${r.verb}]-> ${r.target}`);
      }
      const res = auditPage(
        { slug: s, title: String(fm.title || s), type: fm.type || 'note', tags: Array.isArray(fm.tags) ? fm.tags : [], body, fm },
        auditDeps,
      );
      for (const i of (res.issues || [])) {
        sev[i.severity] = (sev[i.severity] || 0) + 1;
        if (severityScore(i.severity) >= 2) blockers.push(`[${i.severity}] ${s}: ${i.rule}: ${i.detail}`);
      }
    }
    if (dangling.length) {
      console.log(`  dangling relation targets (${dangling.length}) — resolve to no existing or batch page:`);
      for (const d of dangling.slice(0, 30)) console.log(`    ${d}`);
    }
    console.log(`  simulated audit: ${sev.high || 0} high, ${sev.medium || 0} medium, ${sev.low || 0} low across ${stagedWrites.size} page(s)`);
    for (const b of blockers.slice(0, 30)) console.log(`    ${b}`);
    console.log('# dry-run: nothing written.');
    return;
  }

  // ─── FLUSH ────────────────────────────────────────────────────────────
  // All staged writes go to disk now. See bin/lib/staged-writes.js for the
  // per-file atomicity contract (temp + renameSync per entry).
  flushStaged(stagedWrites, { tag: 'ingest' });

  // Dedup created/modified/skipped — a slug can appear twice if e.g. multiple
  // patches target the same page in one spec (M07). Reporting "2 modified"
  // for one slug is misleading; we report the set of touched slugs.
  const dedupedCreated  = [...new Set(created)];
  const dedupedModified = [...new Set(modified)];
  const dedupedSkipped  = [...new Set(skipped)];
  created.length = 0;   created.push(...dedupedCreated);
  modified.length = 0;  modified.push(...dedupedModified);
  skipped.length = 0;   skipped.push(...dedupedSkipped);

  const touched = [...new Set([...created, ...modified])];
  // A1: the commit is DEFERRED to a single appendLog after index regen +
  // inverse-closure + autolink (below), so the working tree is never left
  // dirty. The old early commit here committed a stale index.md, and the
  // regenerated index only got committed if inverse-closure happened to fire
  // (missing.length>0) — so one-way-verb ingests (instance_of/cites/extends)
  // orphaned wiki/index.md every time → tamper-block → bless-churn.

  // HR23: post-flush snapshot. Pre-HR23, this leg did 3 separate full-vault
  // walks (regenerateIndex + buildTitleMap + per-touched-slug auditSlug
  // reads). Now one walk builds a `pages` snapshot consumed by every
  // downstream operation. Saves ~2N reads at any vault size; matters at 1K+.
  const postFlushPages = [];
  const postFlushBySlug = new Map();
  forEachPage(({ slug, fm, body }) => {
    const entry = {
      slug,
      fm,
      body,
      type: fm.type || 'note',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      title: String(fm.title || slug),
    };
    postFlushPages.push(entry);
    postFlushBySlug.set(slug, entry);
  });

  // 4b) Refresh index/log using the snapshot (no second walk inside).
  fs.mkdirSync(WIKI_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, formatIndex(postFlushPages, { now: nowISO() }));

  // 4c) Auto-inverse-closure on the touched slugs. If this ingest added
  // `A → parent_of [[B]]`, ensure `B → child_of [[A]]` also exists; same for
  // symmetric verbs. Scoped to touched so we don't drift into unrelated
  // pages. Mirrors what `wiki groom --mechanical` does vault-wide; here it
  // is local to the ingest so the agent never has to remember the step.
  // Reuses the pageRelations snapshot we just parsed.
  {
    const schema = loadSchema();
    const pageRelations = new Map();
    const slugSet = new Set();
    for (const p of postFlushPages) {
      pageRelations.set(p.slug, parseRelations(p.body));
      slugSet.add(p.slug);
    }
    const missing = computeMissingInverses({
      pageRelations, slugSet, schema, fromSlugs: touched,
    });
    if (missing.length) {
      const byTarget = groupByTarget(missing);
      for (const [target, items] of byTarget.entries()) {
        const p = wikiPath(target);
        const raw = fs.readFileSync(p, 'utf-8');
        const { fm: tfm, body: tbody } = parseFrontmatter(raw);
        let newBody = tbody;
        const additions = items.map((it) => `- ${it.verb} [[${it.fromSlug}]]`);
        if (newBody.length && !newBody.endsWith('\n')) newBody += '\n';
        newBody += additions.join('\n') + '\n';
        tfm.updated = nowISO();
        fs.writeFileSync(p, serializeFrontmatter(tfm, newBody));
        // No commit here (A1): the deferred final commit below captures these
        // inverse writes along with the index + autolink edits.
        // Update snapshot + ensure the target is in `touched` so the audit
        // and autolink steps see its updated state. `touched` is an Array
        // built upstream via dedup, so guard against duplicate insertion.
        const entry = postFlushBySlug.get(target);
        if (entry) { entry.body = newBody; entry.fm = tfm; }
        if (!touched.includes(target)) touched.push(target);
      }
      console.log(`# inverse-closure: +${missing.length} relation(s) on ${byTarget.size} page(s)`);
    }
  }

  // 5) Bidirectional autolink on touched slugs. Failures are non-fatal but
  // tracked: a single slug failing is a warning, but if more than half of
  // touched slugs fail we treat it as material breakage and exit 2.
  // titleMap reuses the snapshot (no third walk).
  const titleMap = buildTitleEntries(postFlushPages);
  titleMap.sort((a, b) => b.title.length - a.title.length);
  const autolinkFailures = [];
  for (const slug of touched) {
    try { autolinkSlug(slug, { direction: 'both', dryRun: false, verbose: false, titleMap, log: false }); }
    catch (e) { autolinkFailures.push({ slug, message: e.message }); }
  }

  // A1: single DEFERRED commit, after every write (flushed pages + regenerated
  // index + inverse-closure edits + autolink body edits). This is the only
  // commit cmdIngest makes; it guarantees a clean working tree regardless of
  // the audit outcome below, so the next `wiki` command is never tamper-blocked
  // and autolink edits are no longer silently left for a later `bless`.
  appendLog('ingest', `${created.length} created, ${modified.length} modified, ${skipped.length} skipped`);

  // 6) Audit touched slugs from the snapshot (no per-slug disk re-read).
  // Note: autolinkSlug may have updated some pages above; for the post-flush
  // audit window we accept the snapshot's pre-autolink view (the autolink
  // changes only add wikilinks to bodies, never alter the FM fields the
  // audit rules inspect).
  const auditDeps = { schema: loadSchema(), knownVerbs: knownRelationVerbs(loadSchema()) };
  const auditResults = {};
  for (const slug of touched) {
    const p = postFlushBySlug.get(slug);
    if (!p) { auditResults[slug] = { score: 0, issues: [] }; continue; }
    auditResults[slug] = auditPage(
      { slug: p.slug, title: p.title, type: p.type, tags: p.tags, body: p.body, fm: p.fm },
      auditDeps,
    );
  }

  // 7) Summary
  console.log(`# ingest complete: ${created.length} created, ${modified.length} modified, ${skipped.length} skipped`);
  if (created.length) console.log(`  created: ${created.join(', ')}`);
  if (modified.length) console.log(`  modified: ${modified.join(', ')}`);
  if (skipped.length) console.log(`  skipped (already exist): ${skipped.join(', ')}`);
  if (autolinkFailures.length) {
    console.error('');
    console.error(`# autolink failures: ${autolinkFailures.length}/${touched.length}`);
    for (const f of autolinkFailures) console.error(`  ${f.slug}: ${f.message}`);
  }
  // C4: only medium+ severity blocks (exit 2). Low-severity issues (e.g. the
  // by-design `multi-fact-observation` density flag) are advisory — they no
  // longer force a non-zero exit nor pressure needless "fixes". The tree is
  // already committed above (A1), so a low-only ingest exits 0 with a clean
  // tree and no bless required.
  // Blocking threshold = medium+ (severityScore >= 2), using the shared
  // severity scale from audit.js so "what blocks" has one definition.
  const isBlocking = (r) => Array.isArray(r.issues) && r.issues.some((i) => severityScore(i.severity) >= 2);
  const blocking = Object.entries(auditResults).filter(([_, r]) => isBlocking(r));
  const lowOnly = Object.entries(auditResults).filter(([_, r]) => !isBlocking(r) && r.score > 0);
  const lowCount = lowOnly.reduce((n, [, r]) => n + (r.issues ? r.issues.length : 0), 0);
  // F3: batch audit summary by severity across the touched slugs.
  const sevTally = { high: 0, medium: 0, low: 0 };
  for (const [, r] of Object.entries(auditResults)) {
    for (const i of (r.issues || [])) sevTally[i.severity] = (sevTally[i.severity] || 0) + 1;
  }
  console.log(`# audit summary: ${sevTally.high} high, ${sevTally.medium} medium, ${sevTally.low} low across ${touched.length} page(s)`);
  // C2: warn if one hook is over-applied across this batch (a stopword anchor).
  const batchHooks = touched.map((s) => { const p = postFlushBySlug.get(s); return p && Array.isArray(p.fm.hooks) ? p.fm.hooks : []; });
  for (const w of batchHookWarnings(batchHooks)) console.error(`[hint] ${w}`);
  const autolinkRatio = touched.length ? autolinkFailures.length / touched.length : 0;
  const autolinkMaterial = autolinkRatio > 0.5;
  if (replayMsgId && !args.replay) {
    captureReplayResult(replayMsgId, {
      exitCode: (blocking.length === 0 && !autolinkMaterial) ? 0 : 2,
      created, modified, skipped,
      audit_dirty: blocking.length,
      autolink_failures: autolinkFailures.length,
      errors: [],
    });
  }
  if (blocking.length === 0) {
    console.log(lowCount
      ? `audit: clean (${lowCount} low-severity advisor${lowCount === 1 ? 'y' : 'ies'}, non-blocking)`
      : 'audit: all touched pages clean');
  } else {
    console.error('');
    console.error('# audit issues on ingested pages (medium+ blocks; low-severity is advisory):');
    for (const [slug, r] of blocking) {
      console.error(`  ${slug} (score ${r.score}):`);
      for (const i of r.issues) console.error(`    [${i.severity}] ${i.rule}: ${i.detail}`);
    }
    console.error(`  → fix the medium/high issues via 'wiki patch <slug> ...' before next ingestion`);
    process.exit(2);
  }
  if (autolinkMaterial) {
    console.error(`error: autolink failed on >50% of touched pages (${autolinkFailures.length}/${touched.length}); ingest succeeded but downstream link rewriting did not`);
    process.exit(2);
  }
}

module.exports = { cmdIngest };
