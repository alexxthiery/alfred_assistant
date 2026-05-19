// obsid.js — pure primitives for minting/parsing observation IDs.
//
// Every `[fact]` / `[hypothesis]` / etc. line carries an invisible HTML-comment
// marker `<!--obs:XXXXXX-->` (six base36 chars, ~2.18B id space). Markers are
// minted at write time and survive frontmatter round-trip verbatim. The marker
// is invisible in markdown renderers; CLI uses it as a stable handle for
// surgical edits, FTS index keying, transclusion, and dedup.
//
// No fs, no spawn — pure module.

'use strict';

const crypto = require('node:crypto');

const ID_RE = /<!--obs:([a-z0-9]{6})-->/;
const ID_STRIP_RE = /<!--obs:[a-z0-9]{6}-->/g;
const OBS_LINE_RE = /^- (~~)?\[(fact|hypothesis|opinion|claim|quote|question|decision|todo|idea|prediction)\]/;

// Mint a 6-char base36 id. Crypto-strength entropy keeps minted ids
// unpredictable across processes; the 36^6 ≈ 2.18B space keeps collision
// probability below 1e-3 for vaults of size <60k observations.
function mintId() {
  const buf = crypto.randomBytes(6);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  const MOD = 36n ** 6n;
  return (n % MOD).toString(36).padStart(6, '0');
}

function extractId(line) {
  if (!line) return null;
  const m = line.match(ID_RE);
  return m ? m[1] : null;
}

function stripIdMarker(line) {
  if (!line) return line;
  return line.replace(ID_STRIP_RE, '');
}

// Walk body lines; append a fresh marker to observation lines that lack one.
// Idempotent. Non-observation lines (relations, prose, blanks, headings) are
// preserved verbatim. For superseded `~~[cat] ...~~` lines, the marker lands
// after the closing `~~` so the strikethrough wrap stays intact.
function mintIdsForBody(body) {
  if (!body) return body;
  const lines = body.split('\n');
  const out = lines.map((line) => {
    if (!OBS_LINE_RE.test(line)) return line;
    if (ID_RE.test(line)) return line;
    return `${line.replace(/\s+$/, '')} <!--obs:${mintId()}-->`;
  });
  return out.join('\n');
}

module.exports = { mintId, extractId, stripIdMarker, mintIdsForBody };
