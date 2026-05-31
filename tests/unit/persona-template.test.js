const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PERSONA_FRAGMENT_FILES,
  personaFragmentsDir,
  personaTemplatePath,
  assemblePersonaFragments,
  stripLeadingInstructionComment,
  renderPersonaTemplate,
  loadPersonaTemplate,
} = require('../../bin/lib/persona-template.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('persona fragments assemble to the compatibility aggregate', () => {
  const assembled = loadPersonaTemplate(REPO_ROOT);
  const aggregate = fs.readFileSync(personaTemplatePath(REPO_ROOT), 'utf-8');
  assert.equal(assembled, aggregate);
});

test('persona fragment manifest is deterministic and complete', () => {
  assert.deepEqual(PERSONA_FRAGMENT_FILES, [...PERSONA_FRAGMENT_FILES].sort());
  assert.equal(new Set(PERSONA_FRAGMENT_FILES).size, PERSONA_FRAGMENT_FILES.length);

  const dir = personaFragmentsDir(REPO_ROOT);
  for (const file of PERSONA_FRAGMENT_FILES) {
    assert.match(file, /^\d\d-[a-z0-9-]+\.template\.md$/);
    const text = fs.readFileSync(path.join(dir, file), 'utf-8');
    assert.ok(text.length > 0, `${file} should not be empty`);
  }
});

test('assembled persona keeps required identity placeholders', () => {
  const assembled = loadPersonaTemplate(REPO_ROOT);
  for (const token of ['{{USER_NAME}}', '{{USER_SLUG}}', '{{USER_EMAIL}}', '{{USER_TZ_CITY}}']) {
    assert.ok(assembled.includes(token), `missing ${token}`);
  }
});

test('assemblePersonaFragments is a pure concatenation helper', () => {
  assert.equal(assemblePersonaFragments(['alpha\n', 'beta']), 'alpha\nbeta');
  assert.throws(() => assemblePersonaFragments('alpha'), /fragments must be an array/);
});

test('stripLeadingInstructionComment matches the legacy line-based renderer', () => {
  assert.equal(
    stripLeadingInstructionComment('<!--\nmetadata\n-->\n\nBody\n'),
    '\nBody\n',
  );
  assert.equal(stripLeadingInstructionComment('Body\n'), 'Body\n');
  assert.equal(stripLeadingInstructionComment('<!--\nunterminated\nBody\n'), '<!--\nunterminated\nBody\n');
});

test('renderPersonaTemplate replaces placeholders without shell escaping hazards', () => {
  const rendered = renderPersonaTemplate('<!--\nmetadata\n-->\nHello {{USER_NAME}} <{{USER_EMAIL}}>.\n', {
    USER_NAME: 'A&B|C',
    USER_EMAIL: 'user+test@example.com',
  });
  assert.equal(rendered, 'Hello A&B|C <user+test@example.com>.\n');
});
