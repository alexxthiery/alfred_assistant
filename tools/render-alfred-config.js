#!/usr/bin/env node
// Render the initial per-vault .alfred.yml from the example template.
//
// This deliberately supports only the repo's flat YAML subset. It exists so
// deploy.sh does not interpolate identity fields through sed, where &, |, and
// other replacement metacharacters can corrupt the generated config.

'use strict';

const fs = require('node:fs');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function usage() {
  return [
    'Usage: render-alfred-config.js --template <path> --user-slug <slug> --user-name <name>',
    '                               [--assistant-name <name>] [--email-from <email>]',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    assistantName: 'Alfred',
    emailFrom: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      i += 1;
      return argv[i];
    };
    if (arg === '--template') out.template = next();
    else if (arg === '--user-slug') out.userSlug = next();
    else if (arg === '--user-name') out.userName = next();
    else if (arg === '--assistant-name') out.assistantName = next();
    else if (arg === '--email-from') out.emailFrom = next();
    else if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  for (const key of ['template', 'userSlug', 'userName']) {
    if (!out[key]) throw new Error(`missing --${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
  }
  return out;
}

function validateScalar(label, value, { allowEmpty = false } = {}) {
  if (value === '' && allowEmpty) return;
  if (value === '') throw new Error(`${label} must not be empty`);
  if (/[\r\n#"\\]/.test(value)) {
    throw new Error(`${label} contains a character unsupported by .alfred.yml flat scalar rendering`);
  }
  if (/^\s|\s$/.test(value)) {
    throw new Error(`${label} must not have leading or trailing whitespace`);
  }
}

function renderTemplate(template, values) {
  const replacements = new Map([
    ['  slug: user', `  slug: ${values.userSlug}`],
    ['  name: Anonymous', `  name: ${values.userName}`],
    ['  name: Alfred', `  name: ${values.assistantName}`],
    ['  from: ""', `  from: "${values.emailFrom}"`],
  ]);
  const seen = new Set();
  const out = template.split(/\n/).map((line) => {
    if (!replacements.has(line)) return line;
    seen.add(line);
    return replacements.get(line);
  }).join('\n');
  for (const key of replacements.keys()) {
    if (!seen.has(key)) throw new Error(`template did not contain expected line: ${key}`);
  }
  return out.endsWith('\n') ? out : `${out}\n`;
}

function renderConfig(args) {
  if (!SLUG_RE.test(args.userSlug || '')) {
    throw new Error(`user.slug '${args.userSlug || ''}' is not a valid slug (lowercase, digits, hyphens)`);
  }
  validateScalar('user.name', args.userName);
  validateScalar('assistant.name', args.assistantName);
  validateScalar('email.from', args.emailFrom, { allowEmpty: true });
  const template = fs.readFileSync(args.template, 'utf8');
  return renderTemplate(template, args);
}

if (require.main === module) {
  try {
    process.stdout.write(renderConfig(parseArgs(process.argv.slice(2))));
  } catch (err) {
    console.error(`render-alfred-config.js: ${err.message}`);
    process.exit(2);
  }
}

module.exports = { renderConfig, parseArgs, validateScalar };
