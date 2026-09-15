// locality.js — classify host path locality risks for vault-private runtime data.
//
// This is a warning helper, not an access-control boundary. It catches common
// consumer sync roots where gitignored files may still leave the machine.

'use strict';

const path = require('node:path');

const CLOUD_SEGMENTS = new Set([
  'Dropbox',
  'CloudStorage',
  'iCloud Drive',
  'Google Drive',
  'OneDrive',
  'Syncthing',
]);

function pathSegments(p) {
  return path.resolve(p || '.').split(path.sep).filter(Boolean);
}

function cloudSyncSegments(p) {
  return pathSegments(p).filter((segment) => CLOUD_SEGMENTS.has(segment));
}

function localityWarningForVault(vaultRoot) {
  const hits = cloudSyncSegments(vaultRoot);
  if (!hits.length) return null;
  return {
    kind: 'cloud-sync-root',
    segments: hits,
    message: `vault path appears under ${hits.join('/')}; gitignored .alfred/private/ and cache/ data may still sync outside this machine`,
  };
}

module.exports = { cloudSyncSegments, localityWarningForVault };
