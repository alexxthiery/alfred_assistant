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

function buildTitleEntries(pages) {
  const map = [];
  for (const { slug, fm } of pages) {
    const title = (fm.title || '').trim();
    const aliases = Array.isArray(fm.aliases) ? fm.aliases : (fm.aliases ? [fm.aliases] : []);
    const variants = [title, ...aliases].filter((v) => v && v.length >= 4 && !/^\s*$/.test(v));
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      map.push({ slug, pattern: new RegExp(`\\b${escaped}\\b`, 'g'), title: v });
    }
  }
  return map;
}

function autolinkBody(body, ownSlug, titleMap) {
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
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const idx = m.index;
        const before = text.slice(Math.max(0, idx - 2), idx);
        const after = text.slice(idx + m[0].length, idx + m[0].length + 2);
        if (before.endsWith('[[') || after.startsWith(']]')) continue;
        if (/\]\([^)]*$/.test(text.slice(0, idx))) continue;
        text = text.slice(0, idx) + `[[${slug}]]` + text.slice(idx + m[0].length);
        injections++;
        seenSlugs.add(slug);
        break;
      }
    }
    segments[i] = { kind: 'prose', text };
  }
  return { body: segments.map((s) => s.text).join(''), injections };
}

module.exports = { buildTitleEntries, autolinkBody };
