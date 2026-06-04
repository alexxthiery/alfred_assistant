// commands/lint.js — `wiki lint`: vault-wide hygiene report.
//
// Read-only. Single pass over every page via forEachPage, then a series of
// opt-in-able checks (dead links, id mismatches, orphans, unknown tags/types,
// aggregator suspects, narrative-only pages, low link density, stale,
// unsourced, tier-escalation candidates, loneliness). `--only a,b` runs a
// subset. Prints "clean" when nothing fires.

'use strict';

const { forEachPage, SCHEMA_PATH } = require('../lib/vault.js');
const { loadSchema: _loadSchema, KNOWN_TYPES, STALE_THRESHOLDS, STALE_DEFAULT_DAYS } = require('../lib/schema.js');
const { extractWikilinks, parseObservations, parseRelations, extractProvenanceMarkers } = require('../lib/graph.js');

// A single CLI invocation parses SCHEMA.md once (lib/schema.js memoizes on mtime).
const loadSchema = () => _loadSchema(SCHEMA_PATH);

function staleThresholdFor(tags) {
  if (!Array.isArray(tags)) return STALE_DEFAULT_DAYS;
  for (const tier of STALE_THRESHOLDS) {
    for (const t of tier.tags) if (tags.includes(t)) return tier.days;
  }
  return STALE_DEFAULT_DAYS;
}

function cmdLint(args) {
  const slugs = new Set();
  const outboundByPage = {};
  const inboundByPage = {};
  const tagCounts = {};
  const pages = {};
  forEachPage(({ slug, fm, body }) => {
    slugs.add(slug);
    pages[slug] = { fm, body };
    const out = extractWikilinks(body);
    outboundByPage[slug] = out;
    for (const t of out) (inboundByPage[t] ||= []).push(slug);
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    for (const tag of tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  });

  const schema = loadSchema();
  const filter = args.only ? new Set(String(args.only).split(',')) : null;
  const enabled = (name) => !filter || filter.has(name);
  let issues = 0;

  // Dead links
  if (enabled('dead')) {
    const dead = [];
    for (const [from, targets] of Object.entries(outboundByPage)) {
      for (const t of targets) if (!slugs.has(t)) dead.push([from, t]);
    }
    if (dead.length) {
      console.log(`# Dead links (${dead.length})`);
      for (const [from, t] of dead) console.log(`  ${from} -> ${t}`);
      console.log('');
      issues += dead.length;
    }
  }

  // ID mismatch (filename != frontmatter id)
  if (enabled('ids')) {
    const mismatches = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (p.fm.id && p.fm.id !== slug) mismatches.push([slug, p.fm.id]);
    }
    if (mismatches.length) {
      console.log(`# ID mismatches — frontmatter id ≠ filename (${mismatches.length})`);
      for (const [fn, id] of mismatches) console.log(`  ${fn}.md  (id=${id})  → run \`wiki sync-ids\` to fix`);
      console.log('');
      issues += mismatches.length;
    }
  }

  // Orphans (no inbound)
  if (enabled('orphans')) {
    const orphans = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (p.fm.type === 'todo') continue;
      if (!inboundByPage[slug] || inboundByPage[slug].length === 0) orphans.push(slug);
    }
    if (orphans.length) {
      console.log(`# Orphans — pages with no inbound links (${orphans.length})`);
      for (const o of orphans) console.log(`  ${o}`);
      console.log('');
      issues += orphans.length;
    }
  }

  // Unknown tags
  if (enabled('tags') && schema.tags) {
    const unknown = Object.keys(tagCounts).filter((t) => !schema.tags.has(t));
    if (unknown.length) {
      console.log(`# Unknown tags — not in SCHEMA.md (${unknown.length})`);
      for (const t of unknown) console.log(`  ${t} (${tagCounts[t]}x)`);
      console.log('  → add to SCHEMA.md or rename');
      console.log('');
      issues += unknown.length;
    }
  }

  // Unknown page types
  if (enabled('types')) {
    const badTypes = [];
    for (const [slug, p] of Object.entries(pages)) {
      const t = p.fm.type || 'note';
      if (!KNOWN_TYPES.has(t)) badTypes.push([slug, t]);
    }
    if (badTypes.length) {
      console.log(`# Unknown page types (${badTypes.length})`);
      for (const [slug, t] of badTypes) console.log(`  ${slug}: type=${t}`);
      console.log('');
      issues += badTypes.length;
    }
  }

  // Type-tag mismatch: type=note but tagged as entity-kind
  // (type-tag rule moved to `wiki audit` — was duplicated here)

  // Forbidden aggregator slugs that exist
  if (enabled('aggregator') && schema.forbidden.size) {
    const found = [];
    for (const s of slugs) if (schema.forbidden.has(s)) found.push(s);
    if (found.length) {
      console.log(`# Forbidden aggregator slugs that exist (${found.length})`);
      for (const s of found) console.log(`  ${s} — decompose into atomic entity pages; this slug should not exist`);
      console.log('');
      issues += found.length;
    }
  }

  // Aggregator-suspect heuristic: pages with ≥3 ##  subsections looking like entity names.
  // Only check entity/concept. Common organizational headers (Family, Work, Health, ...) excluded.
  if (enabled('agg-suspect')) {
    const SECTION_WORDS = new Set([
      'family','work','health','lab','collaborators','personal','background','bio','biography',
      'contact','contacts','links','references','sources','overview','details','history','status',
      'goals','plans','upcoming','past','current','future','notes','summary','trips','travel',
      'achievements','skills','education','experience','interests','hobbies','income','finance',
      'fitness','medical','tests','results','timeline','log',
    ]);
    const suspects = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (!['entity', 'concept'].includes(p.fm.type)) continue;
      const subs = (p.body.match(/^## [A-Z][^\n]*$/gm) || []);
      // A subsection is "entity-looking" if the first significant word
      //   - is capitalized
      //   - is not a common section word
      //   - is not a multi-word phrase containing common section words
      const entityish = subs.filter((line) => {
        const text = line.replace(/^##\s+/, '').replace(/\s+—.*$/, '').trim();
        const firstWord = text.split(/\s+/)[0].toLowerCase();
        if (SECTION_WORDS.has(firstWord)) return false;
        // Must be a single capitalized token or two capitalized tokens (Name LastName)
        return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?$/.test(text);
      });
      if (entityish.length >= 3) suspects.push([slug, entityish.length]);
    }
    if (suspects.length) {
      console.log(`# Aggregator-suspect — pages with ≥3 entity-looking subsections (${suspects.length})`);
      for (const [s, n] of suspects) console.log(`  ${s} (${n} subsections) — likely needs decomposition`);
      console.log('');
      issues += suspects.length;
    }
  }

  // Narrative-only entity/concept — missing microsyntax
  if (enabled('narrative')) {
    const narrative = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (!['entity', 'concept'].includes(p.fm.type)) continue;
      const obs = parseObservations(p.body).length;
      const rels = parseRelations(p.body).length;
      const meaningful = p.body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
      if (meaningful >= 2 && obs === 0 && rels === 0) narrative.push(slug);
    }
    if (narrative.length) {
      console.log(`# Narrative-only entity/concept pages — no microsyntax (${narrative.length})`);
      for (const s of narrative) console.log(`  ${s} — add observations \`- [fact] ...\` and relations \`- verb [[slug]]\``);
      console.log('');
      issues += narrative.length;
    }
  }

  // Low wikilink density
  if (enabled('density')) {
    const sparse = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (['todo', 'source'].includes(p.fm.type)) continue;
      const words = p.body.split(/\s+/).filter(Boolean).length;
      if (words < 50) continue;
      const linkCount = extractWikilinks(p.body).length;
      if (linkCount < 2) sparse.push([slug, words, linkCount]);
    }
    if (sparse.length) {
      console.log(`# Low wikilink density — substantial pages with <2 links (${sparse.length})`);
      for (const [s, w, l] of sparse) console.log(`  ${s} (${w} words, ${l} link${l === 1 ? '' : 's'})`);
      console.log('  → run `wiki autolink <slug>` or add manually');
      console.log('');
      issues += sparse.length;
    }
  }

  // Stale
  if (enabled('stale')) {
    const now = Date.now();
    const stale = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (['todo', 'source'].includes(p.fm.type)) continue;
      const updated = p.fm.updated || p.fm.created;
      if (!updated) continue;
      const ts = Date.parse(updated);
      if (isNaN(ts)) continue;
      const days = (now - ts) / 86400000;
      const threshold = staleThresholdFor(p.fm.tags);
      if (days > threshold) stale.push([slug, Math.round(days), threshold]);
    }
    if (stale.length) {
      stale.sort((a, b) => b[1] - a[1]);
      console.log(`# Stale (${stale.length})`);
      for (const [slug, age, thresh] of stale) console.log(`  ${slug}  (${age}d old, threshold ${thresh}d)`);
      console.log('');
      issues += stale.length;
    }
  }

  // Unsourced
  if (enabled('unsourced')) {
    const unsourced = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (!['entity', 'synthesis'].includes(p.fm.type)) continue;
      const meaningful = p.body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
      if (meaningful < 2) continue;
      if (extractProvenanceMarkers(p.body).length === 0) unsourced.push(slug);
    }
    if (unsourced.length) {
      console.log(`# Unsourced (${unsourced.length}) — entity/synthesis pages without ^[...] markers`);
      for (const s of unsourced) console.log(`  ${s}`);
      console.log('');
      issues += unsourced.length;
    }
  }

  // Tier-escalation candidates
  if (enabled('tiers')) {
    const mentionCount = {};
    for (const [from, targets] of Object.entries(outboundByPage)) {
      for (const t of targets) mentionCount[t] = (mentionCount[t] || 0) + 1;
    }
    const candidates = Object.entries(mentionCount).filter(([t, n]) => n >= 3 && !slugs.has(t));
    if (candidates.length) {
      console.log(`# Tier-escalation candidates (${candidates.length})`);
      for (const [t, n] of candidates) console.log(`  ${t} — referenced by ${n} pages, no page yet`);
      console.log('');
    }
  }

  // Loneliness: pages with < N total graph connections (excluding todo, source)
  if (enabled('loneliness')) {
    const threshold = parseInt(args.threshold || '2', 10);
    // For each page, count inbound + outbound wikilinks + relations both directions
    const relCounts = {};
    for (const slug of slugs) relCounts[slug] = { out: 0, in: 0 };
    for (const [slug, p] of Object.entries(pages)) {
      const outRels = parseRelations(p.body);
      relCounts[slug].out += outRels.length;
      for (const r of outRels) {
        if (relCounts[r.target]) relCounts[r.target].in += 1;
      }
    }
    const lonely = [];
    for (const [slug, p] of Object.entries(pages)) {
      if (['todo', 'source'].includes(p.fm.type)) continue;
      const outLinks = (outboundByPage[slug] || []).length;
      const inLinks = (inboundByPage[slug] || []).length;
      const outRels = relCounts[slug].out;
      const inRels = relCounts[slug].in;
      const total = outLinks + inLinks + outRels + inRels;
      if (total < threshold) {
        // Suggest placement candidates by tag overlap (top 3)
        const myTags = new Set(Array.isArray(p.fm.tags) ? p.fm.tags : []);
        const scores = {};
        for (const [other, op] of Object.entries(pages)) {
          if (other === slug) continue;
          const oTags = new Set(Array.isArray(op.fm.tags) ? op.fm.tags : []);
          let s = 0;
          for (const t of myTags) if (oTags.has(t)) s += 1;
          if (s > 0) scores[other] = s;
        }
        const candidates = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
        lonely.push([slug, total, candidates]);
      }
    }
    if (lonely.length) {
      console.log(`# Loneliness — pages with < ${threshold} graph connections (${lonely.length})`);
      for (const [slug, total, candidates] of lonely) {
        const candStr = candidates.length ? `  → consider linking with: ${candidates.map((s) => `[[${s}]]`).join(', ')}` : '';
        console.log(`  ${slug} (${total} connections)${candStr}`);
      }
      console.log('');
      issues += lonely.length;
    }
  }

  // Provenance — pages with observations but no ^[...] markers
  // (provenance and hypotheses rules moved to `wiki audit` — were duplicated here.
  //  Run `wiki audit --all` for per-page provenance and stale-hypothesis checks.)

  if (issues === 0) console.log('clean');
}

module.exports = { cmdLint };
