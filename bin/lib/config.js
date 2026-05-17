// config.js — load .alfred.yml from the current vault.
//
// Walks up from `startDir` (default: process.cwd()) looking for `.alfred.yml`.
// Parses a flat 2-level YAML subset (one section per top-level key, scalar
// children only — no nested mappings, no flow style, no lists). Applies
// defaults, env fallbacks, and validation. Returns a frozen config object.
//
// Zero dependencies — runs on Node stdlib only.

'use strict';

const fs = require('fs');
const path = require('path');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

const DEFAULTS = Object.freeze({
  user: { slug: 'user', name: 'Anonymous' },
  assistant: { name: 'Alfred' },
  email: { from: '', to: '' },
  weekly_review: { enabled: false, cron: '0 9 * * 1', timezone: '' },
  paths: { vault_root: '' },
});

function findConfigFile(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const candidate = path.join(dir, '.alfred.yml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Minimal YAML reader. Supports:
//   key: value          (top-level scalar)
//   section:
//     key: value        (2-space indent, scalar children)
// Strips '#' comments, trims, removes surrounding quotes, converts true/false.
function parseFlatYaml(text) {
  const out = {};
  let section = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    const hash = raw.indexOf('#');
    if (hash !== -1) raw = raw.slice(0, hash);
    if (!raw.trim()) continue;

    const indent = raw.match(/^(\s*)/)[1].length;
    const trimmed = raw.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) throw new Error(`.alfred.yml line ${i + 1}: expected 'key: value', got: ${trimmed}`);
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();

    if (indent === 0) {
      if (value === '') {
        section = key;
        out[section] = {};
      } else {
        section = null;
        out[key] = coerce(value);
      }
    } else if (indent === 2) {
      if (!section) throw new Error(`.alfred.yml line ${i + 1}: indented key '${key}' has no parent section`);
      out[section][key] = coerce(value);
    } else {
      throw new Error(`.alfred.yml line ${i + 1}: unexpected indent (${indent} spaces) — only 0 or 2 supported`);
    }
  }
  return out;
}

function coerce(v) {
  if (v.length >= 2) {
    const a = v[0], b = v[v.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return '';
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function merge(defaults, override) {
  const out = {};
  for (const k of Object.keys(defaults)) {
    if (typeof defaults[k] === 'object' && defaults[k] !== null && !Array.isArray(defaults[k])) {
      out[k] = merge(defaults[k], (override && override[k]) || {});
    } else {
      const v = override && Object.prototype.hasOwnProperty.call(override, k) ? override[k] : defaults[k];
      out[k] = v;
    }
  }
  // Carry forward any extra keys from override (forward-compat with new fields)
  if (override) {
    for (const k of Object.keys(override)) {
      if (!(k in out)) out[k] = override[k];
    }
  }
  return out;
}

function applyEnvFallbacks(cfg) {
  if (!cfg.email.from && process.env.EMAIL_FROM) cfg.email.from = process.env.EMAIL_FROM;
  if (!cfg.email.to && cfg.email.from) cfg.email.to = cfg.email.from;
  if (!cfg.weekly_review.timezone && process.env.TZ) cfg.weekly_review.timezone = process.env.TZ;
  return cfg;
}

function validate(cfg, configPath) {
  const where = configPath || '<defaults>';
  if (!SLUG_RE.test(cfg.user.slug)) {
    throw new Error(`${where}: user.slug '${cfg.user.slug}' is not a valid slug (lowercase, digits, hyphens)`);
  }
  if (cfg.weekly_review.enabled && !CRON_RE.test(cfg.weekly_review.cron)) {
    throw new Error(`${where}: weekly_review.cron '${cfg.weekly_review.cron}' must be a 5-field cron expression`);
  }
  if (typeof cfg.weekly_review.enabled !== 'boolean') {
    throw new Error(`${where}: weekly_review.enabled must be true or false`);
  }
}

function deepFreeze(obj) {
  Object.freeze(obj);
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'object' && obj[k] !== null) deepFreeze(obj[k]);
  }
  return obj;
}

function loadConfig(startDir) {
  const configPath = findConfigFile(startDir);
  let parsed = {};
  if (configPath) {
    const text = fs.readFileSync(configPath, 'utf8');
    parsed = parseFlatYaml(text);
  }
  const cfg = merge(DEFAULTS, parsed);
  applyEnvFallbacks(cfg);
  validate(cfg, configPath);

  // Resolve vault_root: explicit > parent dir of .alfred.yml > cwd
  if (!cfg.paths.vault_root) {
    cfg.paths.vault_root = configPath ? path.dirname(configPath) : path.resolve(startDir || process.cwd());
  } else {
    cfg.paths.vault_root = cfg.paths.vault_root.replace(/^~(?=\/|$)/, process.env.HOME || '');
    if (!path.isAbsolute(cfg.paths.vault_root)) {
      const base = configPath ? path.dirname(configPath) : process.cwd();
      cfg.paths.vault_root = path.resolve(base, cfg.paths.vault_root);
    }
  }

  cfg._configPath = configPath; // null if no file found — caller can warn
  return deepFreeze(cfg);
}

module.exports = { loadConfig, parseFlatYaml, DEFAULTS };
