// unlink.js — revert specific [[wikilinks]] back to their original words.
//
// Pure: strings and data in, strings and data out. No fs, no globals.
//
// Why: autolink once replaced words inside other names ("Clay [[mathematics]]
// Institute", a different "[[person]] Surname"). The original words are known
// exactly (from vault history), so the repair is a byte-exact swap, applied
// only where the line is still unchanged. Anything stale is skipped, never
// guessed.
//
//   applyUnlinks(body, entries) -> { body, applied, skipped }
//     entries: [{ line, offset, target, original }]
//       line     — the exact current line containing the link
//       offset   — character index of "[[target]]" within that line
//       target   — slug inside the link
//       original — words to restore in place of the link
//     Every identical copy of `line` in the body is repaired the same way.
//     skipped: [{ entry, reason }] with reason 'line-not-found' | 'link-mismatch'.

'use strict';

function applyUnlinks(body, entries) {
  const lines = body.split('\n');
  const skipped = [];
  let applied = 0;
  // Group by line so several links on one line use offsets into the same
  // original text, applied right-to-left to keep earlier offsets valid.
  const byLine = new Map();
  for (const e of entries) {
    if (!byLine.has(e.line)) byLine.set(e.line, []);
    byLine.get(e.line).push(e);
  }
  for (const [line, group] of byLine) {
    const idxs = [];
    lines.forEach((l, i) => { if (l === line) idxs.push(i); });
    if (!idxs.length) { for (const e of group) skipped.push({ entry: e, reason: 'line-not-found' }); continue; }
    let fixed = line;
    const ok = [];
    const done = new Set(); // a duplicate entry must not splice into already-fixed text
    for (const e of [...group].sort((a, b) => b.offset - a.offset)) {
      if (done.has(e.offset)) continue;
      const link = `[[${e.target}]]`;
      if (line.slice(e.offset, e.offset + link.length) !== link) { skipped.push({ entry: e, reason: 'link-mismatch' }); continue; }
      fixed = fixed.slice(0, e.offset) + e.original + fixed.slice(e.offset + link.length);
      done.add(e.offset);
      ok.push(e);
    }
    if (!ok.length) continue;
    for (const i of idxs) lines[i] = fixed;
    applied += ok.length * idxs.length;
  }
  return { body: lines.join('\n'), applied, skipped };
}

module.exports = { applyUnlinks };
