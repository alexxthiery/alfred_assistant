// Unit tests for bin/lib/tag-filter.js — boolean tag expression parser
// and SQL compiler.
//
// Grammar:
//   "X"                         single tag
//   "X OR Y"                    OR within a clause
//   "X, NOT Y"                  AND between clauses; NOT excludes
//   "inbox OR todo, NOT done"   mixed

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseTagExpression, compileTagExpressionToSql, matchesTagExpression } = require(
  path.resolve(__dirname, '..', '..', 'bin', 'lib', 'tag-filter.js')
);

test('single tag → one positive clause', () => {
  const ast = parseTagExpression('research');
  assert.deepEqual(ast, [{ negate: false, tags: ['research'] }]);
});

test('OR within clause → multiple tags in one clause', () => {
  const ast = parseTagExpression('research OR life');
  assert.deepEqual(ast, [{ negate: false, tags: ['research', 'life'] }]);
});

test('comma → AND between clauses', () => {
  const ast = parseTagExpression('research, life');
  assert.deepEqual(ast, [
    { negate: false, tags: ['research'] },
    { negate: false, tags: ['life'] },
  ]);
});

test('NOT clause → negated single tag', () => {
  const ast = parseTagExpression('NOT done');
  assert.deepEqual(ast, [{ negate: true, tags: ['done'] }]);
});

test('mixed: OR within first clause + NOT in second', () => {
  const ast = parseTagExpression('inbox OR todo, NOT done');
  assert.deepEqual(ast, [
    { negate: false, tags: ['inbox', 'todo'] },
    { negate: true, tags: ['done'] },
  ]);
});

test('case-insensitive OR / NOT keywords (tags themselves stay lowercase-only)', () => {
  // OR / NOT match case-insensitively...
  assert.deepEqual(
    parseTagExpression('a or b'),
    [{ negate: false, tags: ['a', 'b'] }]
  );
  assert.deepEqual(
    parseTagExpression('not done'),
    [{ negate: true, tags: ['done'] }]
  );
  // ...but tag identifiers must satisfy SLUG_RE (lowercase). No coercion.
  assert.throws(() => parseTagExpression('A OR B'), /must match/);
});

test('whitespace tolerant', () => {
  const ast = parseTagExpression('  research  OR   life  ,  NOT done  ');
  assert.deepEqual(ast, [
    { negate: false, tags: ['research', 'life'] },
    { negate: true, tags: ['done'] },
  ]);
});

test('rejects empty string', () => {
  assert.throws(() => parseTagExpression(''), /non-empty/);
  assert.throws(() => parseTagExpression('   '), /non-empty/);
});

test('rejects non-string', () => {
  assert.throws(() => parseTagExpression(null), /non-empty/);
  assert.throws(() => parseTagExpression(123), /non-empty/);
});

test('rejects invalid slug shape', () => {
  assert.throws(() => parseTagExpression('Has Space'), /must match/);
  assert.throws(() => parseTagExpression('UPPER'), /must match/);
  assert.throws(() => parseTagExpression('-leading-dash'), /must match/);
});

test('rejects NOT combined with OR (ambiguous)', () => {
  assert.throws(() => parseTagExpression('NOT a OR b'), /does not combine/);
});

test('compile: single tag → AND list_contains predicate', () => {
  const sql = compileTagExpressionToSql('research', 'v.tags');
  assert.equal(sql, " AND list_contains(v.tags, 'research')");
});

test('compile: OR clause → parenthesised OR', () => {
  const sql = compileTagExpressionToSql('research OR life', 'v.tags');
  assert.equal(sql, " AND (list_contains(v.tags, 'research') OR list_contains(v.tags, 'life'))");
});

test('compile: NOT clause → NOT prefix', () => {
  const sql = compileTagExpressionToSql('NOT done', 'v.tags');
  assert.equal(sql, " AND NOT list_contains(v.tags, 'done')");
});

test('compile: mixed expression', () => {
  const sql = compileTagExpressionToSql('inbox OR todo, NOT done', 'v.tags');
  assert.equal(
    sql,
    " AND (list_contains(v.tags, 'inbox') OR list_contains(v.tags, 'todo')) AND NOT list_contains(v.tags, 'done')"
  );
});

test('compile: empty input → empty string', () => {
  assert.equal(compileTagExpressionToSql('', 'v.tags'), '');
  assert.equal(compileTagExpressionToSql(null, 'v.tags'), '');
});

test('compile: custom column expression', () => {
  const sql = compileTagExpressionToSql('research', 'pages.tag_array');
  assert.equal(sql, " AND list_contains(pages.tag_array, 'research')");
});

test('compile: accepts pre-parsed AST', () => {
  const ast = [{ negate: false, tags: ['research'] }];
  const sql = compileTagExpressionToSql(ast, 'v.tags');
  assert.equal(sql, " AND list_contains(v.tags, 'research')");
});

test('matchesTagExpression mirrors OR, comma-AND, and NOT semantics', () => {
  assert.equal(matchesTagExpression(['research'], 'research OR health'), true);
  assert.equal(matchesTagExpression(['health'], 'research OR health'), true);
  assert.equal(matchesTagExpression(['meta'], 'research OR health'), false);
  assert.equal(matchesTagExpression(['research', 'tool'], 'research, NOT tool'), false);
  assert.equal(matchesTagExpression(['research', 'meta'], 'research, NOT tool'), true);
});
