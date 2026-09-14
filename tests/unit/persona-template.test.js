const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PERSONA_FRAGMENT_FILES,
  personaFragmentsDir,
  personaTemplatePath,
  assemblePersonaFragments,
  stripLeadingInstructionComment,
  renderPersonaTemplate,
  findUnresolvedPlaceholders,
  loadPersonaTemplate,
  loadLocalPersonaFragments,
  renderPersonaDocument,
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
  for (const token of ['{{USER_NAME}}', '{{USER_SLUG}}', '{{USER_EMAIL}}', '{{USER_TZ_CITY}}', '{{ASSISTANT_NAME}}']) {
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
  const rendered = renderPersonaTemplate('<!--\nmetadata\n-->\n{{ASSISTANT_NAME}} helps {{USER_NAME}} <{{USER_EMAIL}}>.\n', {
    ASSISTANT_NAME: 'Minerva',
    USER_NAME: 'A&B|C',
    USER_EMAIL: 'user+test@example.com',
  });
  assert.equal(rendered, 'Minerva helps A&B|C <user+test@example.com>.\n');
});

test('renderPersonaDocument prepends generated marker and appends local overlays deterministically', () => {
  const rendered = renderPersonaDocument({
    template: '<!--\nmetadata\n-->\n# {{ASSISTANT_NAME}}\n',
    replacements: { ASSISTANT_NAME: 'Minerva' },
    localFragments: [
      { file: '20-routines.md', content: '## Routines\nDaily brief only.\n' },
      { file: '50-voice.md', content: '## Voice\nWarm and concise.\n' },
    ],
  });

  assert.match(rendered, /^<!--\nGENERATED FILE - do not edit AGENTS\.md directly\./);
  assert.match(rendered, /^# Minerva$/m);
  assert.match(rendered, /## Local Persona Overlays/);
  assert.match(rendered, /persona\/agents\.d\/20-routines\.md/);
  assert.match(rendered, /persona\/agents\.d\/50-voice\.md/);
});

test('renderPersonaDocument rejects unresolved placeholders', () => {
  assert.throws(() => {
    renderPersonaDocument({
      template: '# {{ASSISTANT_NAME}}\n{{MISSING_TOKEN}}\n',
      replacements: { ASSISTANT_NAME: 'Alfred' },
    });
  }, /unresolved persona placeholder\(s\): \{\{MISSING_TOKEN\}\}/);
});

test('loadLocalPersonaFragments reads persona/agents.d markdown in filename order', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-local-'));
  const dir = path.join(vault, 'persona', 'agents.d');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '50-voice.md'), 'voice\n');
  fs.writeFileSync(path.join(dir, '10-boundary.md'), 'boundary\n');
  fs.writeFileSync(path.join(dir, '.scratch.md'), 'ignored\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored\n');

  const fragments = loadLocalPersonaFragments(vault);
  assert.deepEqual(fragments.map((f) => f.file), ['10-boundary.md', '50-voice.md']);
  assert.deepEqual(fragments.map((f) => f.content), ['boundary\n', 'voice\n']);
});

test('findUnresolvedPlaceholders returns sorted unique template tokens', () => {
  assert.deepEqual(
    findUnresolvedPlaceholders('{{BETA}} {{ALPHA}} {{BETA}} {{not_a_token}}'),
    ['{{ALPHA}}', '{{BETA}}'],
  );
});

test('render-persona.sh uses assistant.name from the target vault config', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-render-'));
  fs.writeFileSync(path.join(vault, '.alfred.yml'), [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'assistant:',
    '  name: Minerva',
    'weekly_review:',
    '  timezone: Asia/Singapore',
    '',
  ].join('\n'));

  const rendered = execFileSync(path.join(REPO_ROOT, 'tools', 'render-persona.sh'), [
    '--vault',
    vault,
    '--stdout',
  ], { encoding: 'utf8' });

  assert.match(rendered, /^# Minerva — Sample User's personal agent$/m);
  assert.match(rendered, /^You are Minerva\. You manage Sample User's personal knowledge vault\.$/m);
  assert.doesNotMatch(rendered, /^You are Alfred\./m);
});

test('render-persona.sh --apply refuses hand-authored AGENTS.md unless adopted', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-adopt-'));
  fs.writeFileSync(path.join(vault, '.alfred.yml'), [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'assistant:',
    '  name: Minerva',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(vault, 'AGENTS.md'), '# Hand-authored\n');

  assert.throws(() => {
    execFileSync(path.join(REPO_ROOT, 'tools', 'render-persona.sh'), [
      '--vault',
      vault,
      '--apply',
    ], { encoding: 'utf8', stdio: 'pipe' });
  }, (err) => {
    assert.equal(err.status, 3);
    assert.match(String(err.stderr), /REFUSING to overwrite hand-authored/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8'), '# Hand-authored\n');
  assert.ok(fs.existsSync(path.join(vault, 'AGENTS.rendered.md')));

  execFileSync(path.join(REPO_ROOT, 'tools', 'render-persona.sh'), [
    '--vault',
    vault,
    '--apply',
    '--adopt-generated-persona',
  ], { encoding: 'utf8' });
  const adopted = fs.readFileSync(path.join(vault, 'AGENTS.md'), 'utf8');
  assert.match(adopted, /GENERATED FILE - do not edit AGENTS\.md directly/);
  assert.match(adopted, /^# Minerva — Sample User's personal agent$/m);
  assert.ok(!fs.existsSync(path.join(vault, 'AGENTS.rendered.md')));
});

test('render-persona.sh --check detects stale and current generated AGENTS.md', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-check-'));
  fs.writeFileSync(path.join(vault, '.alfred.yml'), [
    'user:',
    '  slug: sample-user',
    '  name: Sample User',
    'assistant:',
    '  name: Minerva',
    '',
  ].join('\n'));

  assert.throws(() => {
    execFileSync(path.join(REPO_ROOT, 'tools', 'render-persona.sh'), [
      '--vault',
      vault,
      '--check',
    ], { encoding: 'utf8', stdio: 'pipe' });
  }, (err) => {
    assert.equal(err.status, 1);
    assert.match(String(err.stdout), /AGENTS\.md is stale or missing/);
    return true;
  });

  execFileSync(path.join(REPO_ROOT, 'tools', 'render-persona.sh'), [
    '--vault',
    vault,
    '--apply',
  ], { encoding: 'utf8' });
  const checked = execFileSync(path.join(REPO_ROOT, 'tools', 'render-persona.sh'), [
    '--vault',
    vault,
    '--check',
  ], { encoding: 'utf8' });
  assert.match(checked, /AGENTS\.md is up to date/);
});
