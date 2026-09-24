// Unit tests for tools/build-pii-list.js and tools/scan-pii.js.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const TOOLS = path.resolve(__dirname, '..', '..', 'tools');
const { buildList } = require(path.join(TOOLS, 'build-pii-list.js'));
const { loadMatchers, scanItems, rangeItems } = require(path.join(TOOLS, 'scan-pii.js'));

function tmpdir(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeVault(t) {
  const v = tmpdir(t, 'pii-vault-');
  fs.mkdirSync(path.join(v, 'wiki'));
  fs.mkdirSync(path.join(v, '.alfred', 'private'), { recursive: true });
  const page = (slug, fm, body = '') =>
    fs.writeFileSync(path.join(v, 'wiki', `${slug}.md`), `---\n${fm}\n---\n${body}\n`);
  page('jane-doe', 'title: Jane Doe\ntags: [person]\naliases: [Janey, JD]', 'mail jane@realmail.net or x@example.com, +65 9123 4567');
  page('acme-labs', 'title: Acme Labs\ntags: [org]');
  page('cursor', 'title: Cursor\ntags: [org]');
  page('reading', 'title: Reading List\ntags: [topic]');
  fs.writeFileSync(path.join(v, '.alfred', 'private', 'env'),
    'TELEGRAM_BOT_TOKEN=123456789:AAabcdefghijklmnop\nTELEGRAM_CHAT_ID=987654321\nSMTP_TO=owner@realmail.net\nTZ=Asia/Singapore\n');
  fs.writeFileSync(path.join(v, '.alfred', 'private', 'git-credentials'),
    'https://someone:gho_supersecretvalue123@github.com\n');
  return v;
}

function listSet(lines) {
  return new Set(lines);
}

test('buildList: entity labels, slugs, contacts, and private values', (t) => {
  const v = makeVault(t);
  const got = listSet(buildList({ vaults: [v] }));
  for (const want of [
    'NAME\tJane Doe', 'NAME\tJaney', 'SLUG\tjane-doe', 'ORG\tAcme Labs', 'SLUG\tacme-labs',
    'EMAIL\tjane@realmail.net', 'EMAIL\towner@realmail.net', 'PHONE\t+65 9123 4567',
    'SECRET\t123456789:AAabcdefghijklmnop', 'SECRET\tgho_supersecretvalue123',
    'CHATID\t987654321', `PATH\t${path.basename(v)}`,
  ]) assert.ok(got.has(want), `missing ${want}`);
});

test('buildList: skips placeholders, short labels, non-entities, single-word slugs', (t) => {
  const v = makeVault(t);
  const got = [...buildList({ vaults: [v] })].join('\n');
  assert.ok(!got.includes('example.com'));
  assert.ok(!got.includes('\tJD\n') && !got.endsWith('\tJD'), 'labels under 4 chars are too generic');
  assert.ok(!got.includes('Reading List'), 'topic pages are not entities');
  assert.ok(!got.includes('Asia/Singapore'));
});

test('buildList: allow list drops public names; extra lines merge and dedupe', (t) => {
  const v = makeVault(t);
  const got = buildList({
    vaults: [v],
    allowLines: ['cursor'],
    extraLines: ['NAME\tOld Friend', 'NAME\tjane doe'],
  });
  assert.ok(!got.includes('ORG\tCursor'));
  assert.ok(got.includes('NAME\tOld Friend'));
  assert.equal(got.filter((l) => l.toLowerCase() === 'name\tjane doe').length, 1);
});

function matchersFor(t, lines) {
  const f = path.join(tmpdir(t, 'pii-list-'), 'list.txt');
  fs.writeFileSync(f, `# header\n${lines.join('\n')}\n`);
  return loadMatchers(f);
}

const item = (file, ...texts) => ({ where: file, file, lines: texts.map((text, i) => ({ n: i + 1, text })) });

test('scanItems: word-boundary names, substring secrets, safe output', (t) => {
  const m = matchersFor(t, ['NAME\tJane Doe', 'CHATID\t987654321']);
  const hits = scanItems([item('src/a.ts', 'ping Jane Doe now', 'Jane Doesmith is fine', "id: 'telegram:987654321:1464'")], m);
  assert.deepEqual(hits, ['src/a.ts:1 [NAME] HIT', 'src/a.ts:3 [CHATID] HIT']);
  assert.ok(!hits.join('').includes('987654321'), 'matched text must never be printed');
});

test('scanItems: list patterns apply inside tests/, generic secret shapes do not', (t) => {
  const m = matchersFor(t, ['CHATID\t987654321']);
  const key = 'k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"';
  assert.deepEqual(scanItems([item('tests/unit/x.test.js', key)], m), []);
  assert.deepEqual(scanItems([item('src/poll-loop.test.ts', key)], m), []);
  assert.deepEqual(scanItems([item('tests/unit/x.test.js', 'telegram:987654321')], m), ['tests/unit/x.test.js:1 [CHATID] HIT']);
  const hits = scanItems([item('bin/lib/x.js', key)], m);
  assert.ok(hits.includes('bin/lib/x.js:1 [SECRET-SHAPE:anthropic-key] HIT'));
});

test('scanItems: telegram bot token shape and root LICENSE exemption', (t) => {
  const m = matchersFor(t, ['NAME\tJane Doe']);
  assert.deepEqual(scanItems([item('docs/x.md', 'TOKEN=1234567890:AAabcdefghijklmnopqrstuvwxyz0123456')], m),
    ['docs/x.md:1 [SECRET-SHAPE:telegram-bot-token] HIT']);
  assert.deepEqual(scanItems([item('LICENSE', 'Copyright Jane Doe')], m), []);
  assert.deepEqual(scanItems([item('docs/LICENSE', 'Copyright Jane Doe')], m), ['docs/LICENSE:1 [NAME] HIT']);
});

test('rangeItems: scans added lines with real line numbers and commit messages', (t) => {
  const repo = tmpdir(t, 'pii-repo-');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: repo });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').toString().trim();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree Jane Doe\n');
  git('commit', '-qam', 'mention Jane Doe');
  const m = matchersFor(t, ['NAME\tJane Doe']);
  const hits = scanItems(rangeItems([`${base}..HEAD`], repo), m).map((h) => h.replace(/^[0-9a-f]{8}/, 'C'));
  assert.deepEqual(hits.sort(), ['C:<message>:1 [NAME] HIT', 'C:a.txt:3 [NAME] HIT']);
});
