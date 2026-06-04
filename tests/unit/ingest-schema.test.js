// Unit tests for the documented wiki ingest JSON Schema.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

test('wiki-ingest schema allows top-level msg_id for replay capture', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'wiki-ingest.schema.json'), 'utf-8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.msg_id.type, 'string');
  assert.equal(schema.properties.msg_id.minLength, 1);
});
