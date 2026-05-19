// inverse-closure.js — compute missing inverse/symmetric relations.
//
// Pure module: takes parsed data in, returns plan-of-edits out. The caller
// is responsible for the fs writes. Same logic that `wiki groom --mechanical`
// uses, but parameterised so it can also run inside `wiki ingest` scoped to
// the freshly-touched slugs (no whole-vault scan on every ingest).
//
// Verbs are classified two ways by the schema (see bin/lib/schema.js):
//   - symmetric: A→B implies B→A with the SAME verb (sibling_of, spouse_of)
//   - inverses:  A→B with verb V implies B→A with the inverse verb V'
//                (parent_of ↔ child_of, member_of ↔ has_member)
//
// computeMissingInverses iterates the source edges of `fromSlugs` (or all
// slugs in pageRelations if `fromSlugs === null`). For each (verb, target)
// edge, it looks up the inverse verb and checks whether target's relations
// already include (inverseVerb, fromSlug). If not, that's a missing inverse.
//
// Returns: Array<{ fromSlug, verb, target, neededVerb }>.

'use strict';

function computeMissingInverses({ pageRelations, slugSet, schema, fromSlugs = null }) {
  if (!(pageRelations instanceof Map)) throw new Error('pageRelations must be a Map<slug, [{verb, target}]>');
  if (!(slugSet instanceof Set)) throw new Error('slugSet must be a Set<slug>');
  if (!schema || !(schema.symmetric instanceof Set) || !(schema.inverses instanceof Map)) {
    throw new Error('schema must expose .symmetric:Set and .inverses:Map');
  }
  const fromFilter = fromSlugs ? new Set(fromSlugs) : null;
  const missing = [];
  for (const [fromSlug, rels] of pageRelations.entries()) {
    if (fromFilter && !fromFilter.has(fromSlug)) continue;
    for (const { verb, target } of rels) {
      if (!slugSet.has(target)) continue; // target is a stub or missing; skip
      let neededVerb = null;
      if (schema.symmetric.has(verb)) neededVerb = verb;
      else if (schema.inverses.has(verb)) neededVerb = schema.inverses.get(verb);
      if (!neededVerb) continue;
      const targetRels = pageRelations.get(target) || [];
      const exists = targetRels.some((r) => r.verb === neededVerb && r.target === fromSlug);
      if (!exists) missing.push({ fromSlug, verb, target, neededVerb });
    }
  }
  return missing;
}

// Group a flat missing-list into per-target additions, suitable for one write
// per target page (each target gets a list of `- <verb> [[<slug>]]` lines).
function groupByTarget(missing) {
  const byTarget = new Map(); // target -> Array<{verb, fromSlug}>
  for (const m of missing) {
    if (!byTarget.has(m.target)) byTarget.set(m.target, []);
    byTarget.get(m.target).push({ verb: m.neededVerb, fromSlug: m.fromSlug });
  }
  return byTarget;
}

module.exports = {
  computeMissingInverses,
  groupByTarget,
};
