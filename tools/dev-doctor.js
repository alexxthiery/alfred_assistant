#!/usr/bin/env node
// Local development safety checks.
//
// This is intentionally local: it verifies machine setup that git/CI cannot
// enforce, especially the git hooks and gitignored PII pattern list.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fileExecutable(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function hookLooksInstalled(repoRoot, name = 'pre-commit') {
  const hook = path.join(repoRoot, '.git', 'hooks', name);
  const expected = path.join(repoRoot, 'tools', name);
  if (!fs.existsSync(hook)) return false;
  try {
    if (fs.realpathSync(hook) === fs.realpathSync(expected)) return true;
  } catch {
    /* fall through to content check */
  }
  try {
    return fs.readFileSync(hook, 'utf8').includes(`tools/${name}`);
  } catch {
    return false;
  }
}

function nonEmptyFile(p) {
  try {
    return fs.statSync(p).isFile() && fs.readFileSync(p, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function inspectRepo(repoRoot) {
  const root = path.resolve(repoRoot || process.cwd());
  const checks = [
    {
      name: 'pre-commit-script',
      ok: fileExecutable(path.join(root, 'tools', 'pre-commit')),
      message: 'tools/pre-commit exists and is executable',
      fix: 'chmod +x tools/pre-commit',
    },
    {
      name: 'pre-commit-hook',
      ok: hookLooksInstalled(root),
      message: '.git/hooks/pre-commit points at tools/pre-commit',
      fix: 'ln -sf ../../tools/pre-commit .git/hooks/pre-commit',
    },
    {
      name: 'pre-push-hook',
      ok: hookLooksInstalled(root, 'pre-push'),
      message: '.git/hooks/pre-push points at tools/pre-push (scans every pushed commit)',
      fix: 'ln -sf ../../tools/pre-push .git/hooks/pre-push',
    },
    {
      name: 'pii-vault-sources',
      ok: nonEmptyFile(path.join(root, 'tools', 'pii-vaults.local.txt')),
      message: 'tools/pii-vaults.local.txt lists the vaults the PII list is rebuilt from',
      fix: 'list one vault path per line in tools/pii-vaults.local.txt, then run tools/build-pii-list.js',
    },
    {
      name: 'pii-local-list',
      ok: nonEmptyFile(path.join(root, 'tools', 'pii-list.local.txt')),
      message: 'tools/pii-list.local.txt exists and is non-empty',
      fix: 'run tools/build-pii-list.js (generates the gitignored list from your vaults)',
    },
    {
      name: 'pii-scanner',
      ok: fileExecutable(path.join(root, 'tools', 'scan-pii.sh')),
      message: 'tools/scan-pii.sh exists and is executable',
      fix: 'chmod +x tools/scan-pii.sh',
    },
  ];
  return { root, checks };
}

function main(argv) {
  const root = argv[0] || process.cwd();
  const result = inspectRepo(root);
  let failed = 0;
  for (const check of result.checks) {
    const tag = check.ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${check.name}: ${check.message}`);
    if (!check.ok) {
      failed++;
      console.log(`       fix: ${check.fix}`);
    }
  }
  if (failed) {
    console.error(`dev-doctor: ${failed} check${failed === 1 ? '' : 's'} failed`);
    return 1;
  }
  console.log('dev-doctor: OK');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { inspectRepo, hookLooksInstalled };
