// audit-runtime.js — fs-touching audit wrappers used after a write.
//
//   - auditSlug(slug): read one page from disk and score it via lib/audit.js's
//     pure auditPage. Shared by the post-write hook and the `wiki audit` verb.
//   - postWriteAudit(slug): the silent-if-clean hook cmdWrite/cmdPatch/cmdIngest
//     run after a successful write; also fires STRICT_CROSS_PAGE_RULES on the
//     touched slug as advisory warnings.
//
// Extracted verbatim from bin/wiki so the write handlers can move into
// bin/commands/ without dragging the audit plumbing along. The pure scoring
// lives in bin/lib/audit.js; this module is the fs/snapshot boundary.

'use strict';

const fs = require('fs');
const { SCHEMA_PATH, wikiPath, invalidatePageCache } = require('./vault.js');
const { parseFrontmatter } = require('./frontmatter.js');
const { loadSchema: _loadSchema, knownRelationVerbs } = require('./schema.js');
const { auditPage, STRICT_CROSS_PAGE_RULES, strictCrossPageErrors } = require('./audit.js');
const { redactSecrets } = require('./secrets.js');
const { buildAllPagesSnapshot } = require('./write-validate.js');

const loadSchema = () => _loadSchema(SCHEMA_PATH);

function auditSlug(slug, opts = {}) {
  if (slug === 'index' || slug === 'log') return { score: 0, issues: [] };
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) return { score: 0, issues: [] };
  const raw = fs.readFileSync(p, 'utf-8');
  const { fm, body } = parseFrontmatter(raw);
  const schema = opts.schema || loadSchema();
  const knownVerbs = opts.knownVerbs || knownRelationVerbs(schema);
  const type = fm.type || 'note';
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  const title = String(fm.title || slug);
  return auditPage({ slug, title, type, tags, body, fm }, { schema, knownVerbs });
}

// Post-write audit: called from cmdWrite/cmdPatch/cmdIngest. Silent if clean.
// HR-OOB-B: also runs STRICT_CROSS_PAGE_RULES on the touched slug as advisory
// warnings (prevention is at validateBody-time; this is the safety net for
// rules added after a page's last write, or for rules surfaced through
// cmdMerge/cmdMv that don't go through validateBody).
function postWriteAudit(slug) {
  try {
    invalidatePageCache();
    const result = auditSlug(slug);
    let crossPageErrors = [];
    if (STRICT_CROSS_PAGE_RULES.length > 0) {
      const p = wikiPath(slug);
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const { fm, body } = parseFrontmatter(raw);
        const allPages = buildAllPagesSnapshot();
        const schema = loadSchema();
        const knownVerbs = knownRelationVerbs(schema);
        crossPageErrors = strictCrossPageErrors(
          { slug, title: String(fm.title || slug), type: fm.type || 'note', tags: Array.isArray(fm.tags) ? fm.tags : [], body, fm },
          { schema, knownVerbs, allPages },
        );
      }
    }
    if (result.score === 0 && crossPageErrors.length === 0) return;
    console.error('');
    const issueCount = result.issues.length + crossPageErrors.length;
    console.error(`# audit ${slug}: ${issueCount} issue(s), score ${result.score}`);
    let anySpecificFix = false;
    for (const i of result.issues) {
      console.error(redactSecrets(`  [${i.severity}] ${i.rule}: ${i.detail}`));
      if (i.fix) {
        console.error(redactSecrets(`    → fix: ${i.fix}`));
        anySpecificFix = true;
      }
    }
    for (const e of crossPageErrors) {
      console.error(redactSecrets(`  [cross-page] ${e.rule}: ${e.message}`));
      if (e.fix) {
        console.error(`    → fix: ${e.fix}`);
        anySpecificFix = true;
      }
    }
    if (!anySpecificFix) console.error(`  → fix via 'wiki patch ${slug} ...' before next ingestion`);
  } catch (e) {
    // Audit hook should never break the write
    console.error(`audit-hook error: ${e.message}`);
  }
}

module.exports = { auditSlug, postWriteAudit };
