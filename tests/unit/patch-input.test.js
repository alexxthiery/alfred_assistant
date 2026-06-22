'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseFrontmatter } = require('../../bin/lib/frontmatter.js');

const REPO = path.resolve(__dirname, '..', '..');
const WIKI = path.join(REPO, 'bin', 'wiki');
const TEMPLATE = path.join(REPO, 'tests', 'vault');

function cpDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function wiki(cwd, args, opts = {}) {
  const env = { ...process.env, WIKI_ROOT: cwd, WIKI_NO_AUTO_COMMIT: '1' };
  return spawnSync('node', [WIKI, ...args], {
    cwd,
    env,
    input: opts.input,
    encoding: 'utf-8',
  });
}

function readPage(cwd, slug) {
  return parseFrontmatter(fs.readFileSync(path.join(cwd, 'wiki', `${slug}.md`), 'utf-8'));
}

test('patch --observation-stdin preserves literal dollar amounts', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-patch-input-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['patch', 'alice', '--observation-stdin'], {
      input: '[claim] Pod AUM ~$400M confirmed. ^[telegram:2026-06-22]\n',
    });
    assert.equal(r.status, 0, `patch should succeed: ${r.stderr}`);
    assert.match(readPage(v, 'alice').body, /~\$400M/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('patch --summary-file preserves literal dollar amounts', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-patch-input-'));
  try {
    cpDir(TEMPLATE, v);
    const summaryPath = path.join(v, 'summary.txt');
    fs.writeFileSync(summaryPath, 'Budget still roughly ~$400M\n');
    const r = wiki(v, ['patch', 'alice', '--summary-file', summaryPath]);
    assert.equal(r.status, 0, `patch should succeed: ${r.stderr}`);
    assert.equal(readPage(v, 'alice').fm.summary, 'Budget still roughly ~$400M');
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('patch rejects conflicting sources for one field', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-patch-input-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['patch', 'alice', '--observation', '[fact] inline ^[t:1]', '--observation-stdin'], {
      input: '[fact] stdin ^[t:2]\n',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /choose exactly one of --observation, --observation-file, --observation-stdin/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('patch rejects multiple stdin consumers in one invocation', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-patch-input-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['patch', 'alice', '--observation-stdin', '--summary-stdin'], {
      input: '[fact] stdin ^[t:1]\n',
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /only one patch field can read from stdin/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});
