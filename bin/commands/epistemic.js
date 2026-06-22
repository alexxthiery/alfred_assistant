// commands/epistemic.js — predict / hypothesize / capture.
//
// predict & hypothesize are sugar over cmdPatch's --observation path: they
// auto-build the observation line via lib/epistemic-verbs.js (saving the user
// ten args of inline-tag boilerplate) then delegate to cmdPatch. capture
// classifies a freeform utterance (lib/capture-classifier.js) and routes it to
// the right writer. Pure builders/classifier live in the libs; this is glue.

'use strict';

const fs = require('fs');
const { isISODate } = require('../lib/date.js');
const { buildPredictionLine, buildHypothesisLine, defaultProvenance, stampOnDate } = require('../lib/epistemic-verbs.js');
const { classifyUtterance } = require('../lib/capture-classifier.js');
const { wikiPath } = require('../lib/vault.js');
const { readTextSource } = require('../lib/text-input.js');
const { cmdPatch } = require('./patch.js');

function cmdPredict(args) {
  const slug = args._[0];
  let body = null;
  try {
    body = readTextSource(args, {
      positionalIndex: 1,
      positionalLabel: '<body>',
      fileFlag: 'file',
      stdinFlag: 'stdin',
      label: 'prediction body',
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  if (!slug || !body || !args.by) {
    console.error('Usage: wiki predict <slug> ("body" | --file <path> | --stdin) --by YYYY-MM-DD [--confidence 0.0-1.0] [--provenance LABEL]');
    process.exit(1);
  }
  if (!fs.existsSync(wikiPath(slug))) {
    console.error(`error: page ${slug} does not exist`);
    console.error(`  Hint: \`wiki write ${slug} ...\` to create it first, or \`wiki resolve "${slug}"\` for fuzzy lookup.`);
    process.exit(2);
  }
  let line;
  try {
    line = buildPredictionLine({
      body,
      by: args.by,
      confidence: args.confidence !== undefined ? Number(args.confidence) : 0.5,
      provenance: args.provenance || defaultProvenance(),
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  const patchArgs = { ...args, _: [slug], observation: line };
  delete patchArgs.file;
  delete patchArgs.stdin;
  cmdPatch(patchArgs);
}

function cmdHypothesize(args) {
  const slug = args._[0];
  let body = null;
  try {
    body = readTextSource(args, {
      positionalIndex: 1,
      positionalLabel: '<body>',
      fileFlag: 'file',
      stdinFlag: 'stdin',
      label: 'hypothesis body',
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  if (!slug || !body) {
    console.error('Usage: wiki hypothesize <slug> ("body" | --file <path> | --stdin) [--confidence 0.0-1.0] [--provenance LABEL]');
    process.exit(1);
  }
  if (!fs.existsSync(wikiPath(slug))) {
    console.error(`error: page ${slug} does not exist`);
    console.error(`  Hint: \`wiki write ${slug} ...\` to create it first, or \`wiki resolve "${slug}"\` for fuzzy lookup.`);
    process.exit(2);
  }
  let line;
  try {
    line = buildHypothesisLine({
      body,
      confidence: args.confidence !== undefined ? Number(args.confidence) : undefined,
      provenance: args.provenance || defaultProvenance(),
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  const patchArgs = { ...args, _: [slug], observation: line };
  delete patchArgs.file;
  delete patchArgs.stdin;
  cmdPatch(patchArgs);
}

// `wiki capture` — utterance-driven entry point. Classifies user speech by
// deterministic shape lexicon (regex banks in bin/lib/capture-classifier.js)
// and routes to the right observation category. Reduces LLM judgment load:
// Alfred passes faithful user speech (hedges intact); the classifier picks
// the category. Refuses on ambiguity or prediction-without-date; --as
// <category> overrides when Alfred genuinely knows better.
function cmdCapture(args) {
  const slug = args._[0];
  let text = null;
  try {
    text = readTextSource(args, {
      positionalIndex: 1,
      positionalLabel: '<utterance>',
      fileFlag: 'file',
      stdinFlag: 'stdin',
      label: 'captured utterance',
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  if (!slug || !text) {
    console.error('Usage: wiki capture <slug> ("<utterance>" | --file <path> | --stdin) [--as CATEGORY] [--by YYYY-MM-DD] [--confidence N] [--provenance LABEL]');
    process.exit(1);
  }
  if (!fs.existsSync(wikiPath(slug))) {
    console.error(`error: page ${slug} does not exist`);
    console.error(`  Hint: \`wiki write ${slug} ...\` to create it first.`);
    process.exit(2);
  }
  let r;
  try { r = classifyUtterance(text); }
  catch (e) { console.error(`error: ${e.message}`); process.exit(3); }

  const category = args.as || r.category;
  if (!category) {
    console.error(`error: ${r.refuseReason || 'ambiguous classification'}; pass --as <category> to override, or rephrase`);
    if (r.refuseReason === 'prediction-without-date') {
      console.error('  Hint: add --by YYYY-MM-DD, or rephrase to a [hypothesis] without time bound');
    }
    process.exit(3);
  }

  const provenance = args.provenance || defaultProvenance();
  const confidence = args.confidence !== undefined ? Number(args.confidence) : r.confidence;
  const by = args.by || r.by_date;

  let line;
  try {
    if (category === 'prediction') {
      if (!by) {
        console.error('error: [prediction] requires --by YYYY-MM-DD (no date detected in utterance)');
        console.error('  Hint: pass --by explicitly, or rephrase as [hypothesis] without time bound');
        process.exit(3);
      }
      line = buildPredictionLine({ body: r.body, by, confidence: confidence != null ? confidence : 0.6, provenance });
    } else if (category === 'hypothesis') {
      line = buildHypothesisLine({ body: r.body, confidence: confidence != null ? confidence : 0.5, provenance });
    } else {
      const confTag = (confidence !== undefined && confidence !== null) ? ` [confidence: ${confidence}]` : '';
      line = `[${category}] ${r.body}${confTag} ^[${provenance}]`;
    }
  } catch (e) { console.error(`error: ${e.message}`); process.exit(3); }

  // --today / --on YYYY-MM-DD: stamp [on <date>] into the line so the
  // observation's `on_date` column is populated and `wiki day` can find it.
  // --today is sugar for --on <today-ISO>; explicit --on wins if both passed.
  let onDate = null;
  if (args.today) onDate = new Date().toISOString().slice(0, 10);
  if (args.on !== undefined) {
    const v = String(args.on);
    if (!isISODate(v)) {
      console.error(`error: --on must be YYYY-MM-DD (got "${v}")`);
      process.exit(3);
    }
    onDate = v;
  }
  if (onDate) {
    try { line = stampOnDate(line, onDate); }
    catch (e) { console.error(`error: ${e.message}`); process.exit(3); }
  }

  const patchArgs = { ...args, _: [slug], observation: line };
  delete patchArgs.file;
  delete patchArgs.stdin;
  cmdPatch(patchArgs);
}

module.exports = { cmdPredict, cmdHypothesize, cmdCapture };
