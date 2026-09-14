// persona-template.js — deterministic assembly for the runtime persona source.
//
// The deployed runtime receives one AGENTS.md. These fragments make the source
// editable in small chunks; render-persona.sh assembles them deterministically,
// substitutes vault identity from .alfred.yml, and may append vault-local
// fragments from persona/agents.d/.

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
  '60-voice.template.md',
  '90-reference.template.md',
]);

const GENERATED_HEADER = [
  '<!--',
  'GENERATED FILE - do not edit AGENTS.md directly.',
  'Source: alfred_assistant docs/persona/*.template.md, .alfred.yml, and optional persona/agents.d/*.md.',
  'Regenerate with: tools/render-persona.sh --vault <vault> --apply',
  '-->',
  '',
].join('\n');

function personaFragmentsDir(repoRoot) {
  return path.join(repoRoot, 'docs', 'persona');
}

function personaTemplatePath(repoRoot) {
  return path.join(repoRoot, 'docs', 'PERSONA.template.md');
}

function personaLocalFragmentsDir(vaultRoot) {
  return path.join(vaultRoot, 'persona', 'agents.d');
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

function findUnresolvedPlaceholders(text) {
  const found = new Set();
  const re = /\{\{([A-Z0-9_]+)\}\}/g;
  let m;
  while ((m = re.exec(String(text))) !== null) found.add(`{{${m[1]}}}`);
  return [...found].sort();
}

function loadPersonaTemplate(repoRoot) {
  const dir = personaFragmentsDir(repoRoot);
  const fragments = PERSONA_FRAGMENT_FILES.map((file) => {
    return fs.readFileSync(path.join(dir, file), 'utf-8');
  });
  return assemblePersonaFragments(fragments);
}

function loadLocalPersonaFragments(vaultRoot) {
  const dir = personaLocalFragmentsDir(vaultRoot);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.md') && !file.startsWith('.'))
    .sort();
  return files.map((file) => ({
    file,
    path: path.join(dir, file),
    content: fs.readFileSync(path.join(dir, file), 'utf-8'),
  }));
}

function appendLocalPersonaFragments(rendered, localFragments) {
  if (!localFragments.length) return rendered;
  const chunks = [
    rendered.replace(/\s*$/, '\n\n'),
    '---\n',
    '## Local Persona Overlays\n\n',
    'Vault-local fragments below come from `persona/agents.d/*.md`, sorted by filename. ',
    'They are part of the generated runtime persona and should contain only durable, vault-specific policy.\n',
  ];
  for (const fragment of localFragments) {
    chunks.push(`\n<!-- Local persona fragment: persona/agents.d/${fragment.file} -->\n`);
    chunks.push(fragment.content.replace(/\s*$/, '\n'));
  }
  return chunks.join('');
}

function renderPersonaDocument({ template, replacements, localFragments = [], generatedHeader = true }) {
  let rendered = renderPersonaTemplate(template, replacements);
  rendered = appendLocalPersonaFragments(rendered, localFragments);
  const unresolved = findUnresolvedPlaceholders(rendered);
  if (unresolved.length) {
    throw new Error(`unresolved persona placeholder(s): ${unresolved.join(', ')}`);
  }
  return (generatedHeader ? GENERATED_HEADER : '') + rendered;
}

module.exports = {
  PERSONA_FRAGMENT_FILES,
  GENERATED_HEADER,
  personaFragmentsDir,
  personaTemplatePath,
  personaLocalFragmentsDir,
  assemblePersonaFragments,
  stripLeadingInstructionComment,
  renderPersonaTemplate,
  findUnresolvedPlaceholders,
  loadPersonaTemplate,
  loadLocalPersonaFragments,
  appendLocalPersonaFragments,
  renderPersonaDocument,
};
