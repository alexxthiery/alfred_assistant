// autolink.js — turn bare title/alias mentions into [[wikilinks]].
//
// Pure: both exports are string-and-data in, string-and-data out. No fs, no
// process state. The caller (bin/wiki) is responsible for walking the vault
// to build the page list; this module's contract is the per-page injection
// behavior.
//
// Exported:
//   buildTitleEntries(pages) — pages: Array<{slug, fm}>. Returns
//     Array<{slug, pattern: RegExp, title: string}> with regex-escaped
//     word-bounded patterns. Titles + aliases ≥4 chars contribute one entry
//     each; same title from multiple aliases of the same page becomes
//     multiple entries (caller controls ordering — sort by title.length desc
//     to prefer longer matches first).
//   autolinkBody(body, ownSlug, titleMap) — Returns {body: string, injections: number}.
//     - Walks the body line-by-line, treating triple-backtick fences as opaque
//       (no link injection inside fenced blocks).
//     - For each title in titleMap, replaces the FIRST out-of-fence match per
//       page (not per title — first mention of the slug, across all of its
//       alias patterns, is what counts).
//     - Skips matches already inside `[[...]]` or inside the target of a
//       markdown link `[text](target)`.
//     - Skips entries whose slug === ownSlug (no self-link).
//
// Why a library? The autolink heuristic is fiddly (fence preservation,
// alias precedence, regex-special titles, no-self-link). Inline in bin/wiki
// it had no unit tests; pulling it out makes the contract testable in
// isolation. See audit/13 § module-purity.

'use strict';

const { isGenericAlias } = require('./maintenance.js');

function buildTitleEntries(pages) {
  const map = [];
  for (const { slug, fm } of pages) {
    const title = (fm.title || '').trim();
    const aliases = Array.isArray(fm.aliases) ? fm.aliases : (fm.aliases ? [fm.aliases] : []);
    // V1: the canonical TITLE is always an anchor, but a GENERIC alias ("optimal
    // policy", "successor measure") is NOT — autolink would splice it wherever
    // the common phrase appears in prose, often linking to the wrong card. Only
    // distinctive aliases earn an anchor; generic ones are excluded here so they
    // never enter the matcher set. (Genericness predicate shared with V6.)
    const variants = [title, ...aliases.filter((a) => !isGenericAlias(a))]
      .filter((v) => v && v.length >= 4 && !/^\s*$/.test(v));
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      map.push({ slug, pattern: new RegExp(`\\b${escaped}\\b`, 'g'), title: v });
    }
  }
  return map;
}

function autolinkBody(body, ownSlug, titleMap, ownTerms = []) {
  // V1 self-subject guard: phrases that NAME the page being processed (its own
  // title + aliases, lowercased) must never be turned into a link to ANOTHER
  // card. Without this, a sibling card's alias that happens to be this card's
  // subject term ("successor measure") overwrote this card's own opening with a
  // link elsewhere. Compared case-insensitively against the matched text.
  const ownSet = new Set((Array.isArray(ownTerms) ? ownTerms : [])
    .map((t) => String(t).trim().toLowerCase()).filter(Boolean));
  const segments = [];
  let buf = '';
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('```')) {
      if (buf) segments.push({ kind: inFence ? 'fence' : 'prose', text: buf });
      buf = line + '\n';
      segments.push({ kind: 'fenceMarker', text: buf });
      buf = '';
      inFence = !inFence;
      continue;
    }
    buf += line + '\n';
  }
  if (buf) segments.push({ kind: inFence ? 'fence' : 'prose', text: buf });

  let injections = 0;
  const seenSlugs = new Set();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind !== 'prose') continue;
    let text = seg.text;
    for (const { slug, pattern } of titleMap) {
      if (slug === ownSlug) continue;
      if (seenSlugs.has(slug)) continue;
      // Recompute existing [[...]] spans each slug (a prior injection may have
      // added one). A match inside any span must never be rewritten — doing so
      // produced nested `[[a-[[b]]-c]]` corruption (P0). The old 2-char
      // before/after check missed matches in the MIDDLE of a longer target.
      const spans = wikilinkSpans(text);
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const idx = m.index;
        const end = idx + m[0].length;
        // Inside an existing wikilink target → skip (no nested links).
        if (spans.some(([s, e]) => idx >= s && idx < e)) continue;
        // Hyphen-boundary guard: `\b` treats `-` as a boundary, so without this
        // an alias like "value-function" would match the sub-phrase inside a
        // longer slug "hjb-value-function-log-h". Only link a WHOLE token run,
        // never a hyphen-delimited fragment of a longer one.
        if (text[idx - 1] === '-' || text[end] === '-') continue;
        // Inside a markdown link target [text](target) → skip.
        if (/\]\([^)]*$/.test(text.slice(0, idx))) continue;
        // Self-subject guard: don't link a phrase that names THIS page.
        if (ownSet.has(m[0].toLowerCase())) continue;
        text = text.slice(0, idx) + `[[${slug}]]` + text.slice(end);
        injections++;
        seenSlugs.add(slug);
        break;
      }
    }
    segments[i] = { kind: 'prose', text };
  }
  return { body: segments.map((s) => s.text).join(''), injections };
}

// Byte ranges [start, end) of every `[[...]]` span in `text`. Used to forbid
// link injection inside an existing wikilink target.
function wikilinkSpans(text) {
  const spans = [];
  const re = /\[\[[^\]]*\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

module.exports = { buildTitleEntries, autolinkBody };
