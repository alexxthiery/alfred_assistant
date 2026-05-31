#!/usr/bin/env node
// assemble-persona-template.js — print or check the aggregate persona template.

'use strict';

const fs = require('fs');
const path = require('path');
const {
  loadPersonaTemplate,
  personaTemplatePath,
} = require('../bin/lib/persona-template.js');

const REPO_ROOT = path.resolve(__dirname, '..');

function usage() {
  console.error('Usage: tools/assemble-persona-template.js [--check]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length > 1) usage();
if (args.length === 1 && args[0] !== '--check') usage();

const assembled = loadPersonaTemplate(REPO_ROOT);
const aggregatePath = personaTemplatePath(REPO_ROOT);

if (args[0] === '--check') {
  const current = fs.existsSync(aggregatePath)
    ? fs.readFileSync(aggregatePath, 'utf-8')
    : null;
  if (current === assembled) {
    console.log('persona-template: aggregate is up to date');
    process.exit(0);
  }
  console.error('persona-template: docs/PERSONA.template.md differs from docs/persona fragments');
  console.error('Run: tools/assemble-persona-template.js > docs/PERSONA.template.md');
  process.exit(1);
}

process.stdout.write(assembled);
