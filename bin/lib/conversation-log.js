// conversation-log.js — local-only debug transcript mirroring.
//
// Full conversations are more sensitive than normal vault cards. This module
// writes only below <vault>/.alfred/private/conversations/, verifies that git
// ignores that path, and redacts common secret shapes before storing copies.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { isPathInside } = require('./vault-binding.js');

const DEFAULT_EXTENSIONS = ['.md', '.txt', '.jsonl', '.json'];

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function safeName(s, fallback = 'default') {
  const out = String(s || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || fallback;
}

function relUnix(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function parseExtensions(value) {
  if (!value) return DEFAULT_EXTENSIONS;
  return String(value).split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.startsWith('.') ? x : `.${x}`);
}

function assertNotSymlink(p, label) {
  if (!fs.existsSync(p)) return;
  if (fs.lstatSync(p).isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${p}`);
  }
}

function ensurePrivateConversationRoot(vaultRoot) {
  const vaultReal = fs.realpathSync(path.resolve(vaultRoot));
  const alfredDir = path.join(vaultReal, '.alfred');
  const privateDir = path.join(alfredDir, 'private');
  const root = path.join(privateDir, 'conversations');

  assertNotSymlink(alfredDir, '<vault>/.alfred');
  fs.mkdirSync(alfredDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(privateDir, '<vault>/.alfred/private');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(root, '<vault>/.alfred/private/conversations');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const rootReal = fs.realpathSync(root);
  const privateReal = fs.realpathSync(privateDir);
  if (!isPathInside(privateReal, rootReal)) {
    throw new Error(`conversation log root escaped .alfred/private: ${rootReal}`);
  }
  return rootReal;
}

function gitCheckIgnored(vaultRoot, relPath) {
  const vault = path.resolve(vaultRoot);
  try {
    execFileSync('git', ['-C', vault, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    return { checked: false, ignored: false, reason: 'not a git worktree' };
  }
  try {
    execFileSync('git', ['-C', vault, 'check-ignore', relPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { checked: true, ignored: true };
  } catch {
    return { checked: true, ignored: false };
  }
}

function assertGitIgnored(vaultRoot, relPath) {
  const check = gitCheckIgnored(vaultRoot, relPath);
  if (check.checked && !check.ignored) {
    throw new Error(`${relPath} is not gitignored; refusing to mirror full conversations into a trackable path`);
  }
  return check;
}

function replaceWithCount(text, re, replacement) {
  let count = 0;
  const out = text.replace(re, (...args) => {
    count++;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  return { text: out, count };
}

function redactSecrets(input) {
  let text = String(input);
  let redactions = 0;
  const rules = [
    {
      re: /\b((?:TELEGRAM_BOT_TOKEN|GMAIL_APP_PASSWORD|GMAIL_IMAP_APP_PASSWORD|ALFRED_BIRD_AUTH_TOKEN|ALFRED_BIRD_CT0|ANTHROPIC_API_KEY|OPENAI_API_KEY|ONECLI_API_KEY)\s*=\s*)([^\s]+)/g,
      replacement: (_m, prefix) => `${prefix}[REDACTED]`,
    },
    {
      re: /\b(Authorization:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
      replacement: (_m, prefix) => `${prefix}[REDACTED]`,
    },
    {
      re: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
      replacement: '[REDACTED:telegram-token]',
    },
    {
      re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
      replacement: '[REDACTED:anthropic-key]',
    },
    {
      re: /\bsk-[A-Za-z0-9_-]{32,}\b/g,
      replacement: '[REDACTED:api-key]',
    },
  ];
  for (const rule of rules) {
    const r = replaceWithCount(text, rule.re, rule.replacement);
    text = r.text;
    redactions += r.count;
  }
  return { text, redactions };
}

function listConversationFiles(sourceDir, extensions = DEFAULT_EXTENSIONS) {
  const sourceReal = fs.realpathSync(path.resolve(sourceDir));
  const allowed = new Set(extensions);
  const files = [];
  const skippedSymlinks = [];

  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        skippedSymlinks.push(relUnix(sourceReal, p));
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile() && allowed.has(path.extname(name))) {
        files.push(p);
      }
    }
  }

  walk(sourceReal);
  return { sourceReal, files, skippedSymlinks };
}

function defaultSourceName(sourceReal) {
  const base = path.basename(sourceReal);
  if (base === 'conversations') return path.basename(path.dirname(sourceReal));
  return base;
}

function importConversationFiles(opts = {}) {
  const {
    vaultRoot,
    sourceDir,
    provider = 'nanoclaw',
    sourceName,
    extensions,
    dryRun = false,
    now = () => new Date().toISOString(),
  } = opts;

  if (!vaultRoot) throw new Error('vaultRoot is required');
  if (!sourceDir) throw new Error('--source is required');
  if (!fs.existsSync(sourceDir)) throw new Error(`source directory does not exist: ${sourceDir}`);
  if (!fs.statSync(sourceDir).isDirectory()) throw new Error(`source is not a directory: ${sourceDir}`);

  const vaultReal = fs.realpathSync(path.resolve(vaultRoot));
  const root = ensurePrivateConversationRoot(vaultReal);
  assertGitIgnored(vaultReal, '.alfred/private/conversations/probe');

  const scan = listConversationFiles(sourceDir, extensions || DEFAULT_EXTENSIONS);
  const providerSafe = safeName(provider, 'provider');
  const sourceSafe = safeName(sourceName || defaultSourceName(scan.sourceReal), 'source');
  const destRoot = path.join(root, providerSafe, sourceSafe);
  const destRootParent = fs.realpathSync(root);
  if (!dryRun) fs.mkdirSync(destRoot, { recursive: true, mode: 0o700 });
  const destRootReal = fs.existsSync(destRoot) ? fs.realpathSync(destRoot) : path.resolve(destRoot);
  if (!isPathInside(destRootParent, destRootReal)) {
    throw new Error(`destination escaped private conversation root: ${destRootReal}`);
  }

  const importedAt = now();
  const records = [];
  let copied = 0;
  let unchanged = 0;
  let redactions = 0;

  for (const file of scan.files) {
    const sourceRel = relUnix(scan.sourceReal, file);
    if (sourceRel.startsWith('../') || path.isAbsolute(sourceRel)) {
      throw new Error(`source path escaped source directory: ${file}`);
    }
    const sourceBuf = fs.readFileSync(file);
    const sourceText = sourceBuf.toString('utf8');
    const redacted = redactSecrets(sourceText);
    redactions += redacted.redactions;

    const dest = path.join(destRoot, sourceRel);
    const destRel = relUnix(vaultReal, dest);
    if (!destRel.startsWith('.alfred/private/conversations/')) {
      throw new Error(`destination is outside private conversations: ${destRel}`);
    }

    const storedSha = sha256(redacted.text);
    let didCopy = false;
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      assertNotSymlink(dest, 'conversation log destination file');
      const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
      if (existing == null || sha256(existing) !== storedSha) {
        fs.writeFileSync(dest, redacted.text, { mode: 0o600 });
        copied++;
        didCopy = true;
      } else {
        unchanged++;
      }
    }

    const st = fs.statSync(file);
    records.push({
      schema_version: 1,
      kind: 'conversation_file',
      provider: providerSafe,
      source_name: sourceSafe,
      session_id: sourceRel.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_'),
      source_rel: sourceRel,
      vault_rel: destRel,
      source_sha256: sha256(sourceBuf),
      stored_sha256: storedSha,
      source_bytes: sourceBuf.length,
      stored_bytes: Buffer.byteLength(redacted.text, 'utf8'),
      source_mtime: st.mtime.toISOString(),
      imported_at: importedAt,
      redactions: redacted.redactions,
      changed: dryRun ? null : didCopy,
    });
  }

  const manifestRel = `.alfred/private/conversations/${providerSafe}/${sourceSafe}/manifest.jsonl`;
  if (!dryRun) {
    const manifestPath = path.join(vaultReal, manifestRel);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
    assertNotSymlink(manifestPath, 'conversation manifest');
    fs.writeFileSync(manifestPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
  }

  return {
    vaultRoot: vaultReal,
    privateRoot: root,
    provider: providerSafe,
    sourceName: sourceSafe,
    sourceRoot: scan.sourceReal,
    manifestRel,
    files: records.length,
    copied,
    unchanged,
    redactions,
    skippedSymlinks: scan.skippedSymlinks,
    dryRun: !!dryRun,
  };
}

module.exports = {
  DEFAULT_EXTENSIONS,
  ensurePrivateConversationRoot,
  gitCheckIgnored,
  assertGitIgnored,
  redactSecrets,
  listConversationFiles,
  importConversationFiles,
  parseExtensions,
};
