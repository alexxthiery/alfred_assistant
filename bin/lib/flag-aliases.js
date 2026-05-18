// flag-aliases.js — pure helper for the CLI flag-rename / removal policy.
//
// Exports: applyFlagAliases(verb, args, aliases) -> { warnings, errors }
//
// The map shape is `{ <verb>: { <old-flag>: '<new-flag>' | null } }`.
// - string value: rename. The old flag is deprecated; warn and rewrite to the new key.
// - null value:   removed. The old flag has no replacement; record an error.
//
// Per CONTRIBUTING.md "flag-rename policy" (vX.Y warns; vX.(Y+1) errors).
//
// No fs, no process, no other globals. Safe to require() from unit tests.

'use strict';

function applyFlagAliases(verb, args, aliases) {
  const warnings = [];
  const errors = [];
  const map = (aliases && aliases[verb]) || null;
  if (!map) return { warnings, errors };
  for (const oldName of Object.keys(map)) {
    if (!Object.prototype.hasOwnProperty.call(args, oldName)) continue;
    const newName = map[oldName];
    if (newName === null) {
      errors.push(`--${oldName} has been removed (no replacement)`);
      continue;
    }
    if (typeof newName === 'string') {
      // If the user passed both old and new, the new one wins — just warn
      // about the old. Otherwise rewrite old -> new.
      if (!Object.prototype.hasOwnProperty.call(args, newName)) {
        args[newName] = args[oldName];
      }
      delete args[oldName];
      warnings.push(`--${oldName} is deprecated; use --${newName} instead`);
    }
  }
  return { warnings, errors };
}

module.exports = { applyFlagAliases };
