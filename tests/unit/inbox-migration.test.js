'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyInboxSourceMigration, planInboxSourceMigration } = require('../../bin/lib/inbox-migration.js');

function tempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-migration-'));
  fs.mkdirSync(path.join(root, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(root, 'inbox', 'post_agi_transcripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
  return root;
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('planInboxSourceMigration finds referenced nested inbox sources only', () => {
  const root = tempVault();
  try {
    write(root, 'inbox/post_agi_transcripts/used.md', 'used source');
    write(root, 'inbox/post_agi_transcripts/unused.md', 'unused source');
    write(root, 'wiki/index.md', '- [[card]] — Card: - [claim] x ^[inbox/post_agi_transcripts/used.md]\n');
    write(root, 'wiki/log.md', '- write card inbox/post_agi_transcripts/used.md\n');
    write(root, 'wiki/card.md', [
      '---',
      'id: card',
      'title: Card',
      'type: concept',
      'tags: [idea]',
      '---',
      '- [claim] x ^[inbox/post_agi_transcripts/used.md]',
      'raw_path: inbox/post_agi_transcripts/used.md',
      '',
    ].join('\n'));

    const plan = planInboxSourceMigration({ vaultRoot: root, prefix: 'inbox/post_agi_transcripts', kind: 'transcripts' });

    assert.deepEqual(plan.candidates.map((m) => [m.oldRel, m.newRel, m.occurrenceCount]), [
      ['inbox/post_agi_transcripts/used.md', 'raw/transcripts/post_agi_transcripts/used.md', 2],
    ]);
    assert.deepEqual(plan.unreferenced.map((m) => m.oldRel), ['inbox/post_agi_transcripts/unused.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyInboxSourceMigration moves files and rewrites wiki references', () => {
  const root = tempVault();
  try {
    write(root, 'inbox/post_agi_transcripts/used.md', 'used source');
    write(root, 'inbox/post_agi_transcripts/unused.md', 'unused source');
    write(root, 'wiki/card.md', '- [claim] x ^[inbox/post_agi_transcripts/used.md]\n');

    const result = applyInboxSourceMigration({ vaultRoot: root, prefix: 'inbox/post_agi_transcripts', kind: 'transcripts' });

    assert.equal(result.migrated, 1);
    assert.equal(result.rewriteCount, 1);
    assert.equal(fs.existsSync(path.join(root, 'inbox/post_agi_transcripts/used.md')), false);
    assert.equal(read(root, 'raw/transcripts/post_agi_transcripts/used.md'), 'used source');
    assert.equal(fs.existsSync(path.join(root, 'inbox/post_agi_transcripts/unused.md')), true);
    assert.match(read(root, 'wiki/card.md'), /\^\[raw\/transcripts\/post_agi_transcripts\/used\.md\]/);
    assert.doesNotMatch(read(root, 'wiki/card.md'), /inbox\/post_agi_transcripts\/used\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applyInboxSourceMigration blocks on destination collision without mutation', () => {
  const root = tempVault();
  try {
    write(root, 'inbox/post_agi_transcripts/used.md', 'used source');
    write(root, 'raw/transcripts/post_agi_transcripts/used.md', 'existing raw source');
    write(root, 'wiki/card.md', '- [claim] x ^[inbox/post_agi_transcripts/used.md]\n');

    assert.throws(
      () => applyInboxSourceMigration({ vaultRoot: root, prefix: 'inbox/post_agi_transcripts', kind: 'transcripts' }),
      /blocked/,
    );
    assert.equal(read(root, 'inbox/post_agi_transcripts/used.md'), 'used source');
    assert.equal(read(root, 'raw/transcripts/post_agi_transcripts/used.md'), 'existing raw source');
    assert.match(read(root, 'wiki/card.md'), /inbox\/post_agi_transcripts\/used\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
