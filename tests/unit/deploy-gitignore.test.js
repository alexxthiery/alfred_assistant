'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'tools', 'deploy.sh');

function deployGitignoreTemplate() {
  const text = fs.readFileSync(DEPLOY, 'utf8');
  const match = text.match(/cat > "\$TARGET\/\.gitignore" <<'GITIGNORE'\n([\s\S]*?)\nGITIGNORE/);
  if (!match) throw new Error('deploy.sh .gitignore heredoc not found');
  return match[1] + '\n';
}

test('deploy.sh gitignore template ignores vault-private credentials', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gitignore-'));
  const git = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(tmp, '.gitignore'), deployGitignoreTemplate());

  const ignored = git('check-ignore', '.alfred/private/env').trim();
  assert.equal(ignored, '.alfred/private/env');
});

test('deploy.sh gitignore template has no inline comments on active patterns', () => {
  for (const line of deployGitignoreTemplate().split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    assert.equal(line.includes('#'), false, `inline comments break gitignore patterns: ${line}`);
  }
});

test('deploy.sh appends vault-private ignore rule to existing legacy gitignore', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gitignore-existing-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(tmp, '.gitignore'), '.DS_Store\n');

    execFileSync('bash', [
      DEPLOY,
      '--target', tmp,
      '--user-name', 'Test User',
      '--user-slug', 'test-user',
      '--assistant-name', 'TestAssistant',
      '--apply',
    ], { cwd: ROOT, encoding: 'utf8' });

    const ignored = git('check-ignore', '.alfred/private/env').trim();
    assert.equal(ignored, '.alfred/private/env');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
