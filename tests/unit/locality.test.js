'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { cloudSyncSegments, localityWarningForVault } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'locality.js'));

test('localityWarningForVault warns under common cloud-sync roots', () => {
  const warning = localityWarningForVault('/Users/sample/Library/CloudStorage/Dropbox/sample-vault');
  assert.equal(warning.kind, 'cloud-sync-root');
  assert.deepEqual(warning.segments, ['CloudStorage', 'Dropbox']);
  assert.match(warning.message, /gitignored .* may still sync/);
});

test('localityWarningForVault is quiet for ordinary local paths', () => {
  assert.equal(localityWarningForVault('/Users/sample/sample-vault'), null);
});

test('cloudSyncSegments detects iCloud Drive as one path segment', () => {
  assert.deepEqual(cloudSyncSegments('/Users/sample/iCloud Drive/example-vault'), ['iCloud Drive']);
});
