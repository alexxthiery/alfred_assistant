// resolve.js — fs wrapper over scoreSlugCandidates (lib/graph.js): builds the
// page list (slug/title/aliases) from disk, then defers all scoring to the
// pure core. Consumed by ingest / resolve / place / stubs for fuzzy slug
// matching.

'use strict';

const { forEachPage } = require('./vault.js');
const { aliasesOf, scoreSlugCandidates } = require('./graph.js');

function resolveSlugCandidates(query, opts = {}) {
  const pages = [];
  forEachPage(({ slug, fm }) => {
    pages.push({
      slug,
      title: (fm.title || '').trim(),
      aliases: aliasesOf(fm),
    });
  });
  return scoreSlugCandidates(query, pages, opts);
}

module.exports = { resolveSlugCandidates };
