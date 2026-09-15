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
const SUPPORTED_EXTRACTORS = new Set(['claude-jsonl']);

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

function parseCsv(value) {
  if (!value) return [];
  return String(value).split(',').map((x) => x.trim()).filter(Boolean);
}

function formatDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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
      re: /\b((?:TELEGRAM_BOT_TOKEN|GMAIL_APP_PASSWORD|GMAIL_IMAP_APP_PASSWORD|ANTHROPIC_API_KEY|OPENAI_API_KEY|ONECLI_API_KEY)\s*=\s*)([^\s]+)/g,
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

function listConversationFiles(sourceDir, extensions = DEFAULT_EXTENSIONS, excludeDirs = []) {
  const sourceReal = fs.realpathSync(path.resolve(sourceDir));
  const allowed = new Set(extensions);
  const excludedDirNames = new Set(excludeDirs);
  const files = [];
  const skippedSymlinks = [];
  const skippedDirs = [];

  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        skippedSymlinks.push(relUnix(sourceReal, p));
        continue;
      }
      if (st.isDirectory()) {
        if (excludedDirNames.has(name)) {
          skippedDirs.push(relUnix(sourceReal, p));
          continue;
        }
        walk(p);
      } else if (st.isFile() && allowed.has(path.extname(name))) {
        files.push(p);
      }
    }
  }

  walk(sourceReal);
  return { sourceReal, files, skippedSymlinks, skippedDirs };
}

function defaultSourceName(sourceReal) {
  const base = path.basename(sourceReal);
  if (base === 'conversations') return path.basename(path.dirname(sourceReal));
  return base;
}

function textFromClaudeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (!block.type && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

function extractClaudeJsonlMessage(line, meta = {}) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const message = obj.message && typeof obj.message === 'object' ? obj.message : null;
  const role = message?.role;
  if (role !== 'user' && role !== 'assistant') return null;

  const text = textFromClaudeContent(message.content).trim();
  if (!text) return null;

  const redacted = redactSecrets(text);
  const cleaned = redacted.text.trim();
  if (!cleaned) return null;

  return {
    schema_version: 1,
    kind: 'conversation_message',
    provider: meta.provider,
    source_name: meta.sourceName,
    source_rel: meta.sourceRel,
    source_line: meta.sourceLine,
    source_byte_start: meta.sourceByteStart,
    source_byte_end: meta.sourceByteEnd,
    source_line_sha256: sha256(line),
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
    local_date: meta.localDate,
    role,
    text: cleaned,
    redactions: redacted.redactions,
  };
}

function lineSegments(text) {
  const segments = [];
  let start = 0;
  let lineNo = 1;
  const re = /.*(?:\n|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw === '') break;
    const end = start + Buffer.byteLength(raw, 'utf8');
    const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    if (line) segments.push({ line, raw, lineNo, start, end });
    start = end;
    lineNo++;
  }
  return segments;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  assertNotSymlink(file, 'conversation cursor');
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function appendRecordsByDate({ vaultReal, destRoot, providerSafe, sourceSafe, records, dryRun }) {
  const written = new Set();
  if (dryRun || records.length === 0) return written;
  for (const record of records) {
    const date = record.local_date || 'unknown-date';
    const deltaPath = path.join(destRoot, 'deltas', `${date}.jsonl`);
    const deltaRel = relUnix(vaultReal, deltaPath);
    if (!deltaRel.startsWith(`.alfred/private/conversations/${providerSafe}/${sourceSafe}/deltas/`)) {
      throw new Error(`delta destination is outside private conversations: ${deltaRel}`);
    }
    fs.mkdirSync(path.dirname(deltaPath), { recursive: true, mode: 0o700 });
    assertNotSymlink(deltaPath, 'conversation delta file');
    fs.appendFileSync(deltaPath, JSON.stringify(record) + '\n', { mode: 0o600 });
    written.add(deltaRel);
  }
  return written;
}

function extractClaudeJsonlDeltas({ vaultReal, scan, providerSafe, sourceSafe, destRoot, dryRun, timeZone }) {
  const cursorRel = `.alfred/private/conversations/${providerSafe}/${sourceSafe}/cursor/claude-jsonl.json`;
  const cursorPath = path.join(vaultReal, cursorRel);
  const cursor = readJsonFile(cursorPath, { schema_version: 1, extractor: 'claude-jsonl', files: {} });
  if (!cursor.files || typeof cursor.files !== 'object') cursor.files = {};

  const allRecords = [];
  const nextFiles = { ...cursor.files };

  for (const file of scan.files.filter((p) => path.extname(p) === '.jsonl')) {
    const sourceRel = relUnix(scan.sourceReal, file);
    const sourceText = fs.readFileSync(file, 'utf8');
    const sourceBytes = Buffer.byteLength(sourceText, 'utf8');
    const prev = cursor.files[sourceRel] || {};
    const segments = lineSegments(sourceText);
    let processedLines = Number.isInteger(prev.processed_lines) ? prev.processed_lines : 0;
    if (processedLines > segments.length) processedLines = 0;
    if (processedLines > 0 && prev.processed_prefix_sha256) {
      const prefix = segments.slice(0, processedLines).map((seg) => seg.raw).join('');
      if (sha256(prefix) !== prev.processed_prefix_sha256) processedLines = 0;
    }
    const newSegments = segments.filter((seg) => seg.lineNo > processedLines);
    const records = [];
    for (const seg of newSegments) {
      let timestamp = null;
      try {
        const parsed = JSON.parse(seg.line);
        if (typeof parsed.timestamp === 'string') timestamp = parsed.timestamp;
      } catch {
        /* handled by extractor below */
      }
      const date = timestamp ? new Date(timestamp) : null;
      const localDate = date && Number.isFinite(date.getTime())
        ? formatDateInTimeZone(date, timeZone)
        : formatDateInTimeZone(new Date(), timeZone);
      const extracted = extractClaudeJsonlMessage(seg.line, {
        provider: providerSafe,
        sourceName: sourceSafe,
        sourceRel,
        sourceLine: seg.lineNo,
        sourceByteStart: seg.start,
        sourceByteEnd: seg.end,
        localDate,
      });
      if (extracted) records.push(extracted);
    }
    allRecords.push(...records);

    const processedText = segments.map((seg) => seg.raw).join('');
    nextFiles[sourceRel] = {
      source_bytes: sourceBytes,
      processed_bytes: sourceBytes,
      processed_lines: segments.length,
      processed_prefix_sha256: sha256(processedText),
      updated_at: new Date().toISOString(),
    };
  }

  const written = appendRecordsByDate({
    vaultReal,
    destRoot,
    providerSafe,
    sourceSafe,
    records: allRecords,
    dryRun,
  });

  if (!dryRun) {
    cursor.files = nextFiles;
    cursor.updated_at = new Date().toISOString();
    writeJsonFile(cursorPath, cursor);
  }

  return {
    extractor: 'claude-jsonl',
    deltaRecords: allRecords.length,
    deltaFiles: Array.from(written).sort(),
    cursorRel,
  };
}

function importConversationFiles(opts = {}) {
  const {
    vaultRoot,
    sourceDir,
    provider = 'nanoclaw',
    sourceName,
    extensions,
    excludeDirs,
    extract,
    timeZone = process.env.TZ || 'UTC',
    dryRun = false,
    now = () => new Date().toISOString(),
  } = opts;

  if (!vaultRoot) throw new Error('vaultRoot is required');
  if (!sourceDir) throw new Error('--source is required');
  if (extract && !SUPPORTED_EXTRACTORS.has(extract)) throw new Error(`unsupported extractor: ${extract}`);
  if (!fs.existsSync(sourceDir)) throw new Error(`source directory does not exist: ${sourceDir}`);
  if (!fs.statSync(sourceDir).isDirectory()) throw new Error(`source is not a directory: ${sourceDir}`);

  const vaultReal = fs.realpathSync(path.resolve(vaultRoot));
  const root = ensurePrivateConversationRoot(vaultReal);
  assertGitIgnored(vaultReal, '.alfred/private/conversations/probe');

  const scan = listConversationFiles(sourceDir, extensions || DEFAULT_EXTENSIONS, excludeDirs || []);
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

  let extraction = null;
  if (extract === 'claude-jsonl') {
    extraction = extractClaudeJsonlDeltas({
      vaultReal,
      scan,
      providerSafe,
      sourceSafe,
      destRoot,
      dryRun,
      timeZone,
    });
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
    skippedDirs: scan.skippedDirs,
    extraction,
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
  extractClaudeJsonlMessage,
  parseExtensions,
  parseCsv,
};
