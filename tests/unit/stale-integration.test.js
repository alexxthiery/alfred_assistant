'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const SELF = path.relative(ROOT, __filename);
const REMOVED_BACKEND = String.fromCharCode(98, 105, 114, 100);
const FORBIDDEN = [
  [REMOVED_BACKEND],
  ['twitter', '-read'],
  ['ALFRED_', 'BIRD'],
  [REMOVED_BACKEND, '_bin'],
  ['TWITTER', '.md'],
  ['X/', 'Twitter'],
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (
      rel === '.git' ||
      rel === 'audit' ||
      rel === 'node_modules' ||
      rel.startsWith(`.git${path.sep}`) ||
      rel.startsWith(`audit${path.sep}`) ||
      rel.startsWith(`node_modules${path.sep}`)
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

test('removed social-media integration leaves no hidden config or docs residue', () => {
  const offenders = [];
  for (const rel of walk(ROOT)) {
    if (rel === SELF) continue;
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const parts of FORBIDDEN) {
      const needle = parts.join('');
      if (body.includes(needle)) offenders.push(`${rel}: ${needle}`);
    }
  }
  assert.deepEqual(offenders, []);
});
