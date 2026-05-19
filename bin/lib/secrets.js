// secrets.js — secret-shape detection + redaction for the vault.
//
// Two responsibilities:
//   detectSecrets(text) → [{name, excerpt, index}]
//     Scan for high-confidence secret patterns. Returns one hit per match.
//   redactSecrets(text) → string
//     Same patterns, but replace each match with <REDACTED:name> in the
//     returned string. Used by log/commit/audit-output surfaces.
//
// The patterns target shapes with low false-positive rate, on purpose. We
// would rather miss a creative password format than refuse legitimate writes.
// The strict audit rule + the redaction sites are defense in depth: a novel
// shape that slips past detection still doesn't reach the page body unless
// it's already there, and the per-surface redactors catch most known leaks.
//
// Pure — no fs, no globals. Safe to require() from unit tests.

'use strict';

// Each entry: { name, re, hint? }
//   name : short identifier surfaced in <REDACTED:name>
//   re   : RegExp with the /g flag (every match consumed)
//   hint : optional one-line description for audit fix messages
const SECRET_PATTERNS = [
  {
    name: 'openai-or-stripe-key',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    hint: 'OpenAI/Stripe-style secret key (sk-…)',
  },
  {
    name: 'github-pat',
    re: /\bghp_[A-Za-z0-9]{20,}\b/g,
    hint: 'GitHub Personal Access Token (ghp_…)',
  },
  {
    name: 'github-pat-fine-grained',
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    hint: 'GitHub fine-grained PAT (github_pat_…)',
  },
  {
    name: 'slack-token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    hint: 'Slack token (xoxp/xoxb/xoxa/xoxr/xoxs-…)',
  },
  {
    name: 'aws-access-key-id',
    re: /\bAKIA[A-Z0-9]{16}\b/g,
    hint: 'AWS access key id (AKIA…)',
  },
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    hint: 'JSON Web Token (eyJ…header.payload.signature)',
  },
  {
    name: 'bearer-token',
    // Match "Bearer <chars>" but skip the literal word "Bearer" alone.
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
    hint: 'HTTP Authorization Bearer token',
  },
  {
    name: 'password-assignment',
    // password = "…" or password: "…" — also catches db_password, mysql_password,
    // etc. (no \b so the underscore-prefixed forms match). ≥4-char value avoids
    // matching empty-string placeholders.
    re: /password\s*[:=]\s*['"][^'"\n]{4,}['"]/gi,
    hint: 'literal password assignment (password: "…")',
  },
  {
    name: 'iban',
    // Two letters + 2 digits + 11–30 alphanumerics. Modern IBAN spec is
    // up to 34 chars total. We require word boundaries.
    re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    hint: 'IBAN-shaped account number',
  },
  {
    name: 'credit-card',
    // 13–19 digit groups in standard 4-group form, optionally separated by
    // spaces or hyphens. The space/hyphen variant is the high-signal one;
    // bare 16-digit numbers are too prone to false positives (timestamps,
    // tracking IDs).
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    hint: 'credit-card-shaped number (consider rephrasing as "card on file at <bank>")',
    // Validator: Luhn-check before emitting a hit. Keeps the high-FP regex
    // honest. Applied in detectSecrets below.
    validate: (s) => luhnValid(s.replace(/[ -]/g, '')),
  },
];

// Luhn checksum — credit cards conform; random tracking IDs almost never do.
// This is the load-bearing piece that keeps the credit-card pattern low-FP.
function luhnValid(numericString) {
  if (!/^\d{13,19}$/.test(numericString)) return false;
  let sum = 0;
  let alt = false;
  for (let i = numericString.length - 1; i >= 0; i--) {
    let n = Number(numericString[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Run every pattern over `text`. Returns one entry per match in document order.
// Patterns are independent; a credit card embedded in a JWT-shape would emit
// two hits — both get redacted by redactSecrets.
function detectSecrets(text) {
  if (!text || typeof text !== 'string') return [];
  const hits = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const excerpt = m[0];
      if (p.validate && !p.validate(excerpt)) continue;
      hits.push({ name: p.name, excerpt, index: m.index, hint: p.hint });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

// Return `text` with every secret-shape match replaced by <REDACTED:name>.
// Multi-pattern overlaps fold into a single redaction (the earliest-matching
// pattern wins). Safe to call on already-redacted text — the marker itself
// doesn't match any pattern.
function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  const hits = detectSecrets(text);
  if (hits.length === 0) return text;
  // Apply substitutions from right to left so earlier indexes stay valid.
  let out = text;
  const sorted = hits.slice().sort((a, b) => b.index - a.index);
  for (const h of sorted) {
    out = out.slice(0, h.index) + `<REDACTED:${h.name}>` + out.slice(h.index + h.excerpt.length);
  }
  return out;
}

module.exports = {
  SECRET_PATTERNS,
  detectSecrets,
  redactSecrets,
  luhnValid,
};
