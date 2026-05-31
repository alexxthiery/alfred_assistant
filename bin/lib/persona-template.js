// persona-template.js — deterministic assembly for the runtime persona source.
//
// The deployed runtime still receives one AGENTS.md. These fragments only make
// the repo source easier to maintain; they are concatenated byte-for-byte into
// docs/PERSONA.template.md and then rendered by tools/render-persona.sh.

'use strict';

const fs = require('fs');
const path = require('path');

const PERSONA_FRAGMENT_FILES = Object.freeze([
  '00-preamble.template.md',
  '10-ontology.template.md',
  '20-operating-loop.template.md',
  '30-ingestion.template.md',
  '40-workflows.template.md',
  '50-companion.template.md',
  '90-reference.template.md',
]);

function personaFragmentsDir(repoRoot) {
  return path.join(repoRoot, 'docs', 'persona');
}

function personaTemplatePath(repoRoot) {
  return path.join(repoRoot, 'docs', 'PERSONA.template.md');
}

function assemblePersonaFragments(fragments) {
  if (!Array.isArray(fragments)) throw new TypeError('fragments must be an array');
  return fragments.map((s) => String(s)).join('');
}

function stripLeadingInstructionComment(template) {
  const lines = String(template).split('\n');
  if (lines[0] !== '<!--') return String(template);
  const end = lines.indexOf('-->', 1);
  if (end < 0) return String(template);
  return lines.slice(end + 1).join('\n');
}

function renderPersonaTemplate(template, replacements) {
  let out = stripLeadingInstructionComment(template);
  for (const [key, value] of Object.entries(replacements || {})) {
    out = out.split(`{{${key}}}`).join(String(value ?? ''));
  }
  return out;
}

function loadPersonaTemplate(repoRoot) {
  const dir = personaFragmentsDir(repoRoot);
  const fragments = PERSONA_FRAGMENT_FILES.map((file) => {
    return fs.readFileSync(path.join(dir, file), 'utf-8');
  });
  return assemblePersonaFragments(fragments);
}

module.exports = {
  PERSONA_FRAGMENT_FILES,
  personaFragmentsDir,
  personaTemplatePath,
  assemblePersonaFragments,
  stripLeadingInstructionComment,
  renderPersonaTemplate,
  loadPersonaTemplate,
};
