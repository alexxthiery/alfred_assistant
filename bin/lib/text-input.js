'use strict';

const fs = require('fs');

function hasArgValue(args, flag) {
  return !!flag && args[flag] !== undefined && args[flag] !== false;
}

function sourceChoices({ positionalLabel, inlineFlag, fileFlag, stdinFlag }) {
  return [
    positionalLabel || null,
    inlineFlag ? `--${inlineFlag}` : null,
    fileFlag ? `--${fileFlag}` : null,
    stdinFlag ? `--${stdinFlag}` : null,
  ].filter(Boolean);
}

function readTextSource(args, spec, io = {}) {
  const {
    positionalIndex,
    positionalLabel,
    inlineFlag,
    fileFlag,
    stdinFlag,
    label,
  } = spec;
  const existsSync = io.existsSync || fs.existsSync;
  const readFileSync = io.readFileSync || ((p) => fs.readFileSync(p, 'utf-8'));
  const readStdin = io.readStdin || (() => fs.readFileSync(0, 'utf-8'));

  const sources = [];
  if (positionalIndex !== undefined && args._[positionalIndex] !== undefined) {
    sources.push({ kind: 'positional', text: String(args._[positionalIndex]) });
  }
  if (hasArgValue(args, inlineFlag)) {
    sources.push({ kind: 'inline', text: String(args[inlineFlag]) });
  }
  if (stdinFlag && args[stdinFlag] !== undefined && args[stdinFlag] !== false) {
    if (args[stdinFlag] !== true) throw new Error(`--${stdinFlag} does not take a value`);
    sources.push({ kind: 'stdin' });
  }
  if (hasArgValue(args, fileFlag)) {
    sources.push({ kind: 'file', path: String(args[fileFlag]) });
  }

  if (sources.length > 1) {
    throw new Error(`choose exactly one of ${sourceChoices({ positionalLabel, inlineFlag, fileFlag, stdinFlag }).join(', ')} for ${label}`);
  }
  if (!sources.length) return null;

  const source = sources[0];
  if (source.kind === 'stdin') return readStdin();
  if (source.kind === 'file') {
    if (!existsSync(source.path)) throw new Error(`file not found: ${source.path}`);
    return readFileSync(source.path);
  }
  return source.text;
}

module.exports = {
  hasArgValue,
  readTextSource,
};
