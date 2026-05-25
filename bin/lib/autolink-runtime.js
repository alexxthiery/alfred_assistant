// autolink-runtime.js — fs-touching autolink wrappers over the pure
// lib/autolink.js. buildTitleMap reads the vault to build the title-entry list;
// autolinkSlug injects outbound (other titles -> [[slug]]) and/or inbound
// (this title -> [[slug]] in other pages) wikilinks for one slug and writes the
// touched pages back. Shared by patch/autolink/ingest/groom.
//
// The matching/injection logic is pure and lives in lib/autolink.js
// (buildTitleEntries, autolinkBody); this module is the disk boundary.

'use strict';

const fs = require('fs');
const { wikiPath, nowISO, forEachPage } = require('./vault.js');
const { buildTitleEntries, autolinkBody } = require('./autolink.js');
const { aliasesOf } = require('./graph.js');
const { serializeFrontmatter } = require('./frontmatter.js');
const { readPageForWrite, appendLog } = require('./page-io.js');

function buildTitleMap() {
  const pages = [];
  forEachPage(({ slug, fm }) => pages.push({ slug, fm }));
  return buildTitleEntries(pages);
}

// Autolink a single slug: inject outbound (other titles → [[slug]]) and/or
// inbound (this title → [[slug]] in other pages) wikilinks.
// Returns { out: N, in: N, total: N }.
function autolinkSlug(slug, { direction = 'both', dryRun = false, verbose = true, titleMap = null } = {}) {
  const tmap = titleMap || (() => { const m = buildTitleMap(); m.sort((a, b) => b.title.length - a.title.length); return m; })();
  let outCount = 0, inCount = 0;
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) { console.error(`error: page ${slug} does not exist`); return { out: 0, in: 0, total: 0 }; }

  // Outbound: scan this page's body for mentions of other titles
  if (direction === 'out' || direction === 'both') {
    // autolink only writes back if injections occur; readPageForWrite is
    // safe even if no write follows (the read+refuse-malformed is
    // independent of whether we ultimately serialize).
    const { fm, body } = readPageForWrite(p);
    // V1: pass this page's own subject terms so autolink never links a phrase
    // that names this very page to a different card.
    const ownTerms = [fm.title, ...aliasesOf(fm)].filter(Boolean);
    const { body: newBody, injections } = autolinkBody(body, slug, tmap, ownTerms);
    if (injections > 0) {
      outCount = injections;
      if (!dryRun) {
        fm.updated = nowISO();
        fs.writeFileSync(p, serializeFrontmatter(fm, newBody));
      }
    }
  }

  // Inbound: scan OTHER pages' bodies for mentions of THIS page's title/aliases
  if (direction === 'in' || direction === 'both') {
    const myEntry = tmap.filter((e) => e.slug === slug);
    if (myEntry.length) {
      forEachPage(({ slug: fromSlug, absPath, fm: ffm, body: fbody }) => {
        if (fromSlug === slug) return;
        // Pretend titleMap contains only my entries (so we link FROM this page TO `slug`)
        // V1: guard fromSlug's own subject terms from being linked away.
        const fromOwnTerms = [ffm.title, ...aliasesOf(ffm)].filter(Boolean);
        const { body: newBody, injections } = autolinkBody(fbody, fromSlug, myEntry, fromOwnTerms);
        if (injections > 0) {
          inCount += injections;
          if (!dryRun) {
            ffm.updated = nowISO();
            fs.writeFileSync(absPath, serializeFrontmatter(ffm, newBody));
          }
        }
      });
    }
  }

  const total = outCount + inCount;
  if (verbose && total > 0) {
    const parts = [];
    if (outCount > 0) parts.push(`${outCount} outbound`);
    if (inCount > 0) parts.push(`${inCount} inbound`);
    console.log(`${slug}: +${total} link(s) (${parts.join(', ')})`);
  }
  if (!dryRun && total > 0) appendLog('autolink', `${slug} (+${outCount}/out, +${inCount}/in)`);
  return { out: outCount, in: inCount, total };
}

module.exports = { buildTitleMap, autolinkSlug };
