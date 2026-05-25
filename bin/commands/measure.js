// commands/measure.js — `wiki measure`: append a row to a tabular time-series
// (raw/measurements/<series>.tsv) and re-render its read-only wiki page. The
// TSV is the source of truth; the wiki page is regenerated from it. Pure-ish
// fs + table helpers; appendLog auto-commits.

'use strict';

const fs = require('fs');
const path = require('path');
const { VAULT_ROOT, nowISO, wikiPath } = require('../lib/vault.js');
const { parseFrontmatter, serializeFrontmatter } = require('../lib/frontmatter.js');
const { isISODate } = require('../lib/date.js');
const { appendLog } = require('../lib/page-io.js');

const MEASUREMENTS_DIR = path.join(VAULT_ROOT, 'raw', 'measurements');

function readTsv(tsvPath) {
  const text = fs.readFileSync(tsvPath, 'utf-8').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').filter((l) => l.length);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  });
  return { header, rows };
}

function writeTsv(tsvPath, header, rows) {
  const lines = [header.join('\t')];
  for (const r of rows) lines.push(header.map((h) => r[h] ?? '').join('\t'));
  fs.writeFileSync(tsvPath, lines.join('\n') + '\n');
}

function renderMeasurementPage(slug, header, rows) {
  const p = wikiPath(slug);
  const existing = fs.existsSync(p) ? parseFrontmatter(fs.readFileSync(p, 'utf-8')) : { fm: {}, body: '' };
  const fm = { ...existing.fm };
  fm.id = slug;
  fm.title = fm.title || slug;
  fm.type = fm.type || 'note';
  fm.created = fm.created || nowISO();
  fm.updated = nowISO();
  fm.tags = fm.tags || ['health'];
  fm.source_file = `raw/measurements/${slug.replace(/-growth$/, '')}.tsv`;

  // Preserve any "intro" text the user wrote between frontmatter and the AUTO marker.
  const AUTO_MARK = '<!-- AUTO: regenerated from source_file — do not edit below -->';
  let intro = '';
  const oldMarkIdx = existing.body.indexOf(AUTO_MARK);
  if (oldMarkIdx >= 0) {
    intro = existing.body.slice(0, oldMarkIdx).trim();
  } else if (existing.body.trim()) {
    // First conversion: drop the old hand-authored body, keep the first non-table prose line as intro.
    const firstPara = existing.body.split('\n').find((l) => l.trim() && !l.startsWith('|') && !l.startsWith('-'));
    intro = firstPara ? firstPara.trim() : '';
  }

  const lines = [];
  if (intro) lines.push(intro, '');
  lines.push(AUTO_MARK, '');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);
  for (const r of rows) lines.push(`| ${header.map((h) => r[h] ?? '').join(' | ')} |`);
  lines.push('');

  fs.writeFileSync(p, serializeFrontmatter(fm, lines.join('\n')));
}

function computeAge(birthDateStr, onDateStr) {
  if (!birthDateStr || !onDateStr) return null;
  const ms = new Date(onDateStr).getTime() - new Date(birthDateStr).getTime();
  if (!isFinite(ms)) return null;
  return (ms / (365.25 * 24 * 60 * 60 * 1000));
}

function cmdMeasure(args) {
  const series = args._[0];
  if (!series) {
    console.error('Usage: wiki measure <series> --date YYYY-MM-DD --field=value [--field=value ...] [--page <slug>] [--birth YYYY-MM-DD]');
    console.error('  Series TSV lives at raw/measurements/<series>.tsv. Rendered page defaults to <series>-growth.');
    console.error('  Example: wiki measure alice --date 2026-05-17 --height_m=1.50 --weight_kg=40.0 --birth=2014-03-15');
    process.exit(1);
  }
  fs.mkdirSync(MEASUREMENTS_DIR, { recursive: true });
  const tsvPath = path.join(MEASUREMENTS_DIR, `${series}.tsv`);
  if (!fs.existsSync(tsvPath)) {
    console.error(`error: series TSV not found: ${tsvPath}`);
    console.error(`  Create it first with a header row, e.g.:`);
    console.error(`  printf 'date\\theight_m\\tweight_kg\\tbmi\\tsource\\n' > ${tsvPath}`);
    process.exit(2);
  }
  if (!args.date) { console.error('--date YYYY-MM-DD required'); process.exit(1); }
  if (!isISODate(String(args.date))) { console.error(`--date must be YYYY-MM-DD, got "${args.date}"`); process.exit(1); }

  const { header, rows } = readTsv(tsvPath);
  if (rows.find((r) => r.date === args.date)) {
    console.error(`error: row for date ${args.date} already exists in ${series}.tsv. Edit the TSV directly to update.`);
    process.exit(3);
  }

  // Build the new row from CLI args. Anything in args that matches a header column wins.
  const newRow = { date: String(args.date) };
  for (const h of header) {
    if (h === 'date') continue;
    if (args[h] !== undefined) newRow[h] = String(args[h]);
  }
  newRow.source = newRow.source || `cli:${nowISO().slice(0, 10)}`;

  // Auto-derive: bmi from height_m + weight_kg if both present and bmi missing.
  if (header.includes('bmi') && !newRow.bmi && newRow.height_m && newRow.weight_kg) {
    const h = parseFloat(newRow.height_m), w = parseFloat(newRow.weight_kg);
    if (h > 0 && w > 0) newRow.bmi = (w / (h * h)).toFixed(2);
  }
  // Auto-derive: age from --birth + date if header has age and age missing.
  if (header.includes('age') && !newRow.age && args.birth) {
    const yrs = computeAge(String(args.birth), newRow.date);
    if (yrs !== null) newRow.age = yrs.toFixed(2);
  }

  // Validate required columns (skip derived if we filled them in).
  for (const h of header) {
    if (newRow[h] === undefined || newRow[h] === '') {
      console.error(`error: missing column "${h}". Pass --${h}=<value> or supply --birth (for age) / both height_m+weight_kg (for bmi).`);
      process.exit(1);
    }
  }

  rows.push(newRow);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  writeTsv(tsvPath, header, rows);

  const pageSlug = args.page || `${series}-growth`;
  renderMeasurementPage(pageSlug, header, rows);

  appendLog('measure', `${series} (${newRow.date}: ${header.filter((h) => h !== 'date' && h !== 'source').map((h) => `${h}=${newRow[h]}`).join(', ')})`);
  console.log(`appended row in ${tsvPath}`);
  console.log(`re-rendered ${wikiPath(pageSlug)}`);
}

module.exports = { cmdMeasure };
