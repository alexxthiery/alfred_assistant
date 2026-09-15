'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const { parseFlatYaml } = require(path.join(ROOT, 'bin', 'lib', 'config.js'));
const { renderConfig } = require(path.join(ROOT, 'tools', 'render-alfred-config.js'));

const TEMPLATE = path.join(ROOT, 'examples', '.alfred.yml.example');

test('render-alfred-config preserves safe shell-sensitive characters without sed corruption', () => {
  const rendered = renderConfig({
    template: TEMPLATE,
    userSlug: 'sample-user',
    userName: 'A&B|C',
    assistantName: 'Helper & Co',
    emailFrom: 'a+b@example.com',
  });
  const parsed = parseFlatYaml(rendered);
  assert.equal(parsed.user.slug, 'sample-user');
  assert.equal(parsed.user.name, 'A&B|C');
  assert.equal(parsed.assistant.name, 'Helper & Co');
  assert.equal(parsed.email.from, 'a+b@example.com');
});

test('render-alfred-config rejects invalid slugs before writing config', () => {
  assert.throws(
    () => renderConfig({
      template: TEMPLATE,
      userSlug: 'Bad Slug',
      userName: 'Person A',
      assistantName: 'Helper',
      emailFrom: '',
    }),
    /user\.slug/,
  );
});

test('render-alfred-config rejects scalars unsupported by the flat YAML parser', () => {
  assert.throws(
    () => renderConfig({
      template: TEMPLATE,
      userSlug: 'sample',
      userName: 'Person A # comment injection',
      assistantName: 'Helper',
      emailFrom: '',
    }),
    /unsupported by \.alfred\.yml flat scalar rendering/,
  );
});

test('render-alfred-config rejects quotes that would break quoted YAML fields', () => {
  assert.throws(
    () => renderConfig({
      template: TEMPLATE,
      userSlug: 'sample',
      userName: 'Person A',
      assistantName: 'Helper',
      emailFrom: 'person"example@example.com',
    }),
    /unsupported by \.alfred\.yml flat scalar rendering/,
  );
});
