'use strict';

const path = require('node:path');

const { VAULT_ROOT } = require('../lib/vault.js');
const {
  importConversationFiles,
  parseExtensions,
  gitCheckIgnored,
  ensurePrivateConversationRoot,
} = require('../lib/conversation-log.js');

function usage() {
  console.error('Usage:');
  console.error('  wiki conversation-log import --source <dir> [--provider nanoclaw] [--source-name name] [--extensions md,txt,jsonl,json] [--dry-run]');
  console.error('  wiki conversation-log status');
}

function cmdConversationLog(args) {
  const sub = args._[0] || 'status';
  if (sub === 'status') {
    const root = ensurePrivateConversationRoot(VAULT_ROOT);
    const rel = '.alfred/private/conversations/probe';
    const ignored = gitCheckIgnored(VAULT_ROOT, rel);
    console.log(`root: ${root}`);
    if (ignored.checked) console.log(`gitignored: ${ignored.ignored ? 'yes' : 'NO'}`);
    else console.log(`gitignored: not checked (${ignored.reason})`);
    if (ignored.checked && !ignored.ignored) process.exit(2);
    return;
  }

  if (sub !== 'import') {
    usage();
    process.exit(1);
  }

  const source = args.source || args._[1];
  if (!source) {
    usage();
    process.exit(1);
  }

  let result;
  try {
    result = importConversationFiles({
      vaultRoot: VAULT_ROOT,
      sourceDir: path.resolve(source),
      provider: args.provider || 'nanoclaw',
      sourceName: args['source-name'],
      extensions: parseExtensions(args.extensions),
      dryRun: !!args['dry-run'],
    });
  } catch (e) {
    console.error(`conversation-log: ${e.message}`);
    process.exit(2);
  }

  console.log(`${result.dryRun ? 'would import' : 'imported'} ${result.files} conversation file${result.files === 1 ? '' : 's'}`);
  console.log(`source: ${result.sourceRoot}`);
  console.log(`target: ${result.privateRoot}/${result.provider}/${result.sourceName}`);
  console.log(`manifest: ${result.manifestRel}`);
  console.log(`copied: ${result.copied}`);
  console.log(`unchanged: ${result.unchanged}`);
  console.log(`redactions: ${result.redactions}`);
  if (result.skippedSymlinks.length) {
    console.log(`skipped symlinks: ${result.skippedSymlinks.length}`);
  }
}

module.exports = { cmdConversationLog };
