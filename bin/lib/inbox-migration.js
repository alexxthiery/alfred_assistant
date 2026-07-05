'use strict';

const fs = require('node:fs');
const path = require('node:path');

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function normalizeRelPath(value, label) {
  const rel = String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) throw new Error(`${label} is required`);
  if (rel.split('/').includes('..')) throw new Error(`${label} must not contain '..': ${value}`);
  return rel;
}

function validateKind(kind) {
  const k = String(kind || 'transcripts').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(k)) throw new Error(`kind must be a slug-like directory name: ${kind}`);
  return k;
}

function walkFiles(root, opts = {}) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const skipDirs = opts.skipDirs || new Set();
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name) || ent.name.startsWith('_')) continue;
        walk(abs);
      } else if (ent.isFile()) {
        out.push(abs);
      }
    }
  }
  walk(root);
  return out.sort();
}

function readWikiFiles(vaultRoot) {
  const wikiDir = path.join(vaultRoot, 'wiki');
  if (!fs.existsSync(wikiDir)) return [];
  return fs.readdirSync(wikiDir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !['index.md', 'log.md'].includes(f))
    .sort()
    .map((file) => {
      const absPath = path.join(wikiDir, file);
      return { absPath, relPath: toPosix(path.relative(vaultRoot, absPath)), text: fs.readFileSync(absPath, 'utf8') };
    });
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function removeEmptyDirs(dir, stopDir) {
  if (!fs.existsSync(dir)) return;
  let cur = dir;
  while (cur.startsWith(stopDir) && cur !== stopDir) {
    try {
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

function planInboxSourceMigration({ vaultRoot, prefix = 'inbox', kind = 'transcripts' }) {
  const root = path.resolve(vaultRoot);
  const inboxPrefix = normalizeRelPath(prefix, 'prefix');
  if (inboxPrefix !== 'inbox' && !inboxPrefix.startsWith('inbox/')) {
    throw new Error(`prefix must be under inbox/: ${prefix}`);
  }
  const rawKind = validateKind(kind);
  const inboxDir = path.join(root, inboxPrefix);
  const inboxRoot = path.join(root, 'inbox');
  const rawDir = path.join(root, 'raw', rawKind);
  const wikiFiles = readWikiFiles(root);
  const candidates = [];
  const unreferenced = [];
  const blocked = [];

  for (const absPath of walkFiles(inboxDir, { skipDirs: new Set(['_processed', '_pending']) })) {
    const oldRel = toPosix(path.relative(root, absPath));
    const relUnderInbox = oldRel.slice('inbox/'.length);
    const newRel = toPosix(path.join('raw', rawKind, relUnderInbox));
    const newAbsPath = path.join(root, newRel);
    let occurrenceCount = 0;
    const pages = [];
    for (const wf of wikiFiles) {
      const n = countOccurrences(wf.text, oldRel);
      if (n) {
        occurrenceCount += n;
        pages.push({ relPath: wf.relPath, count: n });
      }
    }
    if (!occurrenceCount) {
      unreferenced.push({ oldRel });
      continue;
    }
    if (fs.existsSync(newAbsPath)) {
      blocked.push({ oldRel, newRel, reason: 'destination exists' });
      continue;
    }
    candidates.push({
      oldRel,
      newRel,
      oldAbsPath: absPath,
      newAbsPath,
      occurrenceCount,
      pages,
    });
  }

  return { vaultRoot: root, inboxRoot, rawDir, wikiFiles, candidates, unreferenced, blocked };
}

function applyInboxSourceMigration(opts) {
  const dryRun = !!opts.dryRun;
  const plan = planInboxSourceMigration(opts);
  if (plan.blocked.length) {
    const err = new Error(`${plan.blocked.length} inbox source migration(s) blocked`);
    err.code = 'MIGRATION_BLOCKED';
    err.plan = plan;
    throw err;
  }
  if (dryRun || plan.candidates.length === 0) return { ...plan, migrated: 0, rewrittenPages: 0, rewriteCount: 0 };

  const replacements = new Map(plan.candidates.map((m) => [m.oldRel, m.newRel]));
  let rewrittenPages = 0;
  let rewriteCount = 0;
  for (const wf of plan.wikiFiles) {
    let next = wf.text;
    for (const [oldRel, newRel] of replacements.entries()) {
      const n = countOccurrences(next, oldRel);
      if (!n) continue;
      rewriteCount += n;
      next = next.split(oldRel).join(newRel);
    }
    if (next !== wf.text) {
      fs.writeFileSync(wf.absPath, next);
      rewrittenPages++;
    }
  }

  for (const m of plan.candidates) {
    fs.mkdirSync(path.dirname(m.newAbsPath), { recursive: true });
    fs.renameSync(m.oldAbsPath, m.newAbsPath);
    removeEmptyDirs(path.dirname(m.oldAbsPath), plan.inboxRoot);
  }

  return { ...plan, migrated: plan.candidates.length, rewrittenPages, rewriteCount };
}

module.exports = {
  applyInboxSourceMigration,
  planInboxSourceMigration,
};
