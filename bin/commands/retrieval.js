'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { parseObservations, stripSupersededObservationLines } = require('../lib/graph.js');
const { VAULT_ROOT, forEachPage } = require('../lib/vault.js');
const { formatCoverage, rankRetrievalCandidates } = require('../lib/retrieval.js');

function readCases(args) {
  if (args.case) {
    try {
      return [JSON.parse(String(args.case))];
    } catch (e) {
      console.error(`error: --case must be JSON: ${e.message}`);
      process.exit(1);
    }
  }
  const file = args.file || path.join(VAULT_ROOT, 'alfred', 'retrieval-evals.json');
  if (!fs.existsSync(file)) {
    console.error('Usage: wiki eval-retrieval [--file path.json | --case JSON] [--threshold N] [--limit N]');
    console.error(`error: eval file not found: ${file}`);
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.cases)) return parsed.cases;
    throw new Error('expected an array or {"cases":[...]}');
  } catch (e) {
    console.error(`error: failed to read eval cases: ${e.message}`);
    process.exit(1);
  }
}

function activeObservationLines(body) {
  return parseObservations(body)
    .filter((o) => !o.superseded)
    .map((o) => `[${o.category}] ${o.body}`);
}

function loadRetrievalPages() {
  const pages = [];
  forEachPage(({ slug: fileSlug, fm, body }) => {
    const slug = fm.id || fileSlug;
    const activeBody = stripSupersededObservationLines(body);
    pages.push({
      slug,
      fm,
      body: activeBody,
      observations: activeObservationLines(body),
    });
  });
  return pages;
}

function contextText(rows, limit) {
  const chunks = [];
  for (const row of rows.slice(0, limit)) {
    const p = row.page;
    chunks.push(`# ${p.slug} · ${p.fm.title || ''}`);
    for (const obs of p.observations.slice(0, 8)) chunks.push(`- ${obs}`);
  }
  return chunks.join('\n');
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function checkCase(testCase, pages, opts) {
  const question = testCase.question || testCase.q;
  if (!question) return { name: testCase.name || '(unnamed)', ok: false, errors: ['missing question'] };
  const name = testCase.name || question;
  const rows = rankRetrievalCandidates(question, pages, { threshold: opts.threshold });
  const confidentRows = rows.filter((r) => r.confidence.confident);
  const selected = confidentRows.slice(0, opts.limit);
  const selectedSlugs = selected.map((r) => r.slug);
  const strongLabels = rows.filter((r) => r.label && r.label.strong);
  const ambiguous = strongLabels.length > 1;
  const ctx = contextText(selected, opts.limit);
  const errors = [];

  if (testCase.expectFirstSlug && selectedSlugs[0] !== testCase.expectFirstSlug) {
    errors.push(`first slug ${selectedSlugs[0] || '(none)'} != ${testCase.expectFirstSlug}`);
  }
  for (const slug of asArray(testCase.expectSlugs)) {
    if (!selectedSlugs.includes(slug)) errors.push(`missing expected slug ${slug}`);
  }
  for (const slug of asArray(testCase.expectNotSlugs)) {
    if (selectedSlugs.includes(slug)) errors.push(`unexpected slug ${slug}`);
  }
  for (const needle of asArray(testCase.expectContains)) {
    if (!ctx.includes(needle)) errors.push(`context missing ${JSON.stringify(needle)}`);
  }
  for (const needle of asArray(testCase.expectNotContains)) {
    if (ctx.includes(needle)) errors.push(`context unexpectedly contains ${JSON.stringify(needle)}`);
  }
  if (testCase.expectConfident !== undefined && Boolean(testCase.expectConfident) !== (confidentRows.length > 0)) {
    errors.push(`confidence ${(confidentRows.length > 0) ? 'yes' : 'no'} != ${Boolean(testCase.expectConfident) ? 'yes' : 'no'}`);
  }
  if (testCase.expectAmbiguous !== undefined && Boolean(testCase.expectAmbiguous) !== ambiguous) {
    errors.push(`ambiguity ${ambiguous ? 'yes' : 'no'} != ${Boolean(testCase.expectAmbiguous) ? 'yes' : 'no'}`);
  }

  return {
    name,
    ok: errors.length === 0,
    errors,
    selected,
    ambiguous,
  };
}

function cmdEvalRetrieval(args) {
  const threshold = args.threshold !== undefined ? Number(args.threshold) : 0.5;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    console.error('error: --threshold must be a number in [0,1]');
    process.exit(1);
  }
  const limit = Math.max(1, parseInt(args.limit, 10) || 5);
  const cases = readCases(args);
  const pages = loadRetrievalPages();
  let failures = 0;

  for (const testCase of cases) {
    const res = checkCase(testCase, pages, { threshold, limit });
    if (res.ok) {
      console.log(`PASS ${res.name}`);
    } else {
      failures++;
      console.log(`FAIL ${res.name}`);
      for (const e of res.errors) console.log(`  - ${e}`);
    }
    if (args.explain || !res.ok) {
      const top = res.selected.slice(0, 5);
      if (top.length) {
        for (const row of top) {
          console.log(`  ${row.slug} via=${row.via} confidence=${row.confidence.confident ? 'yes' : 'no'} coverage=${formatCoverage(row.confidence.coverage)} reason=${row.confidence.reason}`);
        }
      } else {
        console.log('  (no confident candidates)');
      }
      if (res.ambiguous) console.log('  ambiguous=yes');
    }
  }
  console.log(`${cases.length - failures}/${cases.length} retrieval evals passed`);
  process.exit(failures ? 1 : 0);
}

module.exports = { cmdEvalRetrieval };
