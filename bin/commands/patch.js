// commands/patch.js — `wiki patch`: surgical edits to an existing page's
// observations, relations, and frontmatter fields, with inverse-closure on
// added/removed relations, obs-id minting, autolink, strict-body revalidation,
// and the post-write audit. The largest single write handler; pure logic lives
// in the libs it imports (graph/inverse-closure/write-validate/audit-runtime),
// this file is orchestration + fs.

'use strict';

const fs = require('fs');
const { nowISO, wikiPath, forEachPage, SCHEMA_PATH } = require('../lib/vault.js');
const { knownRelationVerbs, loadSchema: _loadSchema } = require('../lib/schema.js');
const { parseFrontmatter, serializeFrontmatter } = require('../lib/frontmatter.js');
const { aliasesOf, parseRelations, parseRelationLine } = require('../lib/graph.js');
const { mintIdsForBody } = require('../lib/obsid.js');
const { ironcladRuleErrors } = require('../lib/audit.js');
const { redactSecrets } = require('../lib/secrets.js');
const { computeMissingInverses, groupByTarget } = require('../lib/inverse-closure.js');
const { validateExtraFieldValue, aliasValueError, aliasWarnings } = require('../lib/maintenance.js');
const { autolinkSlug } = require('../lib/autolink-runtime.js');
const { readPageForWrite, regenerateIndex, appendLog } = require('../lib/page-io.js');
const { readTextSource } = require('../lib/text-input.js');
const { validateBody, warnHooks } = require('../lib/write-validate.js');
const { postWriteAudit } = require('../lib/audit-runtime.js');

const loadSchema = () => _loadSchema(SCHEMA_PATH);

function cmdPatch(args) {
  const slug = args._[0];
  if (!slug) {
    console.error('Usage: wiki patch <slug> [--observation "[fact] body #tag" | --observation-file <path> | --observation-stdin] [--relation "verb [[target]]"]');
    console.error('              [--add-tag <tag>] [--remove-tag <tag>] [--alias <name>]');
    console.error('              [--summary "..." | --summary-file <path> | --summary-stdin] [--title "..."] [--born YYYY-MM-DD | MM-DD]');
    console.error('              [--visibility private|personal|public] [--sensitive true|false] [--confidence 0.0-1.0]');
    process.exit(1);
  }
  const stdinConsumers = ['observation-stdin', 'summary-stdin'].filter((flag) => !!args[flag]);
  if (stdinConsumers.length > 1) {
    console.error('error: only one patch field can read from stdin per invocation');
    process.exit(1);
  }
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const { fm, body } = readPageForWrite(p);
  if (fm.source_file) {
    console.error(`error: page ${slug} is auto-rendered from ${fm.source_file}. Use \`wiki measure\` to add a row, or edit the source file directly.`);
    process.exit(2);
  }
  const schema = loadSchema();

  const ops = [];
  let newBody = body;
  let observationInput = null;
  let summaryInput = null;
  try {
    observationInput = readTextSource(args, {
      inlineFlag: 'observation',
      stdinFlag: 'observation-stdin',
      fileFlag: 'observation-file',
      label: 'observation text',
    });
    summaryInput = readTextSource(args, {
      inlineFlag: 'summary',
      stdinFlag: 'summary-stdin',
      fileFlag: 'summary-file',
      label: 'summary text',
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  // Supersede an old observation (do this BEFORE appending the replacement)
  if (args.supersede) {
    const needle = String(args.supersede);
    const lines = newBody.split('\n');
    const idx = lines.findIndex((l) => /^- (?:~~)?\[/.test(l) && l.includes(needle));
    if (idx < 0) {
      console.error(`error: no observation matching: ${needle}`);
      process.exit(3);
    }
    if (/^- ~~/.test(lines[idx])) {
      console.error(`error: already superseded: ${lines[idx]}`);
      process.exit(3);
    }
    const today = nowISO().slice(0, 10);
    // - [cat] body  →  - ~~[cat] body~~ [until YYYY-MM-DD]
    lines[idx] = lines[idx].replace(/^- (\[[a-z]+\][\s\S]+?)\s*$/, `- ~~$1~~ [until ${today}]`);
    newBody = lines.join('\n');
    ops.push(`supersede:${needle.slice(0, 30)}`);
  }

  // Append observation
  if (observationInput !== null) {
    const obs = String(observationInput).trim();
    // Allow "fact: body" or full "- [fact] body" or just "[fact] body"
    let line;
    if (/^- \[/.test(obs)) line = obs;
    else if (/^\[/.test(obs)) line = `- ${obs}`;
    else line = `- [fact] ${obs}`;
    newBody = newBody.trimEnd() + '\n' + line + '\n';
    ops.push(`obs:${line.slice(0, 50)}`);
  }

  // Append relation
  if (args.relation) {
    const rel = String(args.relation).trim();
    let line;
    if (/^- /.test(rel)) line = rel;
    else if (/^[a-z][a-z_]+ \[\[/.test(rel) || /^"[^"]+" \[\[/.test(rel)) line = `- ${rel}`;
    else if (/=/.test(rel)) {
      const [v, t] = rel.split('=').map((s) => s.trim());
      line = `- ${v} [[${t}]]`;
    } else {
      console.error(`error: invalid --relation: ${rel}; use 'verb [[target]]' or 'verb=target'`);
      process.exit(1);
    }
    // V4: idempotent add — skip if the (verb, target) edge already exists, so
    // re-running a patch/spec never doubles an edge (mirrors add_hooks dedup).
    const parsedRel = parseRelationLine(line);
    const dupRel = parsedRel && parseRelations(newBody)
      .some((r) => r.verb === parsedRel.verb && r.target === parsedRel.target);
    if (dupRel) {
      ops.push(`rel:(exists) ${line.slice(0, 40)}`);
    } else {
      newBody = newBody.trimEnd() + '\n' + line + '\n';
      ops.push(`rel:${line.slice(0, 50)}`);
    }
  }

  // Remove-relation — drop a typed relation from this page AND its registered
  // inverse from the target page (symmetric to --relation + inverse-closure).
  // This is the graph's only inverse-aware *removal*: deleting just one side
  // leaves a dangling edge that `wiki groom` / inverse-closure then resurrect
  // (they only ever ADD a missing inverse). The target-side strip runs after
  // the main write below, keyed off `relRemoval`.
  let relRemoval = null;
  if (args['remove-relation'] !== undefined && args['remove-relation'] !== false) {
    const spec = String(args['remove-relation']).trim().replace(/^- /, '');
    let rmVerb, rmTarget;
    const m = spec.match(/^("?[^"[]+?"?)\s+\[\[([^\]]+)\]\]$/);
    if (m) { rmVerb = m[1].trim().replace(/^"|"$/g, ''); rmTarget = m[2].trim(); }
    else if (spec.includes('=')) { const [v, t] = spec.split('=').map((s) => s.trim()); rmVerb = v; rmTarget = t; }
    if (!rmVerb || !rmTarget) {
      console.error(`error: invalid --remove-relation: ${args['remove-relation']}; use 'verb [[target]]' or 'verb=target'`);
      process.exit(1);
    }
    // Reuse the canonical relation-line parser (graph.js) so removal matches
    // exactly what the read path treats as a relation — no bespoke regex drift.
    const matchesRel = (ln, verb, target) => {
      const r = parseRelationLine(ln);
      return !!r && r.verb === verb && r.target === target;
    };
    const lines = newBody.split('\n');
    const kept = lines.filter((ln) => !matchesRel(ln, rmVerb, rmTarget));
    newBody = kept.join('\n');
    relRemoval = { verb: rmVerb, target: rmTarget, removedHere: lines.length - kept.length, matchesRel };
    ops.push(`rel-:${rmVerb} [[${rmTarget}]]`);
  }

  // Tag mutations
  let tags = Array.isArray(fm.tags) ? [...fm.tags] : [];
  if (args['add-tag']) {
    const t = String(args['add-tag']);
    if (schema.tags && !schema.tags.has(t)) {
      console.error(`error: tag "${t}" not in SCHEMA.md taxonomy; add to SCHEMA first`);
      process.exit(3);
    }
    if (!tags.includes(t)) { tags.push(t); ops.push(`+tag:${t}`); }
  }
  if (args['remove-tag']) {
    const t = String(args['remove-tag']);
    const before = tags.length;
    tags = tags.filter((x) => x !== t);
    if (tags.length !== before) ops.push(`-tag:${t}`);
  }
  fm.tags = tags;

  // Alias
  if (args.alias) {
    const a = String(args.alias);
    const aliasErr = aliasValueError(a);
    if (aliasErr) { console.error(`error: ${aliasErr}`); process.exit(3); }
    for (const w of aliasWarnings(a)) console.error(`[hint] ${w}`); // V6
    const aliases = [...aliasesOf(fm)];
    if (!aliases.includes(a)) { aliases.push(a); ops.push(`+alias:${a}`); }
    fm.aliases = aliases;
  }

  // Remove-alias — drop an alias (symmetric to --remove-tag / --remove-hooks).
  // The recovery path for a bad alias (previously removable only via git).
  if (args['remove-alias'] !== undefined && args['remove-alias'] !== false) {
    const a = String(args['remove-alias']);
    const before = aliasesOf(fm);
    const kept = before.filter((x) => x !== a);
    if (kept.length !== before.length) { fm.aliases = kept; ops.push(`-alias:${a}`); }
  }

  // Summary
  if (summaryInput !== null) {
    fm.summary = String(summaryInput).trim();
    ops.push('summary');
  }

  // Hooks — union connective keywords into frontmatter (comma-split, deduped).
  if (args.hooks !== undefined && args.hooks !== false) {
    const incoming = String(args.hooks).split(',').map((s) => s.trim()).filter(Boolean);
    const merged = Array.isArray(fm.hooks) ? [...fm.hooks] : [];
    for (const h of incoming) if (!merged.includes(h)) merged.push(h);
    fm.hooks = merged;
    ops.push(`hooks:+${incoming.length}`);
    warnHooks(incoming);
  }

  // Remove-hooks — set-difference symmetric to --hooks. The hygiene path: drop
  // a hook from a card whose own claim does not instantiate it (prunes the
  // spurious members of a diluted/over-applied hook). Only removes hooks that
  // are present; missing ones are a silent no-op.
  if (args['remove-hooks'] !== undefined && args['remove-hooks'] !== false) {
    const drop = new Set(String(args['remove-hooks']).split(',').map((s) => s.trim()).filter(Boolean));
    const before = Array.isArray(fm.hooks) ? fm.hooks : [];
    const kept = before.filter((h) => !drop.has(h));
    const removed = before.length - kept.length;
    fm.hooks = kept;
    if (removed) ops.push(`hooks:-${removed}`);
  }

  // notify — comma-split list (which channels a reminder fires on), mirroring
  // the hooks block above. Set independently of remind_at so a reminder's
  // channels can be edited in place.
  if (args.notify !== undefined && args.notify !== false) {
    fm.notify = String(args.notify).split(',').map((s) => s.trim()).filter(Boolean);
    ops.push(`notify:${fm.notify.join(',')}`);
  }

  // born / visibility / sensitive / confidence / remind_at / reminded_at —
  // typed frontmatter fields. Validation lives in
  // bin/lib/maintenance.js::validateExtraFieldValue so `wiki write` and
  // `wiki patch` share the contract. reminded_at is the dispatcher's
  // idempotency stamp (set via `wiki patch <slug> --reminded_at <ts>`).
  for (const f of ['born', 'visibility', 'sensitive', 'confidence', 'remind_at', 'reminded_at']) {
    if (args[f] === undefined || args[f] === false) continue;
    const { value, error } = validateExtraFieldValue(f, args[f]);
    if (error) { console.error(`error: ${error}`); process.exit(3); }
    fm[f] = value;
    ops.push(`${f}:${value}`);
  }

  // External-link fields (homepage, scholar, orcid, github, etc.)
  const EXTERNAL_LINK_FIELDS = ['homepage', 'scholar', 'orcid', 'github', 'linkedin', 'twitter', 'arxiv', 'email'];
  for (const f of EXTERNAL_LINK_FIELDS) {
    if (args[f] !== undefined && args[f] !== false) {
      fm[f] = String(args[f]);
      ops.push(`${f}`);
    }
  }

  // Title rename — also adds old title to aliases
  let titleChanged = false;
  if (args.title !== undefined && args.title !== false) {
    const oldTitle = fm.title;
    const newTitle = String(args.title);
    if (oldTitle && oldTitle !== newTitle) {
      // The old title is normally promoted to an alias so inbound links and
      // searches keep resolving. HR07 forbids `,`/`]` in aliases (round-trip
      // hazard). D2: rather than ABORT the rename (which blocked renaming any
      // declarative, comma-bearing card title — exactly the titles the card
      // standard mandates), skip the auto-alias with a warning when the old
      // title is alias-invalid, or whenever --no-alias is passed.
      const titleErr = aliasValueError(oldTitle);
      if (args['no-alias']) {
        // explicit opt-out: rename only, no alias promotion.
      } else if (titleErr) {
        console.error(`warning: old title not promoted to alias (${titleErr}); renamed without it. Pass --no-alias to silence this.`);
      } else {
        const aliases = [...aliasesOf(fm)];
        if (!aliases.includes(oldTitle)) aliases.push(oldTitle);
        fm.aliases = aliases;
      }
      ops.push(`title:${oldTitle}->${newTitle}`);
      titleChanged = true;
    }
    fm.title = newTitle;
  }

  if (ops.length === 0) {
    console.error('error: nothing to patch. Pass at least one of --observation, --relation, --remove-relation, --add-tag, --remove-tag, --alias, --summary, --title, --born, --visibility, --sensitive, --confidence, --remind_at, --reminded_at, --notify.');
    process.exit(1);
  }

  // Ironclad-rule check FIRST. Closed-set schema vocabulary violations
  // (uncategorized-bullets, invented-verb) and destructive empty-page writes
  // cannot be bypassed by --soft — they catch syntax / data-loss failures,
  // not discretionary nags.
  // Without this gate, `wiki patch <slug> --observation "[issue] ..." --soft`
  // would silently land an unparseable line. See audit findings (2026-05-19).
  {
    const ironcladDeps = { schema: loadSchema(), knownVerbs: knownRelationVerbs(loadSchema()) };
    const ironcladErrors = ironcladRuleErrors({
      slug,
      title: fm.title || slug,
      type: fm.type || 'note',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      body: newBody,
      fm,
    }, ironcladDeps);
    if (ironcladErrors.length) {
      console.error(`error: ironclad validation failed for ${slug} (schema/data-loss invariant; --soft does NOT bypass):`);
      for (const e of ironcladErrors) {
        console.error(`  [${e.rule}] ${e.message}`);
        if (e.fix) console.error(`    → fix: ${e.fix}`);
      }
      process.exit(3);
    }
  }

  // HR02: validate the prospective post-patch page against the same strict body
  // rules cmdWrite enforces. Without this, --observation can introduce a fact
  // without provenance, an invented-verb relation, or a relation to a forbidden
  // aggregator slug, with no rejection at write time — only the post-write
  // audit warns in stderr after the commit lands. --soft bypasses, matching
  // cmdWrite's escape hatch. See audit/12-coherence-robustness.md § validator-timing.
  if (!args.soft) {
    const type = fm.type || 'note';
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    let bodyErrors = validateBody({ slug, title: fm.title, type, tags, body: newBody, fm });
    // HR-OOB-D: same narrow escape hatch as cmdWrite.
    if (args['force-alias']) {
      bodyErrors = bodyErrors.filter((e) => e.rule !== 'non-functional-alias' && e.rule !== 'alias-collision');
    }
    if (args['allow-secret']) {
      bodyErrors = bodyErrors.filter((e) => e.rule !== 'contains-secret');
    }
    if (args['force-duplicate']) {
      bodyErrors = bodyErrors.filter((e) => e.rule !== 'exact-duplicate-observation');
    }
    if (bodyErrors.length) {
      console.error(`error: validation failed for ${slug}:`);
      for (const e of bodyErrors) {
        console.error(redactSecrets(`  [${e.rule}] ${e.message}`));
        if (e.fix) console.error(redactSecrets(`    → fix: ${e.fix}`));
      }
      console.error('  (bypass with --soft, e.g. wiki patch <slug> --observation "..." --soft)');
      process.exit(3);
    }
  }

  fm.updated = nowISO();
  // Mint obs-ids on any newly-added observation lines. Idempotent — pre-existing
  // markers pass through. Applied here so cmdPatch's --observation / --append
  // flows always land an id without each call-site needing to remember.
  fs.writeFileSync(p, serializeFrontmatter(fm, mintIdsForBody(newBody)));
  regenerateIndex();
  appendLog('patch', `${slug} (${ops.join(', ')})`);
  console.log(`patched: ${slug} (${ops.join(', ')})`);

  // Auto-inverse-closure: if this patch added a typed relation, ensure the
  // symmetric/inverse edge exists on the target page. Scoped to <slug> so
  // we don't drift into unrelated pages. Same helper that cmdIngest uses.
  // Skipped unless ops actually contain a relation add (cheap-path guard).
  if (ops.some((o) => typeof o === 'string' && o.startsWith('rel:'))) {
    const schema = loadSchema();
    const pageRelations = new Map();
    const slugSet = new Set();
    forEachPage(({ slug: s, body: b }) => {
      pageRelations.set(s, parseRelations(b));
      slugSet.add(s);
    });
    const missing = computeMissingInverses({
      pageRelations, slugSet, schema, fromSlugs: [slug],
    });
    if (missing.length) {
      const byTarget = groupByTarget(missing);
      for (const [target, items] of byTarget.entries()) {
        const tp = wikiPath(target);
        const traw = fs.readFileSync(tp, 'utf-8');
        const { fm: tfm, body: tbody } = parseFrontmatter(traw);
        let nb = tbody;
        const additions = items.map((it) => `- ${it.verb} [[${it.fromSlug}]]`);
        if (nb.length && !nb.endsWith('\n')) nb += '\n';
        nb += additions.join('\n') + '\n';
        tfm.updated = nowISO();
        fs.writeFileSync(tp, serializeFrontmatter(tfm, nb));
        appendLog('patch-inverse', `${target}: +${items.length}`);
      }
      console.log(`  inverse-closure: +${missing.length} on ${byTarget.size} page(s)`);
    }
  }

  // Remove-relation inverse cleanup: strip the registered inverse off the
  // target page so the edge is gone on BOTH sides. Without this, the next
  // `wiki groom` / inverse-closure re-adds the inverse and the relation
  // returns. Runs even when this page had no matching line (the caller may be
  // removing from the inverse side), so the target is always reconciled.
  if (relRemoval) {
    const schema = loadSchema();
    // Resolve the inverse verb BIDIRECTIONALLY. The schema's inverses Map is
    // one-directional (it stores left→right only), so a forward get() misses
    // when the caller names the right-hand verb (e.g. `author_of`, whose pair
    // is keyed `authored_by author_of`). Fall back to a reverse lookup so
    // removal strips the target regardless of which side the verb is on.
    let invVerb = null;
    if (schema.symmetric.has(relRemoval.verb)) invVerb = relRemoval.verb;
    else if (schema.inverses.has(relRemoval.verb)) invVerb = schema.inverses.get(relRemoval.verb);
    else { for (const [a, b] of schema.inverses) { if (b === relRemoval.verb) { invVerb = a; break; } } }
    let removedThere = 0;
    if (invVerb && relRemoval.target !== slug && fs.existsSync(wikiPath(relRemoval.target))) {
      const tp = wikiPath(relRemoval.target);
      const { fm: tfm, body: tbody } = parseFrontmatter(fs.readFileSync(tp, 'utf-8'));
      const tlines = tbody.split('\n');
      const tkept = tlines.filter((ln) => !relRemoval.matchesRel(ln, invVerb, slug));
      removedThere = tlines.length - tkept.length;
      if (removedThere) {
        tfm.updated = nowISO();
        fs.writeFileSync(tp, serializeFrontmatter(tfm, tkept.join('\n')));
        appendLog('patch-inverse-rm', `${relRemoval.target}: -${removedThere} (${invVerb} [[${slug}]])`);
      }
    }
    console.log(`  remove-relation: -${relRemoval.removedHere} on ${slug}` +
      (invVerb ? `, -${removedThere} on ${relRemoval.target} (inverse ${invVerb})` : ' (no registered inverse)'));
  }

  // Post-write audit hook
  postWriteAudit(slug);

  // If title/alias changed, run reverse-autolink so other pages can link to new title
  if (titleChanged || args.alias) {
    console.log('(running reverse-autolink for new title/alias...)');
    autolinkSlug(slug, { direction: 'in', verbose: false });
  }
}

module.exports = { cmdPatch };
