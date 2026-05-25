// commands/write.js — `wiki write`: create / append / replace a page.
//
// The most validated write path: slug/type/tag gate (validateForWrite),
// ironclad closed-set vocab check (not --soft-bypassable), strict body
// validation (--soft + narrow per-rule escape hatches), then serialize with
// minted obs-ids, regenerate the index, append the log + auto-commit, run the
// post-write audit, and warn on orphan-by-construction. Pure validation lives
// in lib/write-validate.js; side-effects in lib/page-io.js; audit in
// lib/audit-runtime.js. This file is orchestration.

'use strict';

const fs = require('fs');
const { WIKI_DIR, SCHEMA_PATH, wikiPath, nowISO, forEachPage, listWikiPages } = require('../lib/vault.js');
const { KNOWN_TYPES, loadSchema: _loadSchema, knownRelationVerbs } = require('../lib/schema.js');
const { parseFrontmatter, serializeFrontmatter } = require('../lib/frontmatter.js');
const { readPageForWrite, regenerateIndex, appendLog } = require('../lib/page-io.js');
const { validateForWrite, validateBody, warnHooks } = require('../lib/write-validate.js');
const { postWriteAudit } = require('../lib/audit-runtime.js');
const { ironcladRuleErrors } = require('../lib/audit.js');
const { validateAliasArg, applyExtraFrontmatter, aliasWarnings } = require('../lib/maintenance.js');
const { mintIdsForBody } = require('../lib/obsid.js');
const { extractWikilinks, backlinkRegex } = require('../lib/graph.js');
const { redactSecrets } = require('../lib/secrets.js');

const loadSchema = () => _loadSchema(SCHEMA_PATH);

function cmdWrite(args) {
  const slug = args._[0];
  if (!slug) {
    console.error('Usage: wiki write <slug> --title "..." --type <type> [--tags a,b] [--content "..." | --stdin] [--append|--replace]');
    console.error(`  types: ${[...KNOWN_TYPES].join('|')}`);
    process.exit(1);
  }

  fs.mkdirSync(WIKI_DIR, { recursive: true });
  const filePath = wikiPath(slug);
  const exists = fs.existsSync(filePath);

  if (exists && !args.append && !args.replace) {
    console.error(`error: page ${slug} exists; use --append (add to body) or --replace (overwrite)`);
    process.exit(2);
  }
  if (exists) {
    const existingFm = parseFrontmatter(fs.readFileSync(filePath, 'utf-8')).fm;
    if (existingFm.source_file) {
      console.error(`error: page ${slug} is auto-rendered from ${existingFm.source_file}. Use \`wiki measure\` to add a row, or edit the source file directly.`);
      process.exit(2);
    }
  }

  // For create / replace: validate.
  const isAppend = !!args.append && exists;
  const explicitType = args.type;
  const tags = args.tags ? String(args.tags).split(',').map((s) => s.trim()).filter(Boolean) : [];

  if (!isAppend) {
    const validationErrors = validateForWrite({
      slug,
      type: explicitType,
      tags,
      derivedFrom: args.derived_from,
    }, { isAppend });
    if (validationErrors.length) {
      console.error('error: write validation failed:');
      for (const e of validationErrors) console.error(`  ${e}`);
      process.exit(3);
    }
  }

  // HR07: refuse aliases containing `,` or `]` on both create and append paths.
  const aliasErrors = validateAliasArg(args.aliases);
  if (aliasErrors.length) {
    for (const e of aliasErrors) console.error(`error: ${e}`);
    process.exit(3);
  }

  let body = '';
  if (args.stdin) body = fs.readFileSync(0, 'utf-8');
  else if (args.content) body = args.content;

  // Ironclad-rule check: closed-set schema vocabulary violations (unknown
  // [category] prefixes, unknown relation verbs) cannot be bypassed by --soft.
  // Compute the prospective full body so append mode is also checked end-to-end.
  let ironcladBodyText = body;
  if (isAppend) {
    const cur = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
    ironcladBodyText = cur.body.trimEnd() + (body ? '\n\n' + body : '') + '\n';
  }
  const ironcladDeps = { schema: loadSchema(), knownVerbs: knownRelationVerbs(loadSchema()) };
  const ironcladErrors = ironcladRuleErrors({ body: ironcladBodyText }, ironcladDeps);
  if (ironcladErrors.length) {
    console.error('error: ironclad validation failed (closed-set schema vocab; --soft does NOT bypass):');
    for (const e of ironcladErrors) {
      console.error(`  [${e.rule}] ${e.message}`);
      if (e.fix) console.error(`    → fix: ${e.fix}`);
    }
    process.exit(3);
  }

  // Strict body-level validation (rejects unless --soft)
  // For append: validate the FULL resulting body (existing + new).
  if (!args.soft) {
    let validateFm = {};
    let validateBodyText = body;
    if (isAppend) {
      const cur = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
      validateFm = { ...cur.fm };
      validateBodyText = cur.body.trimEnd() + (body ? '\n\n' + body : '') + '\n';
    } else {
      // Build the prospective frontmatter shape (only fields validateBody inspects)
      validateFm = { ...args };
      // Normalize fields that come in as flags
      if (args.derived_from && typeof args.derived_from === 'string') {
        validateFm.derived_from = args.derived_from.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
    let bodyErrors = validateBody({
      slug,
      title: args.title || (isAppend ? validateFm.title : slug),
      type: isAppend ? (validateFm.type || 'note') : (explicitType || 'note'),
      tags: isAppend ? (Array.isArray(validateFm.tags) ? validateFm.tags : tags) : tags,
      body: validateBodyText,
      fm: validateFm,
    });
    // HR-OOB-D: narrow escape hatch — bypass only the two alias-class strict
    // rules. Other strict rules (missing-provenance, invented-verb, etc.) still
    // apply. Intended for legitimate placeholder-alias workflows.
    if (args['force-alias']) {
      bodyErrors = bodyErrors.filter((e) => e.rule !== 'non-functional-alias' && e.rule !== 'alias-collision');
    }
    // --allow-secret: bypass only the contains-secret strict rule. The user
    // has audited the body and accepts that this value will live in git
    // history forever (e.g. dummy/test credentials, a public-domain example).
    if (args['allow-secret']) {
      bodyErrors = bodyErrors.filter((e) => e.rule !== 'contains-secret');
    }
    // --force-duplicate: bypass only the exact-duplicate-observation rule.
    // For the rare intentional re-statement (two parallel observations with
    // distinct provenance) — narrower than --soft, which would bypass every
    // strict rule.
    if (args['force-duplicate']) {
      bodyErrors = bodyErrors.filter((e) => e.rule !== 'exact-duplicate-observation');
    }
    if (bodyErrors.length) {
      console.error('error: strict body validation failed (bypass with --soft):');
      for (const e of bodyErrors) {
        console.error(redactSecrets(`  [${e.rule}] ${e.message}`));
        if (e.fix) console.error(redactSecrets(`    → fix: ${e.fix}`));
      }
      process.exit(3);
    }
  }

  // Wrap applyExtraFrontmatter — typed validators in maintenance.js may throw
  // on bad input (e.g. --visibility=secret). Convert to a clean exit-3 error
  // matching the strict-validation genre.
  const tryApplyExtra = (fm) => {
    try { applyExtraFrontmatter(fm, args); }
    catch (e) { console.error(`error: ${e.message}`); process.exit(3); }
    if (args.hooks) warnHooks(args.hooks);
    if (args.alias) for (const w of aliasWarnings(args.alias)) console.error(`[hint] ${w}`); // V6
  };

  let op = 'create';
  if (isAppend) {
    const { fm, body: curBody } = readPageForWrite(filePath);
    fm.updated = nowISO();
    tryApplyExtra(fm);
    const newBody = curBody.trimEnd() + (body ? '\n\n' + body : '') + '\n';
    // Mint obs-ids on any observation lines that don't yet have one. Idempotent
    // — existing markers in curBody pass through untouched, only fresh lines
    // from the append pick up new ids.
    fs.writeFileSync(filePath, serializeFrontmatter(fm, mintIdsForBody(newBody)));
    op = 'append';
  } else {
    let created = nowISO();
    let preservedHooks = null;
    if (exists && args.replace) {
      const cur = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
      if (cur.fm.created) created = cur.fm.created;
      // D1: --replace writes fresh frontmatter; without this it silently dropped
      // the page's `hooks` (the core graph-linking metadata). Preserve them
      // unless --hooks is explicitly passed (which overrides).
      if (!args.hooks && Array.isArray(cur.fm.hooks) && cur.fm.hooks.length) preservedHooks = cur.fm.hooks;
      op = 'replace';
    }
    const title = args.title || slug;
    const fm = {
      id: slug,
      title,
      type: explicitType || 'note',
      created,
      updated: nowISO(),
      tags,
    };
    tryApplyExtra(fm);
    if (preservedHooks && !fm.hooks) fm.hooks = preservedHooks;
    const finalBody = body.endsWith('\n') ? body : body + '\n';
    fs.writeFileSync(filePath, serializeFrontmatter(fm, mintIdsForBody(finalBody)));
  }

  regenerateIndex();
  appendLog(op, slug);
  console.log(filePath);

  // Post-write audit hook
  postWriteAudit(slug);

  // Warn on orphan-by-construction (create only, not append/replace)
  if (op === 'create' && !args['no-anchor']) {
    const writtenBody = body;
    const hasOutbound = extractWikilinks(writtenBody).length > 0;
    let hasInbound = false;
    if (!hasOutbound) {
      const re = backlinkRegex(slug);
      forEachPage(({ slug: fromSlug, body: b }) => {
        if (fromSlug === slug) return;
        if (re.test(b)) { hasInbound = true; return false; }
      });
    }
    if (!hasOutbound && !hasInbound && listWikiPages().length > 1) {
      console.error('');
      console.error(`warning: ${slug} is being created with no inbound or outbound graph connections (orphan).`);
      console.error('  Consider:');
      console.error(`  - Adding a relation in body (e.g. - works_at [[some-slug]])`);
      console.error(`  - Running 'wiki place "<title>"' to find a better home`);
      console.error(`  - Running 'wiki autolink ${slug}' to scan for bidirectional links`);
      console.error('Use --no-anchor to suppress this warning for genuine root pages.');
      appendLog('orphan-warning', slug);
    }
  }
}

module.exports = { cmdWrite };
