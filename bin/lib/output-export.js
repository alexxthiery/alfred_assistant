// lib/output-export.js — pure filename logic for `wiki export`.
//
// No fs, no process, no globals; re-entrant. The command module
// (bin/commands/export.js) owns the fs side-effects; this module decides WHAT
// to name a deliverable file, safely. It is the robustness/security surface for
// writes into the vault's output/ directory, so the rules here are deliberately
// strict and exhaustively unit-tested (tests/unit/output-export.test.js).
//
// Contract:
//   - splitNameExt(name, explicitExt): separate the base from its extension.
//       --ext wins and strips a matching trailing suffix from the name;
//       otherwise a trailing `.<alnum>` on the name is taken as the extension.
//       Default extension is `md`.
//   - sanitizeExportSlug(base): turn an arbitrary, possibly hostile name into a
//       single safe path segment — no directory separators, no `..` traversal,
//       no hidden-file (leading-dot) names, no whitespace or control chars.
//       Returns { ok:false, error } rather than guessing when nothing safe
//       remains (fail-to-safe; the caller refuses the write).
//   - normalizeExt(ext): constrain the extension to a short alphanumeric token.
//   - resolveExportFilename(slug, ext, existing, {force}): pick a non-colliding
//       filename given the directory's existing entries (or overwrite on force).
//   - buildExportFilename({name, ext, existing, force}): compose all of the
//       above into a single { ok, filename } result.

'use strict';

const MAX_SLUG_LEN = 120;

// Separate a user-supplied name into { base, ext } BEFORE sanitization, so the
// extension is never double-applied (`report.md` + default md → `report.md`,
// not `report.md.md`). An explicit --ext takes precedence and strips a matching
// suffix off the name; otherwise infer the extension from a trailing `.<alnum>`.
function splitNameExt(name, explicitExt) {
  const raw = String(name == null ? '' : name);
  if (explicitExt !== undefined && explicitExt !== null && explicitExt !== true && explicitExt !== '') {
    const e = String(explicitExt).trim().replace(/^\.+/, '').toLowerCase();
    const re = new RegExp(`\\.${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    return { base: raw.replace(re, ''), ext: e };
  }
  const m = raw.match(/^(.*[^.\s])\.([A-Za-z0-9]{1,8})$/);
  if (m) return { base: m[1], ext: m[2].toLowerCase() };
  return { base: raw, ext: 'md' };
}

function sanitizeExportSlug(base) {
  if (typeof base !== 'string') return { ok: false, error: 'export name must be a string' };
  let s = base.trim();
  if (!s) return { ok: false, error: 'export name is empty' };
  // Replace every character outside the safe set with a hyphen. Safe set:
  // ASCII letters, digits, dot, underscore, hyphen, space (spaces fold to
  // hyphens below). This neutralizes `/`, `\`, `:`, control chars, and any
  // unicode — directory separators cannot survive, so the file stays in output/.
  s = s.replace(/[^A-Za-z0-9._ -]/g, '-');
  // Collapse whitespace and hyphen runs to a single hyphen.
  s = s.replace(/[\s-]+/g, '-');
  // Collapse dot runs to a single dot — this is what kills `..` traversal.
  s = s.replace(/\.{2,}/g, '.');
  // No leading/trailing separators or dots: no hidden files, no trailing dot.
  s = s.replace(/^[._-]+/, '').replace(/[._-]+$/, '');
  if (!s) return { ok: false, error: `export name has no usable characters after sanitization` };
  if (s.length > MAX_SLUG_LEN) s = s.slice(0, MAX_SLUG_LEN).replace(/[._-]+$/, '');
  return { ok: true, slug: s };
}

function normalizeExt(ext) {
  // Absent / bare flag → default markdown.
  if (ext === undefined || ext === null || ext === true || ext === '') return { ok: true, ext: 'md' };
  const e = String(ext).trim().replace(/^\.+/, '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(e)) {
    return { ok: false, error: `invalid --ext "${ext}" (use a short alphanumeric extension like md, txt, csv, json)` };
  }
  return { ok: true, ext: e };
}

function resolveExportFilename(slug, ext, existing, opts = {}) {
  const set = new Set(Array.isArray(existing) ? existing : []);
  const base = `${slug}.${ext}`;
  if (opts.force || !set.has(base)) return base;
  // Collision: suffix -2, -3, ... until a free name is found.
  for (let n = 2; n < 10000; n++) {
    const candidate = `${slug}-${n}.${ext}`;
    if (!set.has(candidate)) return candidate;
  }
  // Pathological (10k collisions): fall back to overwriting the base rather
  // than looping forever. Practically unreachable.
  return base;
}

function buildExportFilename({ name, ext, existing = [], force = false } = {}) {
  const split = splitNameExt(name, ext);
  const extCheck = normalizeExt(split.ext);
  if (!extCheck.ok) return { ok: false, error: extCheck.error };
  const slug = sanitizeExportSlug(split.base);
  if (!slug.ok) return { ok: false, error: slug.error };
  return {
    ok: true,
    filename: resolveExportFilename(slug.slug, extCheck.ext, existing, { force }),
    slug: slug.slug,
    ext: extCheck.ext,
  };
}

module.exports = {
  MAX_SLUG_LEN,
  splitNameExt,
  sanitizeExportSlug,
  normalizeExt,
  resolveExportFilename,
  buildExportFilename,
};
