// commands/hygiene.js — vault maintenance verbs (all auto-commit unless noted):
//   bless, audit, fix-links, groom, size, sync-ids, reindex, preflight, migrate.
// Pure logic lives in bin/lib (audit/auditVault, schema, inverse-closure,
// autolink-runtime, page-io); these handlers are fs-touching wrappers + CLI I/O.
// auditAll + formatAuditPage are audit internals (not exported).

'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter, serializeFrontmatter, migratePage, CURRENT_SCHEMA_VERSION } = require('../lib/frontmatter.js');
const { knownRelationVerbs, loadSchema: _loadSchema } = require('../lib/schema.js');
const { extractWikilinks, parseRelations } = require('../lib/graph.js');
const { mintIdsForBody } = require('../lib/obsid.js');
const { auditVault } = require('../lib/audit.js');
const { redactSecrets } = require('../lib/secrets.js');
const { computeMissingInverses, groupByTarget } = require('../lib/inverse-closure.js');
const { VAULT_ROOT, WIKI_DIR, SCHEMA_PATH, INDEX_PATH, nowISO, wikiPath, listWikiPages, forEachPage } = require('../lib/vault.js');
const { buildTitleMap, autolinkSlug } = require('../lib/autolink-runtime.js');
const { regenerateIndex, appendLog, autoCommit } = require('../lib/page-io.js');
const { auditSlug } = require('../lib/audit-runtime.js');
const { loadConfig } = require('../lib/config.js');
const { applyInboxSourceMigration } = require('../lib/inbox-migration.js');
const {
  ALFRED_BIRD_AUTH_TOKEN_ENV,
  ALFRED_BIRD_BIN_ENV,
  ALFRED_BIRD_CT0_ENV,
  resolveBirdBackend,
} = require('../lib/twitter-read.js');

const loadSchema = () => _loadSchema(SCHEMA_PATH);

// `wiki bless` — accept the current (out-of-band) vault state by committing it.
// The remedy for a tamper-check block when the manual edit was intentional.
function cmdBless() {
  const gitDir = path.join(VAULT_ROOT, '.git');
  if (!fs.existsSync(gitDir)) {
    console.error('bless: vault is not a git repo — nothing to bless.');
    return;
  }
  // A2: a reflexive `bless` must never be a blind all-state commit. Show
  // exactly what is being accepted, and call out anything beyond wiki/index.md
  // (the file the CLI itself regenerates) so a genuine out-of-band edit is not
  // absorbed without scrutiny. With A1 fixed, bless should rarely be needed.
  let changed = [];
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: VAULT_ROOT, encoding: 'utf-8' });
    changed = (r.stdout || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean);
  } catch { /* fall through to commit */ }
  if (!changed.length) {
    console.log('bless: working tree already clean — nothing to bless.');
    return;
  }
  console.error(`bless: accepting ${changed.length} change(s):`);
  for (const c of changed.slice(0, 30)) console.error(`  ${c}`);
  if (changed.length > 30) console.error(`  … ${changed.length - 30} more`);
  const nonIndex = changed.filter((c) => !/\bwiki\/index\.md$/.test(c));
  if (nonIndex.length) {
    console.error(`  NOTE: ${nonIndex.length} change(s) beyond wiki/index.md — review the list above; these are genuine out-of-band edits.`);
  }
  appendLog('bless', `accepted ${changed.length} out-of-band vault change(s)`, { all: true });
  console.log('blessed: current vault state committed as accepted.');
}

// Vault-wide audit — fs-touching wrapper around bin/lib/audit.js::auditVault.
// HR05: the cross-page audit logic lives in the lib; this wrapper just builds
// the page snapshot from the file system and hands it to the pure core.
function auditAll(opts = {}) {
  const schema = loadSchema();
  const knownVerbs = knownRelationVerbs(schema);
  const pages = [];
  forEachPage(({ slug, fm, body }) => {
    pages.push({
      slug,
      fm,
      body,
      type: fm.type || 'note',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      title: String(fm.title || slug),
    });
  });
  return auditVault({ pages, schema, knownVerbs });
}

function formatAuditPage(slug, result) {
  const lines = [];
  if (result.score === 0) {
    lines.push(`# audit ${slug}: clean`);
    return lines.join('\n');
  }
  lines.push(`# audit ${slug}: ${result.issues.length} issue(s), score ${result.score}`);
  for (const i of result.issues) {
    lines.push(redactSecrets(`  [${i.severity}] ${i.rule}: ${i.detail}`));
    if (i.fix) lines.push(redactSecrets(`    → fix: ${i.fix}`));
    if (i.examples) for (const ex of i.examples) lines.push(redactSecrets(`     · ${ex}`));
  }
  return lines.join('\n');
}

function cmdAudit(args) {
  const slug = args._[0];
  if (args.all) {
    const { perPage, hotMentions } = auditAll();
    // F2: machine-readable full result.
    if (args.json) {
      console.log(JSON.stringify({ pages: perPage, hotMentions }, null, 2));
      process.exit(perPage.some((p) => p.score > 0) ? 2 : 0);
    }
    // F2: list EVERY page failing a specific rule (no truncation), with the
    // per-page detail — replaces reverse-engineering the predicate by hand.
    if (args.rule) {
      const rule = String(args.rule);
      const hits = perPage
        .filter((p) => p.issues.some((i) => i.rule === rule))
        .sort((a, b) => b.score - a.score);
      console.log(`# pages failing rule "${rule}": ${hits.length}`);
      for (const p of hits) {
        const detail = (p.issues.find((i) => i.rule === rule) || {}).detail || '';
        console.log(`  ${p.slug}\t${detail}`);
      }
      process.exit(hits.length ? 2 : 0);
    }
    const dirty = perPage.filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
    console.log(`# vault audit: ${perPage.length} pages, ${dirty.length} with issues`);
    if (dirty.length === 0) {
      console.log('clean');
    } else {
      console.log('');
      // Per-rule histogram. Skip 'advisory'-severity issues (e.g. edge-aptness)
      // — they are non-scoring, query-only nets surfaced via --rule, kept out of
      // the default view so they don't raise the noise floor.
      const ruleCounts = {};
      for (const p of perPage) {
        for (const i of p.issues) {
          if (i.severity === 'advisory') continue;
          ruleCounts[i.rule] = (ruleCounts[i.rule] || 0) + 1;
        }
      }
      console.log('## by rule');
      for (const [rule, count] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${count}\t${rule}`);
      }
      console.log('');
      console.log('## top offenders');
      for (const p of dirty.slice(0, 20)) {
        const visibleIssues = p.issues.filter((i) => i.severity !== 'advisory');
        console.log(`  score=${p.score}\t${p.slug}\t(${visibleIssues.map((i) => i.rule).join(', ')})`);
      }
      if (dirty.length > 20) console.log(`  ... ${dirty.length - 20} more`);
    }
    if (hotMentions.length) {
      console.log('');
      console.log('## hot-text mentions (potential stubs)');
      for (const h of hotMentions.slice(0, 15)) {
        console.log(`  ${h.count}\t"${h.phrase}"\t(in: ${h.pages.join(', ')})`);
      }
    }
    process.exit(dirty.length > 0 ? 2 : 0);
  }
  if (!slug) {
    console.error('Usage: wiki audit <slug>   |   wiki audit --all');
    process.exit(1);
  }
  if (!fs.existsSync(wikiPath(slug))) {
    console.error(`error: page ${slug} does not exist`);
    process.exit(1);
  }
  const result = auditSlug(slug);
  console.log(formatAuditPage(slug, result));
  process.exit(result.score > 0 ? 2 : 0);
}

// `wiki fix-links` — repair nested-wikilink corruption `[[A[[B]]C]]` (a link
// injected inside an existing target by the old autolink bug, G1). Collapses to
// `[[ABC]]`, but ONLY when the collapsed slug resolves to a real page — so it
// never fabricates a wrong target (the case where autolink REPLACED text rather
// than just bracketing it; those it reports and leaves for manual repair).
// Read-only by default; --apply writes (single commit).
function cmdFixLinks(args) {
  const NEST = /\[\[([^[\]]*)\[\[([^[\]]*)\]\]([^[\]]*)\]\]/;
  const fixable = [];
  const skipped = [];
  forEachPage(({ slug, fm, body }) => {
    if (!NEST.test(body)) return;
    let fixed = body;
    const collapsed = [];
    while (NEST.test(fixed)) {
      fixed = fixed.replace(NEST, (_, a, b, c) => { const t = `${a}${b}${c}`; collapsed.push(t); return `[[${t}]]`; });
    }
    const bad = collapsed.filter((t) => !/^[a-z0-9][a-z0-9-]*$/.test(t) || !fs.existsSync(wikiPath(t)));
    if (bad.length) { skipped.push({ slug, bad }); return; }
    fixable.push({ slug, fm, fixed, collapsed });
  });
  if (!fixable.length && !skipped.length) { console.log('fix-links: no nested [[...]] corruption found.'); return; }
  for (const h of fixable) console.log(`fixable  ${h.slug} → ${[...new Set(h.collapsed)].map((t) => `[[${t}]]`).join(', ')}`);
  for (const s of skipped) console.error(`SKIP     ${s.slug}: collapsed target(s) resolve to no page (${s.bad.join(', ')}) — repair by hand (text was replaced, not just bracketed)`);
  if (!args.apply) { console.log(`\n(dry-run; ${fixable.length} fixable, ${skipped.length} need manual repair. Re-run with --apply.)`); return; }
  for (const h of fixable) {
    h.fm.updated = nowISO();
    fs.writeFileSync(wikiPath(h.slug), serializeFrontmatter(h.fm, h.fixed));
  }
  if (fixable.length) { regenerateIndex(); appendLog('fix-links', `repaired ${fixable.length} page(s)`); }
  console.log(`fix-links: repaired ${fixable.length} page(s)${skipped.length ? `, ${skipped.length} skipped (manual)` : ''}.`);
}

function cmdMigrateInboxSources(args) {
  const dryRun = !!args['dry-run'];
  const prefix = args.prefix || 'inbox';
  const kind = args.kind || 'transcripts';
  let result;
  try {
    result = applyInboxSourceMigration({ vaultRoot: VAULT_ROOT, prefix, kind, dryRun });
  } catch (e) {
    if (e.code === 'MIGRATION_BLOCKED' && e.plan) {
      console.error(`migrate-inbox-sources: blocked (${e.plan.blocked.length} destination collision${e.plan.blocked.length === 1 ? '' : 's'})`);
      for (const b of e.plan.blocked) console.error(`  ${b.oldRel} -> ${b.newRel}: ${b.reason}`);
      process.exit(2);
    }
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  const mode = dryRun ? 'migrate-inbox-sources --dry-run' : 'migrate-inbox-sources';
  console.log(`${mode}: ${result.candidates.length} referenced inbox source${result.candidates.length === 1 ? '' : 's'} under ${prefix}`);
  for (const m of result.candidates) {
    console.log(`  ${m.oldRel} -> ${m.newRel} (${m.occurrenceCount} reference${m.occurrenceCount === 1 ? '' : 's'} in ${m.pages.length} page${m.pages.length === 1 ? '' : 's'})`);
  }
  if (result.unreferenced.length) {
    console.log(`  skipped ${result.unreferenced.length} unreferenced inbox file${result.unreferenced.length === 1 ? '' : 's'}`);
  }

  if (dryRun) return;
  if (result.migrated > 0) {
    regenerateIndex();
    appendLog('migrate-inbox-sources', `moved ${result.migrated} inbox source(s) to raw/${kind}`, { all: true });
  }
  console.log(`migrated ${result.migrated} source${result.migrated === 1 ? '' : 's'}; rewrote ${result.rewriteCount} reference${result.rewriteCount === 1 ? '' : 's'} across ${result.rewrittenPages} wiki page${result.rewrittenPages === 1 ? '' : 's'}`);
}

function cmdGroom(args) {
  // Only mechanical mode is implemented today. The flag is accepted for
  // explicitness but the default behavior is also mechanical.
  if (args.propose || args.apply) {
    console.error('error: --propose and --apply are not implemented; only --mechanical (or no flag) works');
    process.exit(1);
  }
  const dryRun = args['dry-run'];
  const schema = loadSchema();
  const pages = listWikiPages();
  const slugSet = new Set(pages.map((f) => f.replace(/\.md$/, '')));

  console.log('# wiki groom --mechanical');
  console.log(`pages: ${pages.length}  symmetric verbs: ${schema.symmetric.size}  inverse pairs: ${schema.inverses.size}`);
  console.log('');

  // PASS 1: symmetric + inverse relation enforcement
  // Walk every page once and accumulate (a) parsed relations per slug and
  // (b) the wikilink reference counts that PASS 3 reuses for stub debt.
  const pageRelations = new Map(); // slug -> [{verb, target}]
  const referencedBy = new Map();  // slug -> count (consumed by PASS 3)
  forEachPage(({ slug, body }) => {
    pageRelations.set(slug, parseRelations(body));
    for (const t of extractWikilinks(body)) {
      referencedBy.set(t, (referencedBy.get(t) || 0) + 1);
    }
  });

  // Detect missing inverses (uses the shared pure helper; same logic that
  // cmdIngest's auto-closure step uses).
  const missing = computeMissingInverses({ pageRelations, slugSet, schema });

  console.log(`## symmetric/inverse relations`);
  if (missing.length === 0) {
    console.log('clean — all symmetric and inverse relations balanced');
  } else {
    console.log(`${missing.length} missing inverse relation(s):`);
    const byTarget = groupByTarget(missing);
    // groom's per-target preview includes the source-edge context (which the
    // helper drops to stay reusable). Reconstruct for the display only.
    const sourceByTargetVerb = new Map();
    for (const m of missing) sourceByTargetVerb.set(`${m.target}|${m.neededVerb}|${m.fromSlug}`, m.verb);
    for (const [target, items] of byTarget.entries()) {
      console.log(`  ${target}.md needs:`);
      for (const it of items) {
        const sourceVerb = sourceByTargetVerb.get(`${target}|${it.verb}|${it.fromSlug}`) || '?';
        console.log(`    - ${it.verb} [[${it.fromSlug}]]  (from ${it.fromSlug}.md: ${sourceVerb} [[${target}]])`);
      }
    }
    if (!dryRun) {
      for (const [target, items] of byTarget.entries()) {
        const p = wikiPath(target);
        const raw = fs.readFileSync(p, 'utf-8');
        const { fm, body } = parseFrontmatter(raw);
        let newBody = body;
        const additions = items.map((it) => `- ${it.verb} [[${it.fromSlug}]]`);
        if (newBody.length && !newBody.endsWith('\n')) newBody += '\n';
        newBody += additions.join('\n') + '\n';
        fm.updated = nowISO();
        fs.writeFileSync(p, serializeFrontmatter(fm, newBody));
        appendLog('groom-inverse', `${target}: +${items.length}`);
      }
      console.log(`fixed: ${missing.length} relation(s) added across ${byTarget.size} page(s)`);
    } else {
      console.log('(dry-run: no writes)');
    }
  }
  console.log('');

  // PASS 2: bidirectional autolink across all pages
  console.log('## bidirectional autolink');
  if (dryRun) {
    console.log('(dry-run: skipped)');
  } else {
    let injections = 0;
    const titleMap = buildTitleMap();
    for (const f of pages) {
      const slug = f.replace(/\.md$/, '');
      // Re-run autolink in both directions; verbose=false to keep groom output clean
      const before = fs.readFileSync(wikiPath(slug), 'utf-8');
      autolinkSlug(slug, { direction: 'both', dryRun: false, verbose: false, titleMap, log: false });
      const after = fs.readFileSync(wikiPath(slug), 'utf-8');
      if (before !== after) injections++;
    }
    console.log(injections === 0 ? 'clean — no new links to inject' : `${injections} page(s) updated with new wikilinks`);
  }
  console.log('');

  // PASS 3: report — stub debt (uses referencedBy built in PASS 1)
  console.log('## stub debt (top 10)');
  const stubs = [];
  for (const [slug, count] of referencedBy.entries()) {
    if (!fs.existsSync(wikiPath(slug))) stubs.push({ slug, count });
  }
  stubs.sort((a, b) => b.count - a.count);
  if (stubs.length === 0) console.log('clean — every wikilink resolves');
  else {
    for (const s of stubs.slice(0, 10)) console.log(`  ${s.count}\t${s.slug}`);
    if (stubs.length > 10) console.log(`  ... ${stubs.length - 10} more — run 'wiki stubs' for full list`);
  }
  console.log('');

  // PASS 4: report — remaining lint issues (terse)
  console.log('## remaining lint');
  console.log('(run `wiki lint` for details)');

  // V5: commit ONCE at the end (regenerated index + PASS-1 inverse writes +
  // PASS-2 autolink edits). The inverse-closure branch used to be the only
  // committer, so a groom that added no inverses (balanced vault) but did
  // regen the index / inject links left wiki/index.md (and autolinked pages)
  // uncommitted → tamper-block on the next command. Same fix shape as A1
  // (cmdIngest). appendLog runs autoCommit, which stages only wiki/ + raw/.
  if (!dryRun) {
    regenerateIndex();
    appendLog('groom', 'mechanical: inverse-closure + autolink + index');
  }
}

function cmdSize(args) {
  const threshold = parseInt(args.threshold || '150', 10);
  const rows = [];
  forEachPage(({ slug, fm, body }) => {
    const lines = body.split('\n').length;
    if (lines >= threshold) rows.push({ slug, lines, title: fm.title || '', type: fm.type || 'note' });
  });
  rows.sort((a, b) => b.lines - a.lines);
  if (rows.length === 0) { console.log(`(no pages above ${threshold} lines)`); return; }
  for (const r of rows) console.log(`${r.lines}\t${r.type}\t${r.slug}\t${r.title}`);
}

// `wiki sync-ids` does two id-sync jobs in one walk:
//   (1) align frontmatter `id:` with filename (legacy hygiene rule)
//   (2) mint <!--obs:XXXXXX--> markers on observation lines that lack one
// Both are idempotent. --dry-run reports what would change without writing.
function cmdSyncIds(args) {
  const fixed = []; // frontmatter id corrections
  const minted = []; // pages that gained one or more obs-id markers
  forEachPage(({ slug: filenameSlug, absPath, fm, body }) => {
    let pageChanged = false;
    let newBody = body;
    let newFm = fm;

    if (fm.id && fm.id !== filenameSlug) {
      if (args['dry-run']) {
        console.log(`${filenameSlug}: id=${fm.id} (would fix to ${filenameSlug})`);
      } else {
        newFm = { ...fm, id: filenameSlug, updated: nowISO() };
        fixed.push(filenameSlug);
        pageChanged = true;
      }
    }

    const minted_body = mintIdsForBody(body);
    if (minted_body !== body) {
      const before = (body.match(/<!--obs:[a-z0-9]{6}-->/g) || []).length;
      const after = (minted_body.match(/<!--obs:[a-z0-9]{6}-->/g) || []).length;
      const added = after - before;
      if (args['dry-run']) {
        console.log(`${filenameSlug}: would mint ${added} obs-id marker(s)`);
      } else {
        newBody = minted_body;
        // Bump `updated` only if it wasn't already bumped by the id-fix branch.
        if (newFm === fm) newFm = { ...fm, updated: nowISO() };
        minted.push(`${filenameSlug}(+${added})`);
        pageChanged = true;
      }
    }

    if (pageChanged) {
      fs.writeFileSync(absPath, serializeFrontmatter(newFm, newBody));
    }
  });
  if (!args['dry-run']) {
    if (fixed.length || minted.length) regenerateIndex();
    const parts = [];
    if (fixed.length) parts.push(`fm id fixed: ${fixed.length} (${fixed.join(', ')})`);
    if (minted.length) parts.push(`obs-ids minted: ${minted.length} (${minted.join(', ')})`);
    if (parts.length) {
      appendLog('sync-ids', parts.join('; '));
      for (const p of parts) console.log(p);
    } else {
      console.log('(nothing to sync)');
    }
  }
}

function cmdReindex() {
  regenerateIndex();
  console.log(INDEX_PATH);
}

function cmdPreflight(args) {
  const { execSync } = require('child_process');
  const results = [];
  const push = (name, status, msg, hint) => results.push({ name, status, msg, hint });
  let cfg = { paths: { bird_bin: '' } };
  let cfgError = null;
  try {
    cfg = loadConfig(VAULT_ROOT);
  } catch (e) {
    cfgError = e;
  }

  // Resolve a binary on PATH without throwing.
  const which = (bin) => {
    try {
      const out = execSync(`command -v ${bin}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
      return out.trim() || null;
    } catch { return null; }
  };

  // 1. Node version (>= 18). Stdlib only; no external check needed.
  {
    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (major >= 18) {
      push('node', 'PASS', `${process.versions.node}`);
    } else {
      push('node', 'FAIL', `${process.versions.node} (need >= 18)`,
        'Upgrade Node: nvm install 18 (or your distro\'s package manager).');
    }
  }

  // 2. git binary + .git directory.
  {
    const gitBin = which('git');
    const gitDir = path.join(VAULT_ROOT, '.git');
    if (!gitBin) {
      push('git', 'FAIL', 'git binary not on PATH',
        'Install git. Without it, auto-commit + revert are unavailable.');
    } else if (!fs.existsSync(gitDir)) {
      push('git', 'WARN', `binary OK but ${VAULT_ROOT}/.git missing`,
        'Initialize: cd ' + VAULT_ROOT + ' && git init && git add -A && git commit -m init');
    } else {
      push('git', 'PASS', `${gitBin}`);
    }
  }

  // 3. SCHEMA.md at vault root (canonical contract).
  if (fs.existsSync(SCHEMA_PATH)) {
    push('schema', 'PASS', `${SCHEMA_PATH}`);
  } else {
    push('schema', 'FAIL', `${SCHEMA_PATH} missing`,
      'Re-run install.sh ' + VAULT_ROOT + ' from the alfred_assistant repo, or copy docs/SCHEMA.md by hand.');
  }

  // 4. .alfred.yml (optional but recommended).
  const cfgPath = path.join(VAULT_ROOT, '.alfred.yml');
  if (cfgError) {
    push('config', 'FAIL', cfgError.message.split('\n')[0],
      'Fix .alfred.yml syntax/validation errors before relying on optional integrations or persona rendering.');
  } else if (fs.existsSync(cfgPath)) {
    push('config', 'PASS', `${cfgPath}`);
  } else {
    push('config', 'WARN', `${cfgPath} missing`,
      'Copy examples/.alfred.yml.example into the vault root and fill in user.slug / user.name / email.from.');
  }

  // 5. wiki/ directory.
  if (fs.existsSync(WIKI_DIR)) {
    const pageCount = listWikiPages().length;
    push('wiki-dir', 'PASS', `${pageCount} page${pageCount === 1 ? '' : 's'}`);
  } else {
    push('wiki-dir', 'WARN', `${WIKI_DIR} missing`,
      'Run `mkdir -p ' + WIKI_DIR + '`; it will be created on first write anyway.');
  }

  // 6. duckdb (optional — only needed for `wiki sql`).
  {
    const duckBin = which('duckdb');
    if (duckBin) push('duckdb', 'PASS', `${duckBin}`);
    else push('duckdb', 'WARN', 'not on PATH',
      '`wiki sql` will be unavailable. Install via brew/apt/etc. if you want SQL queries.');
  }

  // 7. curl (required by email-digest).
  {
    const curlBin = which('curl');
    if (curlBin) push('curl', 'PASS', `${curlBin}`);
    else push('curl', 'FAIL', 'not on PATH',
      'Install curl. email-digest cannot send mail without it.');
  }

  // 8. Optional live X/Twitter read adapter over bird.
  {
    const backend = resolveBirdBackend({
      env: process.env,
      config: cfg,
      which,
      cwd: VAULT_ROOT,
    });
    const authToken = !!process.env[ALFRED_BIRD_AUTH_TOKEN_ENV];
    const ct0 = !!process.env[ALFRED_BIRD_CT0_ENV];
    if (!backend) {
      push('twitter-read', 'WARN', 'bird backend unavailable',
        'Install `bird`, set ALFRED_BIRD_BIN, or set paths.bird_bin in .alfred.yml to enable .bin/twitter-read.');
    } else if (authToken !== ct0) {
      push('twitter-read', 'WARN',
        `${backend.bin} (${backend.source}); partial Alfred cookie env`,
        `Set both ${ALFRED_BIRD_AUTH_TOKEN_ENV} and ${ALFRED_BIRD_CT0_ENV}, or unset both and let bird use browser cookies / ~/.config/bird/config.json5.`);
    } else if (process.env[ALFRED_BIRD_BIN_ENV]) {
      push('twitter-read', 'PASS', `${backend.bin} (${backend.source})`);
    } else {
      push('twitter-read', 'PASS', `${backend.bin} (${backend.source})`);
    }
  }

  // 9. email-digest credentials + reachability.
  {
    const hasFrom = !!process.env.EMAIL_FROM;
    const hasPw = !!process.env.GMAIL_APP_PASSWORD;
    if (!hasFrom || !hasPw) {
      push('email-digest', 'SKIP',
        `env vars missing (EMAIL_FROM=${hasFrom ? 'set' : 'unset'}, GMAIL_APP_PASSWORD=${hasPw ? 'set' : 'unset'})`,
        'Set both in .env to enable the weekly digest. See docs/WEEKLY-DIGEST.md.');
    } else {
      const digestBin = path.join(VAULT_ROOT, '.bin', 'email-digest');
      const bin = fs.existsSync(digestBin) ? digestBin : 'email-digest';
      // Array-form spawnSync — EMAIL_FROM (env-var-controlled) is passed as a
      // separate argv entry. stdin set to "dryrun" so email-digest's BODY=$(cat)
      // doesn't hang.
      const { spawnSync } = require('child_process');
      const r = spawnSync(bin,
        ['--dry-run', '--subject', 'preflight', '--to', process.env.EMAIL_FROM],
        { encoding: 'utf-8', input: 'dryrun' });
      if (!r.error && r.status === 0) {
        push('email-digest', 'PASS', 'SMTP+auth reachable');
      } else {
        push('email-digest', 'FAIL', 'dry-run failed',
          'Run `bin/email-digest --dry-run --subject t --to ' + process.env.EMAIL_FROM + '` directly to see the error.');
      }
    }
  }

  // 10. wiki audit --all smoke. We don't FAIL on rule hits — only on execution
  // errors (broken SCHEMA.md, fs issues, etc.). Use the same vault-wide audit
  // surface as `wiki audit --all` so preflight cannot report a different
  // scoring baseline from the normal maintenance command.
  try {
    const { perPage } = auditAll();
    const dirtyCount = perPage.filter((p) => p.score > 0).length;
    const advisoryCount = perPage.reduce(
      (acc, p) => acc + p.issues.filter((i) => i.severity === 'advisory').length,
      0,
    );
    const advisorySuffix = advisoryCount
      ? `, ${advisoryCount} advisory finding${advisoryCount === 1 ? '' : 's'}`
      : '';
    push('audit-smoke', 'PASS',
      `${perPage.length} page${perPage.length === 1 ? '' : 's'}, ${dirtyCount} with scoring audit issue${dirtyCount === 1 ? '' : 's'}${advisorySuffix}`);
  } catch (e) {
    push('audit-smoke', 'FAIL', `execution error: ${e.message.split('\n')[0]}`,
      'Likely a malformed SCHEMA.md. Compare against docs/SCHEMA.md in the alfred_assistant repo.');
  }

  // ─── render ────────────────────────────────────────────────────────────
  const padName = Math.max(...results.map((r) => r.name.length));
  let failCount = 0, warnCount = 0;
  for (const r of results) {
    const tag = r.status.padEnd(4);
    const name = r.name.padEnd(padName);
    console.log(`  [${tag}]  ${name}   ${r.msg}`);
    if (r.status === 'FAIL') failCount++;
    if (r.status === 'WARN') warnCount++;
  }

  // Print hints below the table for items with FAIL/WARN.
  const withHints = results.filter((r) => r.hint && (r.status === 'FAIL' || r.status === 'WARN'));
  if (withHints.length) {
    console.log('');
    for (const r of withHints) console.log(`  ${r.name}: ${r.hint}`);
  }

  // Summary
  console.log('');
  if (failCount === 0) {
    const summary = `preflight: OK${warnCount ? ` (${warnCount} warning${warnCount === 1 ? '' : 's'})` : ''}`;
    console.log(summary);
    process.exit(0);
  } else {
    console.error(`preflight: ${failCount} check${failCount === 1 ? '' : 's'} failed${warnCount ? `, ${warnCount} warning${warnCount === 1 ? '' : 's'}` : ''}`);
    process.exit(1);
  }
}

function cmdMigrate(args) {
  const dryRun = !!args['dry-run'];
  // parseArgs already separates flags into top-level keys; positional args sit in args._
  const targets = args._.length > 0 ? args._ : null;

  const slugs = targets || listWikiPages().map((f) => f.replace(/\.md$/, ''));
  if (slugs.length === 0) {
    console.log('migrate: no wiki pages found');
    process.exit(0);
  }

  let stamped = 0;     // unversioned → CURRENT (no transforms in between)
  let migrated = 0;    // version < CURRENT (transforms applied)
  let unchanged = 0;   // already at CURRENT
  let errors = 0;
  const refused = [];  // pages with schema_version > CURRENT

  for (const slug of slugs) {
    const p = wikiPath(slug);
    if (!fs.existsSync(p)) {
      console.error(`migrate: page not found: ${slug}`);
      errors++;
      continue;
    }
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = parseFrontmatter(raw);
    const before = parsed.fm.schema_version;
    const beforeVersion = before == null ? 1 : Number(before);

    let result;
    try {
      result = migratePage(parsed.fm, parsed.body);
    } catch (e) {
      if (e.code === 'NEWER_CLI') {
        refused.push({ slug, version: beforeVersion });
        continue;
      }
      console.error(`migrate: ${slug}: ${e.message}`);
      errors++;
      continue;
    }

    // Decide what kind of change this is for reporting.
    if (before == null) {
      // Page was unversioned → now stamped. Even if no transforms ran (1 → 1),
      // the serializer will write schema_version: 1 into the file.
      stamped++;
    } else if (beforeVersion < CURRENT_SCHEMA_VERSION) {
      migrated++;
    } else {
      // Already at CURRENT and field is present — nothing to do.
      unchanged++;
      continue;
    }

    if (!dryRun) {
      fs.writeFileSync(p, serializeFrontmatter(result.fm, result.body));
    }
  }

  const total = slugs.length;
  const prefix = dryRun ? 'migrate --dry-run' : 'migrate';
  console.log(`${prefix}: ${total} page${total === 1 ? '' : 's'} scanned`);
  if (stamped > 0)   console.log(`  ${stamped} unversioned → v${CURRENT_SCHEMA_VERSION} (stamp)`);
  if (migrated > 0)  console.log(`  ${migrated} migrated through ${CURRENT_SCHEMA_VERSION - 1} step(s)`);
  if (unchanged > 0) console.log(`  ${unchanged} already at v${CURRENT_SCHEMA_VERSION}`);
  if (refused.length > 0) {
    console.error(`  ${refused.length} refused (page written by newer CLI):`);
    for (const r of refused) console.error(`    ${r.slug}.md (schema_version=${r.version})`);
  }
  if (errors > 0) console.error(`  ${errors} error(s)`);

  if (errors > 0 || refused.length > 0) process.exit(refused.length > 0 ? 2 : 1);
  process.exit(0);
}

module.exports = {
  cmdBless, cmdAudit, cmdFixLinks, cmdGroom, cmdSize,
  cmdSyncIds, cmdReindex, cmdPreflight, cmdMigrate,
  cmdMigrateInboxSources,
};
