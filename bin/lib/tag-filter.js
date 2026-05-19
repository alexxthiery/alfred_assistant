// tag-filter.js — parse zk-style boolean tag expressions and compile to SQL.
//
// Grammar (mirrors zk's --tag syntax):
//   expression   := clause (',' clause)*           AND between clauses
//   clause       := 'NOT' WS tag                   exclude this tag (only one tag in a NOT clause)
//                 | tag ('OR' tag)*                OR between tags within a clause
//   tag          := slug (matches /^[a-z0-9][a-z0-9-]*$/)
//
// Examples:
//   "research"                 →  AND list_contains(tags,'research')
//   "research OR life"         →  AND (list_contains(tags,'research') OR list_contains(tags,'life'))
//   "research, NOT done"       →  AND list_contains(tags,'research') AND NOT list_contains(tags,'done')
//   "inbox OR todo, NOT done"  →  AND (list_contains(tags,'inbox') OR list_contains(tags,'todo')) AND NOT list_contains(tags,'done')
//
// Pure module: no fs, no spawn. Throws on invalid input so callers can catch
// and emit a structured CLI error.

'use strict';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseTagExpression(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new Error('tag expression must be a non-empty string');
  }
  const clauses = expr.split(',').map((c) => c.trim()).filter(Boolean);
  if (clauses.length === 0) throw new Error('tag expression has no clauses');
  const ast = [];
  for (const raw of clauses) {
    // Match NOT clause: "NOT <tag>" (case-insensitive). NOT applies to one
    // tag; for "NOT a OR b" we'd need parens — keep it simple, refuse mixed.
    const notMatch = /^NOT\s+(.+)$/i.exec(raw);
    if (notMatch) {
      const inner = notMatch[1].trim();
      if (/\bOR\b/i.test(inner)) {
        throw new Error(`tag clause "${raw}": NOT does not combine with OR; use separate clauses`);
      }
      if (!SLUG_RE.test(inner)) {
        throw new Error(`tag "${inner}" must match /^[a-z0-9][a-z0-9-]*$/`);
      }
      ast.push({ negate: true, tags: [inner] });
      continue;
    }
    // OR clause: split on whitespace-bounded OR.
    const tags = raw.split(/\s+OR\s+/i).map((t) => t.trim()).filter(Boolean);
    for (const t of tags) {
      if (!SLUG_RE.test(t)) {
        throw new Error(`tag "${t}" must match /^[a-z0-9][a-z0-9-]*$/`);
      }
    }
    ast.push({ negate: false, tags });
  }
  return ast;
}

// Compile an AST to a SQL fragment AND-prepended (so the caller can splice
// it directly into a WHERE clause that already has at least one predicate,
// e.g. `WHERE ... IS NOT NULL${tagClause}`). Returns '' for empty AST.
function compileTagExpressionToSql(astOrExpr, columnExpr = 'v.tags') {
  if (!astOrExpr) return '';
  const ast = typeof astOrExpr === 'string' ? parseTagExpression(astOrExpr) : astOrExpr;
  if (!ast.length) return '';
  const parts = [];
  for (const clause of ast) {
    const tagPreds = clause.tags.map((t) => `list_contains(${columnExpr}, '${t}')`);
    const inner = tagPreds.length === 1 ? tagPreds[0] : `(${tagPreds.join(' OR ')})`;
    parts.push(clause.negate ? `NOT ${inner}` : inner);
  }
  return ' AND ' + parts.join(' AND ');
}

module.exports = {
  parseTagExpression,
  compileTagExpressionToSql,
};
