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
const { wikiPath, nowISO, forEachPage, SCHEMA_PATH } = require('../lib/vault.js');
const { validSlug, isReserved, loadSchema: _loadSchema } = require('../lib/schema.js');
const { parseFrontmatter, serializeFrontmatter } = require('../lib/frontmatter.js');
const { backlinkRegex, aliasesOf } = require('../lib/graph.js');
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

module.exports = { cmdLink, cmdMv, cmdDelete };
