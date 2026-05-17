// verbs/read.js — read-only CLI verbs.
//
// All 9 read verbs (list, search, recent, preview, print, sources, related,
// agenda, context). No writes, no auto-commit, no audit hooks. Each verb
// reads fs (via ../lib/vault.js) + parses frontmatter/body (via ../lib/),
// prints to stdout, exits with the documented code.
//
// Behavior preserved exactly from the pre-extraction code in bin/wiki — these
// are the same functions, just moved out of the monolith.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseFrontmatter } = require('../lib/frontmatter.js');
const { extractWikilinks, parseObservations, parseRelations } = require('../lib/graph.js');
const { WIKI_DIR, wikiPath, listWikiPages, readPage } = require('../lib/vault.js');

function cmdList(args) {
  const files = listWikiPages();
  for (const f of files) {
    const { fm } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    const slug = fm.id || f.replace(/\.md$/, '');
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    if (args.tag && !tags.includes(args.tag)) continue;
    if (args.type && fm.type !== args.type) continue;
    const tagStr = tags.length ? `  [${tags.join(', ')}]` : '';
    console.log(`${slug}\t${fm.title || ''}${tagStr}`);
  }
}

function cmdSearch(args) {
  const query = args._[0];
  if (!query && !args.tag) {
    console.error('Usage: wiki search <query> [--tag tag] [--title-only]');
    process.exit(1);
  }
  const files = listWikiPages();
  const re = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
  let count = 0;
  for (const f of files) {
    const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    if (args.tag) {
      const tags = Array.isArray(fm.tags) ? fm.tags : [];
      if (!tags.includes(args.tag)) continue;
    }
    const slug = fm.id || f.replace(/\.md$/, '');
    const title = fm.title || '';
    if (re) {
      if (args['title-only']) {
        if (!re.test(title)) continue;
      } else {
        const titleMatch = re.test(title);
        const idx = body.search(re);
        if (!titleMatch && idx < 0) continue;
        console.log(`${slug}\t${title}`);
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(body.length, idx + 80);
          console.log(`    …${body.slice(start, end).replace(/\s+/g, ' ').trim()}…`);
        }
        count++;
        continue;
      }
    }
    console.log(`${slug}\t${title}`);
    count++;
  }
  if (count === 0) console.log('(no matches)');
}

function cmdAgenda(args) {
  // Windows: today | week | upcoming (default) | past | all
  // Accept either positional (wiki agenda today) or --window flag
  const win = (args._[0] || args.window || 'upcoming').toLowerCase();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 86400 * 1000 - 1;
  const endOfWeek = startOfToday + 7 * 86400 * 1000;

  const events = [];
  for (const f of listWikiPages()) {
    const { fm } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    if (fm.type !== 'event') continue;
    if (!fm.when) continue;
    const ts = Date.parse(fm.when);
    if (isNaN(ts)) continue;
    const slug = fm.id || f.replace(/\.md$/, '');
    events.push({
      slug,
      title: fm.title || slug,
      when: fm.when,
      ts,
      duration: fm.duration || '',
      location: fm.location || '',
      attendees: Array.isArray(fm.attendees) ? fm.attendees : [],
      tags: Array.isArray(fm.tags) ? fm.tags : [],
    });
  }

  let filtered;
  switch (win) {
    case 'today':
      filtered = events.filter((e) => e.ts >= startOfToday && e.ts <= endOfToday);
      break;
    case 'week':
      filtered = events.filter((e) => e.ts >= startOfToday && e.ts < endOfWeek);
      break;
    case 'past':
      filtered = events.filter((e) => e.ts < startOfToday);
      filtered.sort((a, b) => b.ts - a.ts);
      break;
    case 'all':
      filtered = events;
      break;
    case 'upcoming':
    default:
      filtered = events.filter((e) => e.ts >= startOfToday);
      break;
  }
  if (win !== 'past') filtered.sort((a, b) => a.ts - b.ts);

  if (filtered.length === 0) { console.log(`(no events in window: ${win})`); return; }

  for (const e of filtered) {
    const whenShort = e.when.length > 10 ? e.when.replace('T', ' ').slice(0, 16) : e.when;
    const parts = [whenShort];
    if (e.duration) parts.push(`(${e.duration})`);
    parts.push(`[[${e.slug}]]`);
    if (e.location) parts.push(`@ ${e.location}`);
    if (e.attendees.length) parts.push(`w/ ${e.attendees.map((a) => `[[${a}]]`).join(', ')}`);
    console.log(parts.join('  '));
  }
}

function cmdRecent(args) {
  const days = parseInt(args.days || '7', 10);
  const cutoff = Date.now() - days * 86400 * 1000;
  const files = listWikiPages();
  const rows = [];
  for (const f of files) {
    const { fm } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    if (args.type && fm.type !== args.type) continue;
    const updated = fm.updated || fm.created;
    if (!updated) continue;
    const ts = Date.parse(updated);
    if (isNaN(ts) || ts < cutoff) continue;
    const slug = fm.id || f.replace(/\.md$/, '');
    rows.push({ slug, title: fm.title || '', type: fm.type || 'note', updated });
  }
  rows.sort((a, b) => b.updated.localeCompare(a.updated));
  if (rows.length === 0) { console.log(`(no pages updated in last ${days} days)`); return; }
  for (const r of rows) console.log(`${r.updated.slice(0, 10)}\t${r.type}\t${r.slug}\t${r.title}`);
}

function cmdPrint(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki print <slug> [--backlinks] [--links]'); process.exit(1); }
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) { console.error(`Page ${slug} does not exist.`); process.exit(2); }
  process.stdout.write(fs.readFileSync(p, 'utf-8'));
  const { body } = parseFrontmatter(fs.readFileSync(p, 'utf-8'));
  if (args.links) {
    console.log('\n## Outbound (computed)\n');
    const out = extractWikilinks(body);
    for (const s of out) console.log(`- [[${s}]]${fs.existsSync(wikiPath(s)) ? '' : ' (stub)'}`);
    if (out.length === 0) console.log('_(none)_');
  }
  if (args.backlinks) {
    console.log('\n## Backlinks (computed)\n');
    const re = new RegExp(`\\[\\[${slug}\\]\\]`);
    const hits = [];
    for (const f of listWikiPages()) {
      const from = f.replace(/\.md$/, '');
      if (from === slug) continue;
      const { body: b } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
      if (re.test(b)) hits.push(from);
    }
    for (const s of hits) console.log(`- [[${s}]]`);
    if (hits.length === 0) console.log('_(none)_');
  }
}

function cmdSources() { cmdList({ _: [], type: 'source' }); }

function cmdRelated(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki related <slug>'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`Page ${slug} does not exist.`); process.exit(2); }
  const myTags = new Set(Array.isArray(page.fm.tags) ? page.fm.tags : []);
  const myOutbound = new Set(extractWikilinks(page.body));
  const backlinks = new Set();
  const re = new RegExp(`\\[\\[${slug}\\]\\]`);
  for (const f of listWikiPages()) {
    const from = f.replace(/\.md$/, '');
    if (from === slug) continue;
    const { body } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    if (re.test(body)) backlinks.add(from);
  }
  const scores = {};
  for (const f of listWikiPages()) {
    const other = f.replace(/\.md$/, '');
    if (other === slug) continue;
    const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    const otherTags = new Set(Array.isArray(fm.tags) ? fm.tags : []);
    let score = 0;
    for (const t of myTags) if (otherTags.has(t)) score += 2;
    if (myOutbound.has(other)) score += 3;
    if (backlinks.has(other)) score += 3;
    const otherOutbound = new Set(extractWikilinks(body));
    for (const t of myOutbound) if (otherOutbound.has(t)) score += 1;
    if (score > 0) scores[other] = { score, title: fm.title || '', type: fm.type || 'note' };
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  if (ranked.length === 0) { console.log('(no related pages)'); return; }
  for (const [s, info] of ranked.slice(0, 20)) {
    console.log(`${info.score}\t${info.type}\t${s}\t${info.title}`);
  }
}

function cmdPreview(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki preview <slug>'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`Page ${slug} does not exist.`); process.exit(2); }
  const { fm, body } = page;
  const tags = Array.isArray(fm.tags) ? fm.tags.join(', ') : '';
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : (fm.aliases ? [fm.aliases] : []);
  const updated = (fm.updated || '').slice(0, 10);
  // First 3 non-heading, non-microsyntax body lines
  const lines = body.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('#') && !t.startsWith('- [') && !t.startsWith('- "') && !/^- [a-z][a-z_]+ \[\[/.test(t);
  }).slice(0, 3);
  const obs = parseObservations(body).length;
  const rels = parseRelations(body).length;
  // Inbound wikilinks
  const re = new RegExp(`\\[\\[${slug}\\]\\]`);
  let inbound = 0;
  for (const f of listWikiPages()) {
    const from = f.replace(/\.md$/, '');
    if (from === slug) continue;
    const { body: b } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    if (re.test(b)) inbound++;
  }
  console.log(`${slug} · ${fm.title || ''} · ${fm.type || 'note'} · ${updated} · [${tags}]`);
  if (aliases.length) console.log(`aliases: ${aliases.join(', ')}`);
  if (fm.summary) console.log(`summary: ${fm.summary}`);
  if (lines.length) {
    console.log('');
    for (const l of lines) console.log(`  ${l.trim().slice(0, 120)}`);
  }
  console.log('');
  console.log(`${obs} observations · ${rels} outbound relations · ${inbound} inbound wikilinks`);
}

function cmdContext(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki context <slug>'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`Page ${slug} does not exist.`); process.exit(2); }
  const { fm, body } = page;
  const tags = Array.isArray(fm.tags) ? fm.tags.join(', ') : '';
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : (fm.aliases ? [fm.aliases] : []);

  // Frontmatter section
  console.log(`# ${slug}`);
  console.log(`title:   ${fm.title || ''}`);
  console.log(`type:    ${fm.type || 'note'}`);
  console.log(`tags:    [${tags}]`);
  console.log(`updated: ${(fm.updated || '').slice(0, 10)}`);
  if (aliases.length) console.log(`aliases: ${aliases.join(', ')}`);
  if (fm.summary) console.log(`summary: ${fm.summary}`);

  // External-link fields (mainly for person entities; surface them inline)
  const EXTERNAL_LINK_FIELDS = ['homepage', 'scholar', 'orcid', 'github', 'linkedin', 'twitter', 'arxiv', 'email'];
  const extLinks = EXTERNAL_LINK_FIELDS.filter((f) => fm[f]);
  if (extLinks.length) {
    console.log('');
    console.log('# external');
    for (const f of extLinks) console.log(`  ${f}: ${fm[f]}`);
  }

  // First 5 observations
  const obs = parseObservations(body);
  if (obs.length) {
    console.log('');
    console.log('# observations');
    for (const o of obs.slice(0, 5)) {
      const marks = [];
      if (o.superseded) marks.push('superseded');
      if (o.dates.since) marks.push(`since ${o.dates.since}`);
      if (o.dates.until) marks.push(`until ${o.dates.until}`);
      if (o.dates.on) marks.push(`on ${o.dates.on}`);
      if (o.dates.asOf) marks.push(`as-of ${o.dates.asOf}`);
      const annot = marks.length ? `  (${marks.join(', ')})` : '';
      console.log(`- [${o.category}] ${o.body}${annot}`);
    }
    if (obs.length > 5) console.log(`  (...${obs.length - 5} more)`);
  }

  // Outbound relations grouped by verb
  const outRels = parseRelations(body);
  if (outRels.length) {
    console.log('');
    console.log('# outbound relations');
    const grouped = {};
    for (const r of outRels) (grouped[r.verb] ||= []).push(r.target);
    for (const v of Object.keys(grouped).sort()) {
      console.log(`- ${v}: ${grouped[v].map((s) => `[[${s}]]`).join(', ')}`);
    }
  }

  // Inbound relations + wikilinks
  const incomingRels = {};
  const incomingLinks = new Set();
  for (const f of listWikiPages()) {
    const from = f.replace(/\.md$/, '');
    if (from === slug) continue;
    const { body: b } = parseFrontmatter(fs.readFileSync(path.join(WIKI_DIR, f), 'utf-8'));
    for (const r of parseRelations(b)) {
      if (r.target === slug) (incomingRels[r.verb] ||= []).push(from);
    }
    if (new RegExp(`\\[\\[${slug}\\]\\]`).test(b)) incomingLinks.add(from);
  }
  if (Object.keys(incomingRels).length) {
    console.log('');
    console.log('# inbound relations');
    for (const v of Object.keys(incomingRels).sort()) {
      console.log(`- ${v}: ${incomingRels[v].map((s) => `[[${s}]]`).join(', ')}`);
    }
  }

  // 1-hop neighbors (union of outbound + inbound)
  const neighbors = new Set();
  for (const r of outRels) neighbors.add(r.target);
  for (const s of extractWikilinks(body)) neighbors.add(s);
  for (const s of incomingLinks) neighbors.add(s);
  for (const v of Object.values(incomingRels)) for (const s of v) neighbors.add(s);
  neighbors.delete(slug);
  if (neighbors.size) {
    console.log('');
    console.log('# 1-hop neighbors');
    console.log([...neighbors].sort().map((s) => `[[${s}]]`).join(' '));
  }
}

module.exports = {
  cmdList,
  cmdSearch,
  cmdRecent,
  cmdPreview,
  cmdPrint,
  cmdSources,
  cmdRelated,
  cmdAgenda,
  cmdContext,
};
