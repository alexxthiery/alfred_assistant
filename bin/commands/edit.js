// commands/edit.js — structural edit verbs that don't add page content:
// link (insert a wikilink), mv (rename + rewrite backlinks, atomic stage/flush),
// delete (with inbound-link guard).
//
// All deps are libs: validation/constants (schema), paths + iteration (vault),
// frontmatter (de)serialize, graph backlink regex + alias extraction, the
// side-effect helpers (page-io: readPageForWrite/regenerateIndex/appendLog),
// and the atomic multi-write flush (staged-writes). cmdMerge/cmdPatch live
// elsewhere: they add observations/relations and pull in the autolink +
// ingest-body helper cluster, which is extracted separately.

'use strict';

const fs = require('fs');
const path = require('path');
const { wikiPath, nowISO, forEachPage, SCHEMA_PATH } = require('../lib/vault.js');
const { validSlug, isReserved, loadSchema: _loadSchema } = require('../lib/schema.js');
const { parseFrontmatter, serializeFrontmatter } = require('../lib/frontmatter.js');
const { backlinkRegex, aliasesOf, parseRelations } = require('../lib/graph.js');
const { aliasValueError } = require('../lib/maintenance.js');
const { readPageForWrite, regenerateIndex, appendLog } = require('../lib/page-io.js');
const { flushStaged } = require('../lib/staged-writes.js');

const loadSchema = () => _loadSchema(SCHEMA_PATH);

function cmdLink(args) {
  const from = args._[0];
  const to = args._[1];
  if (!from || !to) { console.error('Usage: wiki link <from-slug> <to-slug>'); process.exit(1); }
  if (!validSlug(to)) { console.error(`error: invalid target slug: ${to}`); process.exit(1); }
  const fromPath = wikiPath(from);
  if (!fs.existsSync(fromPath)) { console.error(`error: page ${from} does not exist`); console.error(`  Hint: \`wiki resolve "${from}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const { fm, body } = readPageForWrite(fromPath);
  if (backlinkRegex(to).test(body)) { console.log(`already linked: ${from} -> ${to}`); return; }
  let newBody;
  if (/^## Links\b/m.test(body)) {
    newBody = body.replace(/^(## Links[\s\S]*?)(?=\n## |\s*$)/m, (m) => m.trimEnd() + `\n- [[${to}]]`);
  } else {
    newBody = body.trimEnd() + '\n\n## Links\n\n- [[' + to + ']]\n';
  }
  fm.updated = nowISO();
  fs.writeFileSync(fromPath, serializeFrontmatter(fm, newBody));
  appendLog('link', `${from} -> ${to}`);
  console.log(`linked: ${from} -> ${to}`);
}

function cmdMv(args) {
  const oldSlug = args._[0];
  const newSlug = args._[1];
  if (!oldSlug || !newSlug) { console.error('Usage: wiki mv <old-slug> <new-slug>'); process.exit(1); }
  if (!validSlug(newSlug)) { console.error(`error: invalid new slug: ${newSlug}`); process.exit(1); }
  if (isReserved(newSlug)) { console.error(`error: slug "${newSlug}" is reserved`); process.exit(1); }
  const { forbidden } = loadSchema();
  if (forbidden.has(newSlug)) { console.error(`error: slug "${newSlug}" is a forbidden aggregator slug`); process.exit(1); }

  const oldPath = wikiPath(oldSlug);
  const newPath = wikiPath(newSlug);
  if (!fs.existsSync(oldPath)) { console.error(`error: page ${oldSlug} does not exist`); console.error(`  Hint: \`wiki resolve "${oldSlug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  if (fs.existsSync(newPath)) { console.error(`error: page ${newSlug} already exists`); process.exit(2); }

  // HR04: stage every write (renamed-page + backlink rewrites) into a Map,
  // then flush via temp+rename per entry. If any staging step throws (read
  // error, parse error), no writes have hit disk — vault is untouched.
  // After the flush succeeds, unlink the old path last (no rollback for unlink,
  // but the new content is durably on disk by then). See audit/12 §
  // concurrency-atomicity and HR03 for the same pattern in cmdMerge.
  const staged = new Map();
  let touched = 0;
  try {
    // 1. Renamed page content (read from oldPath since rename hasn't happened yet).
    const { fm, body } = readPageForWrite(oldPath);
    fm.id = newSlug;
    fm.updated = nowISO();
    // The old slug normally becomes an alias so existing [[old]] links and
    // searches keep resolving. C3: --no-alias skips that — for a TYPO fix you
    // don't want the garbled old slug living on as a resolvable alias.
    if (!args['no-alias']) {
      const aliases = [...aliasesOf(fm)];
      if (!aliases.includes(oldSlug)) aliases.push(oldSlug);
      fm.aliases = aliases;
    }
    staged.set(newPath, serializeFrontmatter(fm, body));

    // 2. Backlink rewrites. Two regexes: a non-global one for `.test()`
    // (stateless across iterations), a global one for `.replace()`. Using
    // the /g flag for `.test` was a real correctness bug — see HR01.
    const linkTestRe = backlinkRegex(oldSlug);
    const linkReplaceRe = backlinkRegex(oldSlug, 'g');
    forEachPage(({ absPath, raw }) => {
      if (absPath === oldPath) return; // skip the source itself; it will be unlinked
      if (!linkTestRe.test(raw)) return;
      const updated = raw.replace(linkReplaceRe, `[[${newSlug}]]`);
      const parsed = parseFrontmatter(updated);
      parsed.fm.updated = nowISO();
      staged.set(absPath, serializeFrontmatter(parsed.fm, parsed.body));
      touched++;
    });
  } catch (e) {
    console.error(`error: mv aborted before any writes: ${e.message}`);
    process.exit(2);
  }

  flushStaged(staged, { tag: 'mv' });

  // Unlink the source last. No rollback for unlink, but every staged write
  // has already succeeded (per-file atomic) by the time we reach this line.
  fs.unlinkSync(oldPath);

  regenerateIndex();
  appendLog('mv', `${oldSlug} -> ${newSlug} (rewrote ${touched} backlinks)`);
  console.log(`renamed: ${oldSlug} -> ${newSlug} (${touched} backlinks rewritten${args['no-alias'] ? ', old slug NOT aliased (--no-alias)' : `, ${oldSlug} added to aliases`})`);
}

function cmdDelete(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki delete <slug> [--force]'); process.exit(1); }
  if (isReserved(slug)) { console.error(`error: cannot delete reserved page ${slug}`); process.exit(1); }
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const re = backlinkRegex(slug);
  const incoming = [];
  forEachPage(({ slug: fromSlug, body }) => {
    if (fromSlug === slug) return;
    if (re.test(body)) incoming.push(fromSlug);
  });
  if (incoming.length && !args.force) {
    console.error(`Refusing: ${slug} has ${incoming.length} inbound link(s) from: ${incoming.join(', ')}`);
    console.error('Use --force to delete anyway (links will become dead).');
    process.exit(3);
  }
  fs.unlinkSync(p);
  regenerateIndex();
  appendLog('delete', `${slug}${incoming.length ? ` (orphaned ${incoming.length} links)` : ''}`);
  console.log(`deleted: ${slug}`);
}

function cmdMerge(args) {
  const source = args._[0];
  const target = args._[1];
  if (!source || !target) {
    console.error('Usage: wiki merge <source-slug> <target-slug> [--dry-run]');
    console.error('  Merges source into target: rewrites all [[source]] to [[target]],');
    console.error('  appends source body to target, adds source title/aliases as target aliases,');
    console.error('  deletes source.');
    process.exit(1);
  }
  if (source === target) { console.error('error: source and target must differ'); process.exit(1); }
  const srcPath = wikiPath(source);
  const tgtPath = wikiPath(target);
  if (!fs.existsSync(srcPath)) { console.error(`error: source ${source} does not exist`); process.exit(2); }
  if (!fs.existsSync(tgtPath)) { console.error(`error: target ${target} does not exist`); process.exit(2); }
  if (isReserved(source) || isReserved(target)) { console.error('error: cannot merge reserved pages'); process.exit(1); }

  const dry = !!args['dry-run'];
  const dedupe = !!args.dedupe;
  const srcParsed = readPageForWrite(srcPath);
  const tgtParsed = readPageForWrite(tgtPath);

  // 1. Compose the target's new body.
  // Default (same-entity merge): concatenate the source body under a heading.
  // --dedupe (V2): the source is a near-DUPLICATE idea, not extra content — keep
  // the target body AS-IS (no `## Merged from` section, so the target stays a
  // single atomic card and is not flagged sectioned-idea-page); just carry the
  // source's RELATIONS over (deduped against the target's, so no edge is lost),
  // then redirect backlinks + delete the source. Hooks are unioned into the
  // frontmatter below.
  let mergedBody;
  if (dedupe) {
    const tgtRelKeys = new Set(parseRelations(tgtParsed.body).map((r) => `${r.verb} ${r.target}`));
    const carried = [];
    for (const r of parseRelations(srcParsed.body)) {
      const key = `${r.verb} ${r.target}`;
      if (r.target === target || tgtRelKeys.has(key)) continue;
      tgtRelKeys.add(key);
      carried.push(`- ${r.verb} [[${r.target}]]`);
    }
    mergedBody = carried.length ? tgtParsed.body.trimEnd() + '\n' + carried.join('\n') + '\n' : tgtParsed.body;
  } else {
    mergedBody = tgtParsed.body.trimEnd() + '\n\n## Merged from ' + source + '\n\n' + srcParsed.body.trimEnd() + '\n';
  }

  // 2. Compose merged frontmatter
  const newFm = { ...tgtParsed.fm };
  // Merge tags (union, preserve order)
  const tgtTags = Array.isArray(tgtParsed.fm.tags) ? tgtParsed.fm.tags : [];
  const srcTags = Array.isArray(srcParsed.fm.tags) ? srcParsed.fm.tags : [];
  const mergedTags = [...tgtTags];
  for (const t of srcTags) if (!mergedTags.includes(t)) mergedTags.push(t);
  newFm.tags = mergedTags;
  // Merge aliases: target's existing + source slug + source title + source aliases
  const tgtAliases = aliasesOf(tgtParsed.fm);
  const srcAliases = aliasesOf(srcParsed.fm);
  const newAliases = [...tgtAliases];
  for (const a of [source, srcParsed.fm.title, ...srcAliases]) {
    if (!a || newAliases.includes(a)) continue;
    // V3: a comma/]-bearing value can't be an alias (HR07). The card-quality
    // standard mandates declarative, comma-bearing titles, so erroring here
    // blocked merging essentially any two well-formed cards. Mirror the
    // patch --title fix: SKIP the invalid alias with a warning and continue
    // (the merge — backlink redirect + body — still proceeds).
    const aliasErr = aliasValueError(a);
    if (aliasErr) { console.error(`warning: not promoting "${a}" to an alias on merge (${aliasErr}); skipped.`); continue; }
    newAliases.push(a);
  }
  if (newAliases.length) newFm.aliases = newAliases;
  // --dedupe: union the source's hooks into the target (deduped) so connective
  // join-keys survive the collapse.
  if (dedupe && Array.isArray(srcParsed.fm.hooks) && srcParsed.fm.hooks.length) {
    const merged = Array.isArray(newFm.hooks) ? [...newFm.hooks] : [];
    for (const h of srcParsed.fm.hooks) if (typeof h === 'string' && h && !merged.includes(h)) merged.push(h);
    if (merged.length) newFm.hooks = merged;
  }
  newFm.updated = nowISO();

  // 3. Rewrite [[source]] → [[target]] across all wiki pages, dedup if both appear.
  // Two regexes: a non-global one for `.test()` (stateless across iterations),
  // a global one for `.replace()` below. See audit/12 § stateful-regex.
  const linkTestRe = backlinkRegex(source);
  const linkReplaceRe = backlinkRegex(source, 'g');
  const filesToRewrite = [];
  forEachPage(({ slug: fromSlug, absPath, raw }) => {
    if (fromSlug === source) return; // source will be deleted
    if (linkTestRe.test(raw)) filesToRewrite.push(absPath);
  });

  // 4. Dry-run report
  if (dry) {
    console.log(`--- dry-run: merge ${source} -> ${target}${dedupe ? ' (--dedupe)' : ''} ---`);
    console.log(dedupe
      ? `  target body kept as-is (dedupe); source relations/hooks carried over deduped`
      : `  target body grows by ${srcParsed.body.length} chars`);
    console.log(`  new aliases on target: ${newAliases.join(', ')}`);
    console.log(`  merged tags: [${mergedTags.join(', ')}]`);
    console.log(`  pages with [[${source}]] to rewrite: ${filesToRewrite.length}`);
    for (const fp of filesToRewrite) console.log(`    ${path.basename(fp)}`);
    console.log(`  source ${source}.md to be deleted`);
    return;
  }

  // 5–6. Stage all writes (target merge + per-page rewrites) into a Map; flush
  // via temp+renameSync per entry only after every staged write computed
  // without throwing. Mirrors the M08 staged-write pattern from cmdIngest:
  // a mid-loop failure leaves the vault untouched instead of partially merged.
  // See audit/12-coherence-robustness.md § concurrency-atomicity (HR03).
  /** @type {Map<string,string>} absolute-path -> serialized content */
  const staged = new Map();
  let rewrittenLines = 0;

  try {
    // 5. Target with merged content + frontmatter.
    staged.set(tgtPath, serializeFrontmatter(newFm, mergedBody));

    // 6. Each backlink page: substitute [[source]] -> [[target]], dedup
    //    microsyntax lines that may now collide with target's existing ones.
    for (const fp of filesToRewrite) {
      const cur = fs.readFileSync(fp, 'utf-8');
      let updated = cur.replace(linkReplaceRe, `[[${target}]]`);
      const lines = updated.split('\n');
      const seen = new Set();
      const dedup = [];
      for (const l of lines) {
        const t = l.trim();
        // Only dedup microsyntax lines to avoid removing legitimate repeated prose
        if (/^- (?:\[[a-z]+\]|"[^"]+"|[a-z_]+) (?:[A-Z]|\[\[)/.test(t) || /^- [a-z_]+ \[\[/.test(t)) {
          if (seen.has(t)) continue;
          seen.add(t);
        }
        dedup.push(l);
      }
      updated = dedup.join('\n');
      const parsed = parseFrontmatter(updated);
      parsed.fm.updated = nowISO();
      staged.set(fp, serializeFrontmatter(parsed.fm, parsed.body));
      rewrittenLines++;
    }
  } catch (e) {
    console.error(`error: merge aborted before any writes: ${e.message}`);
    process.exit(2);
  }

  flushStaged(staged, { tag: 'merge' });

  // 7. Delete source (last; unlink has no rollback, but by here every staged
  // write has succeeded).
  fs.unlinkSync(srcPath);

  regenerateIndex();
  appendLog('merge', `${source} -> ${target} (rewrote ${rewrittenLines} files, added aliases ${newAliases.slice(tgtAliases.length).join(',')})`);
  console.log(`merged: ${source} -> ${target} (${rewrittenLines} files rewritten, source deleted)`);
}

module.exports = { cmdLink, cmdMv, cmdDelete, cmdMerge };
