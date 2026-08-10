const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const {
  tokenizeSearchQuery,
  searchPagesLexical,
} = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'search-fallback.js'));

test('tokenizeSearchQuery keeps useful terms and drops common filler', () => {
  assert.deepEqual(tokenizeSearchQuery('What about AI and deliberate practice?'), ['ai', 'deliberate', 'practice']);
});

test('searchPagesLexical ranks title and alias matches above body-only matches', () => {
  const rows = searchPagesLexical([
    {
      slug: 'body-only',
      fm: { title: 'Generic note', tags: ['research'] },
      body: 'Markov chain Monte Carlo appears in the body.',
    },
    {
      slug: 'mcmc',
      fm: { title: 'MCMC', aliases: ['Markov chain Monte Carlo'], tags: ['research'] },
      body: 'Sampling methods.',
    },
  ], { query: 'Markov chain Monte Carlo', limit: 5 });

  assert.equal(rows[0].slug, 'mcmc');
  assert.equal(rows[1].slug, 'body-only');
});

test('searchPagesLexical respects boolean tag expressions', () => {
  const rows = searchPagesLexical([
    { slug: 'keep-a', fm: { title: 'A', tags: ['research'] }, body: 'zinkozaurus' },
    { slug: 'keep-b', fm: { title: 'B', tags: ['health'] }, body: 'zinkozaurus' },
    { slug: 'drop', fm: { title: 'C', tags: ['research', 'tool'] }, body: 'zinkozaurus' },
  ], { query: 'zinkozaurus', tag: 'research OR health, NOT tool', limit: 10 });

  assert.deepEqual(rows.map((r) => r.slug), ['keep-a', 'keep-b']);
});

test('searchPagesLexical hides completed todos by doneSet', () => {
  const rows = searchPagesLexical([
    { slug: 'open-task', fm: { title: 'Open', tags: ['todo'] }, body: 'book hotel' },
    { slug: 'done-task', fm: { title: 'Done', tags: ['todo'] }, body: 'book hotel' },
  ], { query: 'book hotel', limit: 10, doneSet: new Set(['done-task']) });

  assert.deepEqual(rows.map((r) => r.slug), ['open-task']);
});

test('searchPagesLexical ignores text that occurs only inside retired observations', () => {
  const rows = searchPagesLexical([
    {
      slug: 'retired-only',
      fm: { title: 'Retired only', tags: ['research'] },
      body: '- ~~[fact] quokkasentinel appeared here <!--obs:old111-->~~ [until 2026-08-10]',
    },
    {
      slug: 'active-hit',
      fm: { title: 'Active hit', tags: ['research'] },
      body: '- [fact] quokkasentinel appears here now <!--obs:new111-->',
    },
  ], { query: 'quokkasentinel', limit: 10 });

  assert.deepEqual(rows.map((r) => r.slug), ['active-hit']);
});
