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
const { spawnSync } = require('node:child_process');

const { parseFrontmatter } = require('../lib/frontmatter.js');
const { extractWikilinks, parseObservations, parseRelations } = require('../lib/graph.js');
const { VAULT_ROOT, WIKI_DIR, wikiPath, listWikiPages, readPage, forEachPage } = require('../lib/vault.js');
const { loadVaultDb, ensureDuckdbAvailable, resolveDuckdbBin } = require('../lib/duckdb.js');
const { parseSynonymsFile, expandQuery } = require('../lib/synonyms.js');
const { buildTitleEntries } = require('../lib/autolink.js');
const { compileTagExpressionToSql } = require('../lib/tag-filter.js');
const { isISODate } = require('../lib/date.js');

function cmdList(args) {
  // HR25: --slugs-only emits one slug per line, no title/tags. Token-economy
  // for agents that enumerate-then-act on slugs (avg ~70% fewer tokens than
  // the default tab-separated form on a 13-page vault).
  const slugsOnly = !!args['slugs-only'];
  forEachPage(({ slug: fileSlug, fm }) => {
    const slug = fm.id || fileSlug;
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    if (args.tag && !tags.includes(args.tag)) return;
    if (args.type && fm.type !== args.type) return;
    if (slugsOnly) {
      console.log(slug);
      return;
    }
    const tagStr = tags.length ? `  [${tags.join(', ')}]` : '';
    console.log(`${slug}\t${fm.title || ''}${tagStr}`);
  });
}

// cmdSearch — three modes, ranked from preferred to fallback:
//
//   default      BM25 over observations.body via DuckDB FTS, with synonym
//                expansion from <vault-root>/SYNONYMS.md. Returns ranked
//                slug · score · body excerpt. The retrieval primitive for
//                Alfred-agent workflows.
//   --literal    substring match across page bodies (the pre-FTS behaviour).
//                Use when the query contains DuckDB-tokeniser-hostile chars or
//                when you want to find raw markdown like "<!--obs:abc123-->".
//   --regex      regex match (anchored is up to the caller).
//   --title-only restrict to page titles (substring); always JS-side, no FTS.
function cmdSearch(args) {
  const query = args._[0];
  if (!query && !args.tag) {
    console.error('Usage: wiki search <query> [--tag T] [--limit N] [--literal] [--regex] [--title-only]');
    process.exit(1);
  }
  const limit = Math.max(1, parseInt(args.limit, 10) || 20);
  const useLiteral = !!args.literal;
  const useRegex = !!args.regex;
  const useTitleOnly = !!args['title-only'];
  const useFts = query && !useLiteral && !useRegex && !useTitleOnly;
  if (useFts) {
    cmdSearchBm25(query, { limit, tag: args.tag });
    return;
  }
  cmdSearchJs(query, { tag: args.tag, useLiteral, useRegex, useTitleOnly });
}

// FTS retrieval: spawn duckdb against the cached vault.duckdb, BM25-rank
// observations, then pretty-print. Output format:
//   <slug> <TAB> <score> <TAB> <title>
//       …<excerpt of matching body>…
function cmdSearchBm25(query, opts) {
  ensureDuckdbAvailable();
  const dbPath = loadVaultDb();

  // Synonyms live at <vault-root>/SYNONYMS.md. If absent, expansion is a
  // pass-through lowercased identity — no warning, since a vault without
  // synonyms is the normal starting state.
  const synPath = path.join(VAULT_ROOT, 'SYNONYMS.md');
  const syns = fs.existsSync(synPath)
    ? parseSynonymsFile(fs.readFileSync(synPath, 'utf-8'))
    : new Map();
  const expanded = expandQuery(query, syns);
  // DuckDB string literal: escape single quotes by doubling.
  const sqlQ = expanded.replace(/'/g, "''");
  // B1 fix: push --tag filter into SQL via list_contains so LIMIT applies
  // AFTER the tag filter. Previously the JS-side post-pass dropped top-N
  // BM25 hits that didn't match the tag, silently undercounting.
  // Tag filter now supports zk-style boolean expressions:
  //   "X"               single tag (back-compat)
  //   "X OR Y"          OR within a clause
  //   "X, NOT Y"        AND between clauses; NOT excludes
  // Validation lives in the pure parser (lib/tag-filter.js); we just splice
  // the compiled WHERE fragment.
  let tagClause = '';
  if (opts.tag) {
    try { tagClause = compileTagExpressionToSql(opts.tag, 'v.tags'); }
    catch (e) { console.error(`error: --tag: ${e.message}`); process.exit(1); }
  }
  const sql = `
    SELECT v.slug AS slug, v.title AS title, o.body AS body,
           fts_main_observations.match_bm25(o.obs_uid, '${sqlQ}') AS score
    FROM observations o
    LEFT JOIN vault v ON v.slug = o.slug
    WHERE fts_main_observations.match_bm25(o.obs_uid, '${sqlQ}') IS NOT NULL${tagClause}
    ORDER BY score DESC
    LIMIT ${opts.limit};
  `;
  const r = spawnSync(resolveDuckdbBin(), [dbPath, '-jsonlines', '-noheader', '-c', sql], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error(`error: BM25 query failed: ${(r.stderr || '').split('\n')[0] || 'exit ' + r.status}`);
    console.error('  Hint: --literal or --regex use JS-side matching and bypass FTS.');
    process.exit(2);
  }
  // -jsonlines emits one JSON object per result row.
  const rows = (r.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);

  // Tag filter is now applied in SQL above; the result set is already
  // tag-correct. Just format and print.
  let printed = 0;
  for (const row of rows) {
    const score = typeof row.score === 'number' ? row.score.toFixed(3) : row.score;
    console.log(`${row.slug}\t${score}\t${row.title || ''}`);
    const excerpt = (row.body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (excerpt) console.log(`    …${excerpt}…`);
    printed++;
  }
  if (printed === 0) console.log('(no matches)');
}

// Legacy JS-side search path: substring (regex-escaped) or regex (raw) match
// across page titles + bodies. Preserved for --literal / --regex / --title-only.
function cmdSearchJs(query, opts) {
  let re = null;
  if (query) {
    const pattern = opts.useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(pattern, 'i');
  }
  let count = 0;
  forEachPage(({ slug: fileSlug, fm, body }) => {
    if (opts.tag) {
      const tags = Array.isArray(fm.tags) ? fm.tags : [];
      if (!tags.includes(opts.tag)) return;
    }
    const slug = fm.id || fileSlug;
    const title = fm.title || '';
    if (re) {
      if (opts.useTitleOnly) {
        if (!re.test(title)) return;
      } else {
        const titleMatch = re.test(title);
        const idx = body.search(re);
        if (!titleMatch && idx < 0) return;
        console.log(`${slug}\t${title}`);
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(body.length, idx + 80);
          console.log(`    …${body.slice(start, end).replace(/\s+/g, ' ').trim()}…`);
        }
        count++;
        return;
      }
    }
    console.log(`${slug}\t${title}`);
    count++;
  });
  if (count === 0) console.log('(no matches)');
}

function cmdAgenda(args) {
  // Windows: today | week | upcoming (default) | past | all
  // Plus: --on YYYY-MM-DD (or --month-day MM-DD) — "on this calendar day, any
  // year": matches event pages whose `when` shares MM-DD and person pages whose
  // `born` shares MM-DD. Year-only `when` (e.g. "2022-12") still has YYYY-MM
  // so its MM is comparable; date-less entries are skipped.
  const win = (args._[0] || args.window || 'upcoming').toLowerCase();
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 86400 * 1000 - 1;
  const endOfWeek = startOfToday + 7 * 86400 * 1000;

  // --on / --month-day handling (independent of the standard window switch).
  let onMD = null; // 'MM-DD' or null
  if (args['month-day']) {
    const v = String(args['month-day']);
    if (!/^\d{2}-\d{2}$/.test(v)) {
      console.error(`error: --month-day must be MM-DD (got "${v}")`);
      process.exit(1);
    }
    onMD = v;
  } else if (args.on) {
    const v = String(args.on);
    if (!isISODate(v)) {
      console.error(`error: --on must be YYYY-MM-DD (got "${v}")`);
      process.exit(1);
    }
    onMD = v.slice(5);
  }

  if (onMD) {
    cmdAgendaOnThisDay(onMD);
    return;
  }

  const events = [];
  forEachPage(({ slug: fileSlug, fm }) => {
    if (fm.type !== 'event') return;
    if (!fm.when) return;
    const ts = Date.parse(fm.when);
    if (isNaN(ts)) return;
    const slug = fm.id || fileSlug;
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
  });

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

// On-this-day query. md is 'MM-DD'. Surfaces:
//   - every `type: event` page whose `when` shares MM-DD (any year)
//   - every page with `born:` whose value shares MM-DD (year known or unknown)
// Output is two sections; either may be empty.
function cmdAgendaOnThisDay(md) {
  const events = [];
  const birthdays = [];
  forEachPage(({ slug: fileSlug, fm }) => {
    const slug = fm.id || fileSlug;
    if (fm.type === 'event' && fm.when) {
      const when = String(fm.when);
      // 'when' may be YYYY, YYYY-MM, YYYY-MM-DD, or full ISO. Extract MM-DD if
      // present; year-only entries lack a day so they cannot match.
      const dateOnly = when.slice(0, 10);
      if (dateOnly.length === 10 && dateOnly.slice(5) === md) {
        events.push({ slug, title: fm.title || slug, when: dateOnly });
      }
    }
    if (fm.born) {
      const v = String(fm.born);
      let bornMD = null;
      let bornYear = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { bornYear = v.slice(0, 4); bornMD = v.slice(5); }
      else if (/^\d{2}-\d{2}$/.test(v)) { bornMD = v; }
      if (bornMD === md) {
        birthdays.push({ slug, title: fm.title || slug, born: v, year: bornYear });
      }
    }
  });

  events.sort((a, b) => a.when.localeCompare(b.when));
  birthdays.sort((a, b) => (a.year || '9999').localeCompare(b.year || '9999'));

  if (events.length === 0 && birthdays.length === 0) {
    console.log(`(nothing on ${md})`);
    return;
  }
  if (events.length) {
    console.log(`## events on ${md} (any year)`);
    for (const e of events) console.log(`  ${e.when}  [[${e.slug}]]`);
  }
  if (birthdays.length) {
    if (events.length) console.log('');
    console.log(`## birthdays on ${md}`);
    const thisYear = new Date().getFullYear();
    for (const b of birthdays) {
      const ageStr = b.year ? ` (turns ${thisYear - Number(b.year)})` : '';
      console.log(`  ${b.born}  [[${b.slug}]]${ageStr}`);
    }
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
  if (!fs.existsSync(p)) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
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
    forEachPage(({ slug: from, body: b }) => {
      if (from === slug) return;
      if (re.test(b)) hits.push(from);
    });
    for (const s of hits) console.log(`- [[${s}]]`);
    if (hits.length === 0) console.log('_(none)_');
  }
}

function cmdSources() { cmdList({ _: [], type: 'source' }); }

// cmdRender — execute the first ```sql ... ``` fenced block on a type=view
// page. Saved-query view pages let users (and the agent) name a topical slice
// through the vault without manufacturing aggregator slugs. Refuses on pages
// whose frontmatter `type` isn't `view`, so a stray code block on an entity
// page can't be exfiltrated as a query.
function cmdRender(args) {
  const slug = args._[0];
  if (!slug) {
    console.error('Usage: wiki render <slug>');
    console.error('  Executes the first ```sql fenced block on a type=view page.');
    process.exit(1);
  }
  const page = readPage(slug);
  if (!page) {
    console.error(`error: page ${slug} does not exist`);
    console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`);
    process.exit(2);
  }
  if (page.fm.type !== 'view') {
    console.error(`error: page ${slug} has type=${page.fm.type || 'note'}; \`wiki render\` only runs against type=view pages.`);
    process.exit(2);
  }
  const m = page.body.match(/```\s*sql\b\s*\n([\s\S]*?)\n```/i);
  if (!m) {
    console.error(`error: page ${slug} has no \`\`\`sql fenced block to render.`);
    process.exit(2);
  }
  const sql = m[1].trim();
  if (!sql) {
    console.error(`error: page ${slug} has an empty \`\`\`sql block.`);
    process.exit(2);
  }
  ensureDuckdbAvailable();
  const dbPath = loadVaultDb();
  const res = spawnSync(resolveDuckdbBin(), [dbPath, '-c', sql], { stdio: 'inherit' });
  process.exit(res.status || 0);
}

// cmdChallenge: persona-driven red-team verb. Prints the page followed by a
// structured prompt instructing the agent to argue against it. Mechanism is
// dumb-by-design (a print + a prompt block); the intelligence lives in the
// agent reading the output. The point is the *forcing function*: explicit
// dissent rather than confirmation.
function cmdChallenge(args) {
  const slug = args._[0];
  if (!slug) {
    console.error('Usage: wiki challenge <slug>');
    console.error('  Prints the page and a red-team prompt asking the agent to argue against it.');
    process.exit(1);
  }
  const p = wikiPath(slug);
  if (!fs.existsSync(p)) {
    console.error(`error: page ${slug} does not exist`);
    console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`);
    process.exit(2);
  }
  process.stdout.write(fs.readFileSync(p, 'utf-8'));
  console.log('');
  console.log('---');
  console.log(`# Challenge prompt for [[${slug}]]`);
  console.log('');
  console.log('Read the page above and produce a structured red-team critique.');
  console.log('Do NOT defend the page or hedge. Argue as if you disagree.');
  console.log('');
  console.log('1. **Strongest objection.** Pick the single weakest claim and explain why it might be wrong.');
  console.log('2. **Missing alternatives.** Two plausible competing positions the page does not consider.');
  console.log('3. **Hidden assumptions.** What does the page take for granted that a critical reader would question?');
  console.log('4. **Provenance gaps.** Which claims rest on weak evidence (single source, no [as-of], outdated, motivated)?');
  console.log('5. **What new evidence would change my mind.** Concrete, falsifiable.');
  console.log('');
  console.log('Where you cite the page, quote the exact line. Be specific, not abstract.');
}

function cmdRelated(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki related <slug> [--unconnected]'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  // --unconnected (a.k.a. zk-style "--related"): filter to candidates that
  // share a neighbor with <slug> but are NOT yet directly connected to it.
  // Surfaces *new* connection opportunities; otherwise the connect-boost
  // signals (+3 for me-links-them, +3 for them-links-me) dominate the list
  // with pages already in the graph.
  const unconnected = !!args.unconnected;
  const myTags = new Set(Array.isArray(page.fm.tags) ? page.fm.tags : []);
  const myOutbound = new Set(extractWikilinks(page.body));
  const re = new RegExp(`\\[\\[${slug}\\]\\]`);

  // Single walk: build the backlinks set + the snapshot needed for scoring.
  const backlinks = new Set();
  const others = []; // [{slug, fm, body, outbound}]
  forEachPage(({ slug: other, fm, body }) => {
    if (other === slug) return;
    if (re.test(body)) backlinks.add(other);
    others.push({ slug: other, fm, body, outbound: new Set(extractWikilinks(body)) });
  });

  const scores = {};
  for (const o of others) {
    if (unconnected && (myOutbound.has(o.slug) || backlinks.has(o.slug))) continue;
    const otherTags = new Set(Array.isArray(o.fm.tags) ? o.fm.tags : []);
    let score = 0;
    for (const t of myTags) if (otherTags.has(t)) score += 2;
    if (!unconnected) {
      if (myOutbound.has(o.slug)) score += 3;
      if (backlinks.has(o.slug)) score += 3;
    }
    for (const t of myOutbound) if (o.outbound.has(t)) score += 1;
    if (score > 0) scores[o.slug] = { score, title: o.fm.title || '', type: o.fm.type || 'note' };
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1].score - a[1].score);
  if (ranked.length === 0) { console.log('(no related pages)'); return; }
  for (const [s, info] of ranked.slice(0, 20)) {
    console.log(`${info.score}\t${info.type}\t${s}\t${info.title}`);
  }
}

// cmdUnlinkedMentions — find pages whose body mentions <slug>'s title or any
// of its aliases (word-boundary, case-sensitive per autolink convention) but
// without a [[wikilink]] to <slug>. Read-only discovery sibling to
// `wiki autolink --dry-run`: surfaces wikilink-promotion candidates so Alfred
// (or the user) can decide where to invest in graph density. No writes.
function cmdUnlinkedMentions(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki unlinked-mentions <slug> [--limit N]'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const limit = args.limit !== undefined ? Math.max(1, Number(args.limit)) : 50;

  // Build title patterns for the target slug only (title + aliases, length ≥ 4
  // per autolink heuristic — same threshold so this verb's "would-promote"
  // signal matches what autolink would actually act on).
  const entries = buildTitleEntries([{ slug, fm: page.fm }]);
  if (entries.length === 0) {
    console.log(`(no titles/aliases ≥4 chars for ${slug}; nothing to match)`);
    return;
  }
  const wikilinkRe = new RegExp(`\\[\\[${slug}\\]\\]`);

  const hits = []; // { srcSlug, title, snippet }
  forEachPage(({ slug: srcSlug, fm, body }) => {
    if (srcSlug === slug) return;
    // If srcSlug already wikilinks to <slug>, no promotion needed — skip.
    if (wikilinkRe.test(body)) return;
    for (const { pattern, title } of entries) {
      pattern.lastIndex = 0;
      const m = pattern.exec(body);
      if (!m) continue;
      // Skip matches already inside a `[[...]]` (different target, same text)
      // or inside the target of a markdown link `[text](target)`.
      const idx = m.index;
      const before = body.slice(Math.max(0, idx - 2), idx);
      const after = body.slice(idx + m[0].length, idx + m[0].length + 2);
      if (before.endsWith('[[') || after.startsWith(']]')) continue;
      if (/\]\([^)]*$/.test(body.slice(0, idx))) continue;
      // Build a single-line snippet around the match for visual context.
      const lineStart = body.lastIndexOf('\n', idx) + 1;
      const lineEnd = body.indexOf('\n', idx);
      const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).trim();
      hits.push({ srcSlug, title: title, snippet: line.slice(0, 160) });
      break; // one hit per source page is enough — autolink would inject once.
    }
  });

  if (hits.length === 0) { console.log(`(no unlinked mentions of ${slug})`); return; }
  for (const h of hits.slice(0, limit)) {
    console.log(`${h.srcSlug}\t${h.title}`);
    if (h.snippet) console.log(`    …${h.snippet}…`);
  }
}

function cmdPreview(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki preview <slug> [--compact]'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const { fm, body } = page;
  // HR25: --compact drops decorative blank lines + heuristic body excerpt.
  // Mirrors cmdContext --compact pattern. Same data, ~30% fewer lines.
  const compact = !!args.compact;
  const tags = Array.isArray(fm.tags) ? fm.tags.join(', ') : '';
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : (fm.aliases ? [fm.aliases] : []);
  const updated = (fm.updated || '').slice(0, 10);
  const lines = body.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('#') && !t.startsWith('- [') && !t.startsWith('- "') && !/^- [a-z][a-z_]+ \[\[/.test(t);
  }).slice(0, 3);
  const obs = parseObservations(body).length;
  const rels = parseRelations(body).length;
  const re = new RegExp(`\\[\\[${slug}\\]\\]`);
  let inbound = 0;
  forEachPage(({ slug: from, body: b }) => {
    if (from === slug) return;
    if (re.test(b)) inbound++;
  });
  console.log(`${slug} · ${fm.title || ''} · ${fm.type || 'note'} · ${updated} · [${tags}]`);
  if (aliases.length) console.log(`aliases: ${aliases.join(', ')}`);
  if (fm.summary) console.log(`summary: ${fm.summary}`);
  if (lines.length && !compact) {
    console.log('');
    for (const l of lines) console.log(`  ${l.trim().slice(0, 120)}`);
  }
  if (!compact) console.log('');
  console.log(`${obs} observations · ${rels} outbound relations · ${inbound} inbound wikilinks`);
}

function cmdContext(args) {
  const slug = args._[0];
  if (!slug) { console.error('Usage: wiki context <slug> [--compact]'); process.exit(1); }
  const page = readPage(slug);
  if (!page) { console.error(`error: page ${slug} does not exist`); console.error(`  Hint: \`wiki resolve "${slug}"\` to fuzzy-match similar slugs.`); process.exit(2); }
  const { fm, body } = page;
  const tags = Array.isArray(fm.tags) ? fm.tags.join(', ') : '';
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : (fm.aliases ? [fm.aliases] : []);
  const compact = !!args.compact;
  // In compact mode: skip section headers, skip decorative blank lines, drop
  // the leading `# <slug>` banner. Same data, ~30% fewer lines.
  const sep = () => { if (!compact) console.log(''); };
  const section = (label) => { if (!compact) console.log(`# ${label}`); };

  if (!compact) console.log(`# ${slug}`);
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
    sep();
    section('external');
    for (const f of extLinks) console.log(`${compact ? '' : '  '}${f}: ${fm[f]}`);
  }

  // First 5 observations
  const obs = parseObservations(body);
  if (obs.length) {
    sep();
    section('observations');
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
    if (obs.length > 5) console.log(`${compact ? '' : '  '}(...${obs.length - 5} more)`);
  }

  // Outbound relations grouped by verb
  const outRels = parseRelations(body);
  if (outRels.length) {
    sep();
    section('outbound relations');
    const grouped = {};
    for (const r of outRels) (grouped[r.verb] ||= []).push(r.target);
    for (const v of Object.keys(grouped).sort()) {
      console.log(`- ${v}: ${grouped[v].map((s) => `[[${s}]]`).join(', ')}`);
    }
  }

  // Inbound relations + wikilinks
  const incomingRels = {};
  const incomingLinks = new Set();
  const incomingLinkRe = new RegExp(`\\[\\[${slug}\\]\\]`);
  forEachPage(({ slug: from, body: b }) => {
    if (from === slug) return;
    for (const r of parseRelations(b)) {
      if (r.target === slug) (incomingRels[r.verb] ||= []).push(from);
    }
    if (incomingLinkRe.test(b)) incomingLinks.add(from);
  });
  if (Object.keys(incomingRels).length) {
    sep();
    section('inbound relations');
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
    sep();
    section('1-hop neighbors');
    console.log([...neighbors].sort().map((s) => `[[${s}]]`).join(' '));
  }
}

// wiki day [YYYY-MM-DD] — date-scoped observation listing. Defaults to today.
// Wraps the SQL one-liner for `observations.on_date` so "what did I do
// today" is a single verb, not a SQL composition exercise.
function cmdDay(args) {
  let date = args._[0];
  if (!date) date = new Date().toISOString().slice(0, 10);
  if (!isISODate(date)) {
    console.error(`error: wiki day [YYYY-MM-DD]; got "${date}"`);
    process.exit(1);
  }
  ensureDuckdbAvailable();
  const dbPath = loadVaultDb();
  // on_date is pinned to VARCHAR at table creation (see duckdb.js), so a plain
  // equality is safe even on an all-null vault. No per-query CAST needed.
  const sql = `
    SELECT slug, body
    FROM observations
    WHERE on_date = '${date}' AND NOT superseded
    ORDER BY slug
  `;
  const r = spawnSync(resolveDuckdbBin(), [dbPath, '-jsonlines', '-noheader', '-c', sql], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error(`error: query failed: ${(r.stderr || '').split('\n')[0] || 'exit ' + r.status}`);
    process.exit(2);
  }
  const rows = (r.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
  if (rows.length === 0) {
    console.log(`(no observations on ${date})`);
    return;
  }
  for (const row of rows) {
    const body = (row.body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    console.log(`${row.slug}\t${body}`);
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
  cmdUnlinkedMentions,
  cmdAgenda,
  cmdDay,
  cmdContext,
  cmdChallenge,
  cmdRender,
};
