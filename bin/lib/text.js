// text.js — accent-safe helpers for human-written names.
//
// Pure: strings in, strings out. No fs, no globals.
//
// Why: several call sites treated names as ASCII. "Dufrêne" was cut into
// "Dufr" + "ne", slugified to "dufr-ne", and never matched the page
// `renee-dufrene-olander`. Folding diacritics before comparing or slugifying
// keeps one canonical form per name.
//
//   foldDiacritics(s) — strip combining marks after NFKD ("Dufrêne" -> "Dufrene").
//   nameKey(s)        — comparison key: folded, lowercased, hyphens/whitespace
//                       collapsed to one space ("Renée Dufrêne-Ölander" and slug
//                       "renee-dufrene-olander" both -> "renee dufrene olander").
//   slugifyText(s)    — folded, lowercased, non-alphanumerics -> "-", trimmed.

'use strict';

function foldDiacritics(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/\p{M}/gu, '');
}

function nameKey(s) {
  return foldDiacritics(s).toLowerCase().replace(/[-\s]+/g, ' ').trim();
}

function slugifyText(s) {
  return foldDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = { foldDiacritics, nameKey, slugifyText };
