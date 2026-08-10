// commands/graph.js — graph + navigation verbs (mostly read-only queries over
// the typed graph): links, backlinks, relations, observations, path, hubs,
// timeline, stubs, resolve, place; plus autolink (the one writer, injecting
// bidirectional wikilinks). Pure graph helpers live in lib/graph.js; this file
// is the fs/query layer.

'use strict';

const fs = require('fs');
const path = require('path');
const { VAULT_ROOT, wikiPath, listWikiPages, readPage, forEachPage } = require('../lib/vault.js');
const { parseFrontmatter } = require('../lib/frontmatter.js');
const { aliasesOf, backlinkRegex, extractWikilinks, parseObservations, parseRelations, stripSupersededObservationLines } = require('../lib/graph.js');
const { resolveSlugCandidates } = require('../lib/resolve.js');
const { buildTitleMap, autolinkSlug } = require('../lib/autolink-runtime.js');
const { regenerateIndex, appendLog } = require('../lib/page-io.js');

function cmdLinks(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki links <slug>'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const out = extractWikilinks(page.body);
  for (const s of out) {
    const exists = fs.existsSync(wikiPath(s));
    console.log(`${s}${exists ? '' : ' (stub)'}`);
  }
  if (out.length === 0) console.log('(no outbound links)');
}

function cmdBacklinks(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki backlinks <slug>'); process.exit(1); }
  const re = backlinkRegex(slug);
  const hits = [];
  forEachPage(({ slug: fromSlug, body }) => {
    if (fromSlug === slug) return;
    if (re.test(stripSupersededObservationLines(body))) hits.push(fromSlug);
  });
  for (const s of hits) console.log(s);
  if (hits.length === 0) console.log('(no inbound links)');
}

function cmdRelations(args) {
  const slug = args._[0];
  if (slug) {
    const page = readPage(slug);
    if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
    const out = parseRelations(page.body);
    if (out.length) {
      console.log('# Outbound');
      for (const r of out) console.log(`  ${slug}\t${r.verb}\t${r.target}${fs.existsSync(wikiPath(r.target)) ? '' : ' (stub)'}`);
    }
    // Inbound: scan all pages for relations targeting this slug
    const incoming = [];
    forEachPage(({ slug: from, body }) => {
      if (from === slug) return;
      for (const r of parseRelations(body)) {
        if (r.target === slug) incoming.push({ from, verb: r.verb });
      }
    });
    if (incoming.length) {
      console.log('\n# Inbound');
      for (const r of incoming) console.log(`  ${r.from}\t${r.verb}\t${slug}`);
    }
    if (out.length === 0 && incoming.length === 0) console.log('(no relations)');
  } else {
    // Dump whole graph
    forEachPage(({ slug: from, body }) => {
      for (const r of parseRelations(body)) {
        console.log(`${from}\t${r.verb}\t${r.target}`);
      }
    });
  }
}

function cmdObservations(args) {
  const slug = args._[0];
  const category = args.category;
  const includeRetired = !!args['include-retired'];
  const collect = (slug, body) => {
    for (const o of parseObservations(body)) {
      if (o.superseded && !includeRetired) continue;
      if (category && o.category !== category) continue;
      const marks = [];
      if (o.superseded) marks.push('superseded');
      if (o.dates.since) marks.push(`since ${o.dates.since}`);
      if (o.dates.until) marks.push(`until ${o.dates.until}`);
      if (o.dates.on) marks.push(`on ${o.dates.on}`);
      if (o.dates.asOf) marks.push(`as-of ${o.dates.asOf}`);
      const annot = marks.length ? `  (${marks.join(', ')})` : '';
      console.log(`${slug}\t[${o.category}]\t${o.body}${annot}`);
    }
  };
  if (slug) {
    const page = readPage(slug);
    if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
    collect(slug, page.body);
  } else {
    forEachPage(({ slug: s, body }) => collect(s, body));
  }
}

function cmdAutolink(args) {
  let direction = args.direction || 'both';
  if (!['in', 'out', 'both'].includes(direction)) {
    console.error(`error: invalid --direction: ${direction}; must be in|out|both`);
    process.exit(1);
  }

  const tmap = buildTitleMap();
  tmap.sort((a, b) => b.title.length - a.title.length);

  const targets = args.all ? listWikiPages().map((f) => f.replace(/\.md$/, '')) : (args._[0] ? [args._[0]] : null);
  if (!targets) { console.error('Usage: wiki autolink <slug> | wiki autolink --all [--direction in|out|both] [--dry-run]'); process.exit(1); }

  // With --all, inbound scans are mathematically redundant with the outbound
  // pass across the full target set (every page Y's outbound scan against the
  // full titleMap already injects [[X]] wherever X is mentioned in Y, which is
  // exactly what X's inbound scan would produce). Force direction to 'out' to
  // collapse the work from N² page reads to N. The single-slug case still
  // needs both directions.
  if (args.all && direction !== 'out') direction = 'out';

  let totalOut = 0, totalIn = 0;
  for (const slug of targets) {
    const r = autolinkSlug(slug, { direction, dryRun: !!args['dry-run'], verbose: true, titleMap: tmap, log: false });
    totalOut += r.out;
    totalIn += r.in;
  }
  const total = totalOut + totalIn;
  if (total === 0) console.log('(no new links to inject)');
  else if (args['dry-run']) console.log(`(dry-run) would inject ${total} link(s) total (${totalOut} outbound, ${totalIn} inbound)`);
  else {
    regenerateIndex();
    const detail = args.all
      ? `--all (+${totalOut}/out, +${totalIn}/in)`
      : `${targets.join(',')} (+${totalOut}/out, +${totalIn}/in)`;
    appendLog('autolink', detail);
    console.log(`injected ${total} link(s) total (${totalOut} outbound, ${totalIn} inbound)`);
  }
}

function cmdResolve(args) {
  const query = args._[0];
  if (!query) { console.error('Usage: wiki resolve <fuzzy-name>'); process.exit(1); }
  const top = resolveSlugCandidates(query).slice(0, 5);
  if (top.length === 0) {
    console.log('(no matches)');
    process.exit(2);
  }
  for (const m of top) {
    console.log(`${m.slug}\t${m.confidence.toFixed(2)}\t(${m.reason})`);
  }
}

function cmdPath(args) {
  const from = args._[0];
  const to = args._[1];
  const maxHops = parseInt(args['max-hops'] || '3', 10);
  const directed = !!args.directed;
  if (!from || !to) { console.error('Usage: wiki path <from> <to> [--max-hops N] [--directed]'); process.exit(1); }
  if (!fs.existsSync(wikiPath(from))) { console.error(`error: page ${from} does not exist`); console.error(`  Hint: \`wiki resolve "${from}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  if (!fs.existsSync(wikiPath(to))) { console.error(`error: page ${to} does not exist`); console.error(`  Hint: \`wiki resolve "${to}"\` to fuzzy-match similar slugs.`); process.exit(2); }

  // Build adjacency. By default undirected (relation existing in either direction counts as connection).
  // Each edge: { target, verb, dir: 'out'|'in' } so display can show direction of traversal.
  const adj = {};
  forEachPage(({ slug, body }) => {
    adj[slug] = adj[slug] || [];
    for (const r of parseRelations(body)) {
      adj[slug].push({ target: r.target, verb: r.verb, dir: 'out' });
      if (!directed) {
        adj[r.target] = adj[r.target] || [];
        adj[r.target].push({ target: slug, verb: r.verb, dir: 'in' });
      }
    }
  });

  // BFS
  const queue = [{ slug: from, path: [from], edges: [] }];
  const visited = new Set([from]);
  while (queue.length) {
    const { slug, path: p, edges: ev } = queue.shift();
    if (p.length > maxHops + 1) continue;
    for (const r of (adj[slug] || [])) {
      if (visited.has(r.target)) continue;
      const newPath = [...p, r.target];
      const newEdges = [...ev, r];
      if (r.target === to) {
        const display = [];
        for (let i = 0; i < newPath.length - 1; i++) {
          const e = newEdges[i];
          if (e.dir === 'out') display.push(`${newPath[i]} → ${e.verb} → ${newPath[i + 1]}`);
          else display.push(`${newPath[i]} ← ${e.verb} ← ${newPath[i + 1]}`);
        }
        console.log(display.join('\n'));
        console.log(`(${newPath.length - 1} hop${newPath.length - 1 === 1 ? '' : 's'}${directed ? ', directed' : ''})`);
        return;
      }
      visited.add(r.target);
      queue.push({ slug: r.target, path: newPath, edges: newEdges });
    }
  }
  console.log(`(no path within ${maxHops} hops${directed ? ', directed' : ''})`);
  process.exit(2);
}

function cmdHubs(args) {
  const topN = parseInt(args.top || '10', 10);
  const counts = {};
  forEachPage(({ body }) => {
    for (const t of extractWikilinks(body)) {
      counts[t] = (counts[t] || 0) + 1;
    }
  });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
  for (const [slug, n] of ranked) {
    const p = wikiPath(slug);
    let title = slug;
    let type = 'note';
    if (fs.existsSync(p)) {
      const { fm } = parseFrontmatter(fs.readFileSync(p, 'utf-8'));
      title = fm.title || slug;
      type = fm.type || 'note';
    } else {
      title = `${slug} (stub)`;
    }
    console.log(`${n}\t${type}\t${slug}\t${title}`);
  }
}

function cmdHooks(args) {
  const minCount = args.min !== undefined ? Math.max(1, parseInt(args.min, 10) || 1) : 1;
  const counts = new Map();      // hook -> page count
  const samples = new Map();     // hook -> [slug, ...] (first few)
  forEachPage(({ slug, fm }) => {
    const hooks = Array.isArray(fm.hooks) ? fm.hooks : [];
    for (const h of hooks) {
      if (typeof h !== 'string' || !h) continue;
      counts.set(h, (counts.get(h) || 0) + 1);
      if (!samples.has(h)) samples.set(h, []);
      const s = samples.get(h);
      if (s.length < 3) s.push(slug);
    }
  });
  const ranked = [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) {
    console.log(minCount > 1 ? `(no hooks used on >= ${minCount} pages)` : '(no hooks in use yet)');
    return;
  }
  for (const [hook, n] of ranked) {
    const promoted = fs.existsSync(wikiPath(hook)) ? 'concept' : '—';
    console.log(`${n}\t${promoted}\t${hook}\t(${samples.get(hook).join(', ')})`);
  }
}

function cmdProcess(args) {
  console.log('# Process-session guide — run this BEFORE decomposing raw items into atoms.');
  console.log('# The rubric below + the live hook vocabulary + the gold cards are your context.\n');

  // (1) Canonical rubric / procedure.
  const pipelinePath = path.join(VAULT_ROOT, 'persona', 'pipeline.md');
  if (fs.existsSync(pipelinePath)) {
    console.log(fs.readFileSync(pipelinePath, 'utf-8').trim());
  } else {
    console.log('(persona/pipeline.md not found in this vault — see the persona for the full procedure.)');
  }

  // (2) Live hook vocabulary — reuse an existing hook before minting a new one.
  console.log('\n---\n\n## Live hook vocabulary (REUSE the closest existing hook; do not coin a near-duplicate)\n');
  const counts = new Map();
  forEachPage(({ fm }) => {
    const hooks = Array.isArray(fm.hooks) ? fm.hooks : [];
    for (const h of hooks) if (typeof h === 'string' && h) counts.set(h, (counts.get(h) || 0) + 1);
  });
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length) {
    for (const [h, n] of ranked) console.log(`  ${String(n).padStart(3)}  ${h}`);
  } else {
    console.log('  (no hooks in use yet — you are seeding the vocabulary; choose short standard concept names)');
  }

  // (3) Gold-standard cards — match this shape (declarative title, self-contained
  // claims with provenance, sparse hooks, no `##` sections).
  console.log('\n---\n\n## Gold-standard cards — MATCH THIS SHAPE (one self-contained idea per card)\n');
  const exemplars = ['fivo-monte-carlo-objective', 'sixo-twist-density-ratio', 'normalized-prior-reference-twist', 'static-schrodinger-bridge'];
  let shown = 0;
  for (const slug of exemplars) {
    if (shown >= 2) break;
    const p = wikiPath(slug);
    if (fs.existsSync(p)) {
      console.log(`### ${slug}\n`);
      console.log('```');
      console.log(fs.readFileSync(p, 'utf-8').trim());
      console.log('```\n');
      shown++;
    }
  }
  if (!shown) console.log('  (no exemplar cards in this vault yet)');
}

function cmdTimeline(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki timeline <slug>'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const includeRetired = !!args['include-retired'];

  const events = [];
  for (const o of parseObservations(page.body)) {
    if (o.superseded && !includeRetired) continue;
    if (o.dates.since) events.push({ date: o.dates.since, mark: 'since', obs: o });
    if (o.dates.until) events.push({ date: o.dates.until, mark: 'until', obs: o });
    if (o.dates.on)    events.push({ date: o.dates.on,    mark: 'on',    obs: o });
    if (o.dates.asOf)  events.push({ date: o.dates.asOf,  mark: 'as-of', obs: o });
  }

  // Also pull type=event pages where this slug is an attendee.
  forEachPage(({ slug: pageSlug, fm }) => {
    if (fm.type !== 'event' || !fm.when) return;
    const attendees = Array.isArray(fm.attendees) ? fm.attendees : [];
    const eventSlug = fm.id || pageSlug;
    if (attendees.includes(slug) || eventSlug === slug) {
      events.push({
        date: String(fm.when).slice(0, 10),
        mark: 'event',
        obs: { category: 'event', body: `${fm.title || eventSlug} → [[${eventSlug}]]` },
      });
    }
  });

  if (events.length === 0) { console.log(`(no dated observations or events on ${slug})`); return; }
  events.sort((a, b) => a.date.localeCompare(b.date));
  for (const e of events) {
    console.log(`${e.date}  ${e.mark.padEnd(6)} [${e.obs.category}] ${e.obs.body}`);
  }
}

function cmdStubs(args) {
  const topN = parseInt(args.top || '50', 10);
  const referencedBy = new Map(); // slug -> Set of slugs that link to it
  forEachPage(({ slug: from, body }) => {
    for (const t of extractWikilinks(body)) {
      if (!referencedBy.has(t)) referencedBy.set(t, new Set());
      referencedBy.get(t).add(from);
    }
  });
  const stubs = [];
  for (const [slug, refs] of referencedBy.entries()) {
    if (!fs.existsSync(wikiPath(slug))) {
      stubs.push({ slug, count: refs.size, refs: [...refs] });
    }
  }
  stubs.sort((a, b) => b.count - a.count);
  if (stubs.length === 0) { console.log('(no stubs — every wikilink resolves)'); return; }
  const showRefs = args['show-refs'];
  for (const s of stubs.slice(0, topN)) {
    if (showRefs) {
      console.log(`${s.count}\t${s.slug}\t${s.refs.join(', ')}`);
    } else {
      console.log(`${s.count}\t${s.slug}`);
    }
  }
  if (stubs.length > topN) console.log(`... ${stubs.length - topN} more (use --top N)`);
}

function cmdPlace(args) {
  const query = args._[0];
  if (!query) { console.error('Usage: wiki place "concept or title"'); process.exit(1); }

  // 1. Find existing matches via resolve (re-use logic)
  const qLower = query.toLowerCase();
  const matches = [];
  forEachPage(({ slug, fm }) => {
    const title = (fm.title || '').trim();
    const aliases = aliasesOf(fm);
    if (slug === query || (title && title.toLowerCase() === qLower)) {
      matches.push({ slug, confidence: 1.0, reason: 'exact match' });
    } else if (aliases.find((a) => a.toLowerCase() === qLower)) {
      matches.push({ slug, confidence: 0.9, reason: 'alias match' });
    } else if (title && (title.toLowerCase().includes(qLower) || qLower.includes(title.toLowerCase())) && title.length >= 3) {
      matches.push({ slug, confidence: 0.7, reason: `substring of title "${title}"` });
    }
  });

  if (matches.length > 0) {
    matches.sort((a, b) => b.confidence - a.confidence);
    console.log(`# Existing pages (confidence ≥ 0.7)`);
    for (const m of matches.slice(0, 5)) console.log(`  ${m.slug}\t${m.confidence.toFixed(2)}\t(${m.reason})`);
    console.log('');
    console.log('Action: do NOT create new. Use `wiki patch <slug>` to add info, or `wiki print <slug>` to verify.');
    return;
  }

  // 2. Similar topics: token-overlap on titles + content search
  const queryTokens = qLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const queryTokensSet = new Set(queryTokens);
  const similar = {};
  forEachPage(({ slug, fm, body }) => {
    const title = (fm.title || '').toLowerCase();
    const titleTokens = title.split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    for (const t of titleTokens) if (queryTokensSet.has(t)) score += 3;
    // Body contains any query token?
    const activeBodyLower = stripSupersededObservationLines(body).toLowerCase();
    for (const t of queryTokens) {
      if (activeBodyLower.includes(t)) { score += 1; break; }
    }
    if (score > 0) similar[slug] = { score, fm };
  });

  const ranked = Object.entries(similar).sort((a, b) => b[1].score - a[1].score).slice(0, 5);
  if (ranked.length) {
    console.log('# Similar topics in vault');
    for (const [slug, info] of ranked) {
      const tags = Array.isArray(info.fm.tags) ? info.fm.tags.join(', ') : '';
      console.log(`  ${slug}\t${info.fm.type || 'note'}\t[${tags}]\t${info.fm.title || ''}`);
    }
    console.log('');
  } else {
    console.log('# No similar topics found');
    console.log('');
  }

  // 3. Suggestions: tag frequency among similar pages
  if (ranked.length) {
    const tagFreq = {};
    const typeFreq = {};
    for (const [, info] of ranked) {
      const tags = Array.isArray(info.fm.tags) ? info.fm.tags : [];
      for (const t of tags) tagFreq[t] = (tagFreq[t] || 0) + 1;
      const ty = info.fm.type || 'note';
      typeFreq[ty] = (typeFreq[ty] || 0) + 1;
    }
    const topType = Object.entries(typeFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || 'note';
    const topTags = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    console.log('# Suggested for new page');
    console.log(`  type: ${topType}`);
    if (topTags.length) console.log(`  tags: ${topTags.join(', ')}`);
    console.log(`  anchor candidates (existing pages to link to): ${ranked.slice(0, 3).map(([s]) => `[[${s}]]`).join(' ')}`);
  } else {
    console.log('# Suggested for new page');
    console.log('  No anchors found. Run `wiki hubs` for top-of-graph pages to link to, or create as a root with --no-anchor.');
  }
}

module.exports = { cmdLinks, cmdBacklinks, cmdRelations, cmdObservations, cmdAutolink, cmdResolve, cmdPath, cmdHubs, cmdHooks, cmdProcess, cmdTimeline, cmdStubs, cmdPlace };
