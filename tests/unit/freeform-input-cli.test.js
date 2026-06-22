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

test('write --file preserves literal dollar amounts', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-freeform-'));
  try {
    cpDir(TEMPLATE, v);
    const bodyPath = path.join(v, 'body.md');
    fs.writeFileSync(bodyPath, '- [claim] Pod AUM ~$400M confirmed. ^[telegram:2026-06-22]\n');
    const r = wiki(v, ['write', 'money-write', '--title', 'Money write', '--type', 'concept', '--tags', 'meta', '--file', bodyPath, '--soft']);
    assert.equal(r.status, 0, `write should succeed: ${r.stderr}`);
    assert.match(readPage(v, 'money-write').body, /~\$400M/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('predict --file preserves literal dollar amounts', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-freeform-'));
  try {
    cpDir(TEMPLATE, v);
    const bodyPath = path.join(v, 'prediction.txt');
    fs.writeFileSync(bodyPath, 'P72 will allocate ~$400M');
    const r = wiki(v, ['predict', 'alice', '--file', bodyPath, '--by', '2027-06']);
    assert.equal(r.status, 0, `predict should succeed: ${r.stderr}`);
    assert.match(readPage(v, 'alice').body, /~\$400M/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('hypothesize --stdin preserves literal dollar amounts', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-freeform-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['hypothesize', 'alice', '--stdin'], {
      input: 'Budget could stay near ~$400M',
    });
    assert.equal(r.status, 0, `hypothesize should succeed: ${r.stderr}`);
    assert.match(readPage(v, 'alice').body, /~\$400M/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});

test('capture --stdin preserves literal dollar amounts', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-freeform-'));
  try {
    cpDir(TEMPLATE, v);
    const r = wiki(v, ['capture', 'alice', '--stdin'], {
      input: 'Budget is still around ~$400M',
    });
    assert.equal(r.status, 0, `capture should succeed: ${r.stderr}`);
    assert.match(readPage(v, 'alice').body, /~\$400M/);
  } finally {
    fs.rmSync(v, { recursive: true, force: true });
  }
});
