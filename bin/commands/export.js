// commands/export.js — `wiki export`: write a free-form deliverable (summary,
// report, generated table) to the vault's output/ directory.
//
// This verb is the SINGLE WRITER for output/. It exists so agents never call
// raw fs.writeFileSync into the vault: it sanitizes the filename (no traversal,
// no separators, no hidden files — see bin/lib/output-export.js), forces the
// file under <vault-root>/output/, resolves name collisions, and refuses empty
// bodies (fail-to-safe — never leave a zero-byte deliverable).
//
// output/ is gitignored, so a deliverable is NOT vault graph content: this verb
// deliberately does NOT auto-commit and is NOT a WRITE_VERB (no tamper-check).
// Durable knowledge belongs in the graph via `wiki write` instead.
//
// Body source: stdin by default (natural for piping LLM output), or --content.
// Prints the absolute path written so the caller can report it.

'use strict';

const fs = require('fs');
const path = require('path');
const { VAULT_ROOT } = require('../lib/vault.js');
const { buildExportFilename } = require('../lib/output-export.js');

const OUTPUT_DIR = path.join(VAULT_ROOT, 'output');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    // No readable stdin (closed/again): treat as empty; caller refuses empty.
    return '';
  }
}

function cmdExport(args) {
  const name = args._[0];
  if (!name) {
    console.error('Usage: wiki export <name> [--content "..."] [--ext md] [--force]');
    console.error('  Writes a free-form deliverable to <vault-root>/output/<name>.<ext>.');
    console.error('  Body comes from stdin by default, or --content "...".');
    console.error('  output/ is gitignored: no version history, not searchable. Durable');
    console.error('  knowledge belongs in the graph via `wiki write`, not here.');
    process.exit(1);
  }

  // Body: --content wins if given; otherwise read piped stdin. Never block on a
  // TTY waiting for input — if there is no content source, fail with guidance.
  let content;
  if (args.content !== undefined && args.content !== true) {
    content = String(args.content);
  } else if (!process.stdin.isTTY) {
    content = readStdin();
  } else {
    console.error('error: no body provided. Pipe content via stdin or pass --content "..."');
    process.exit(1);
  }
  if (!content.trim()) {
    console.error('error: refusing to write an empty deliverable (body via stdin or --content was empty)');
    process.exit(3);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const existing = fs.readdirSync(OUTPUT_DIR);
  const built = buildExportFilename({
    name,
    ext: args.ext,
    existing,
    force: !!args.force,
  });
  if (!built.ok) {
    console.error(`error: ${built.error}`);
    process.exit(3);
  }

  const dest = path.join(OUTPUT_DIR, built.filename);
  const body = content.endsWith('\n') ? content : content + '\n';
  fs.writeFileSync(dest, body);
  console.log(dest);
}

module.exports = { cmdExport };
