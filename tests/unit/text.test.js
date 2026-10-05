// Unit tests for bin/lib/text.js.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { foldDiacritics, nameKey, slugifyText } = require(path.resolve(__dirname, '..', '..', 'bin', 'lib', 'text.js'));

test('foldDiacritics: strips accents, keeps base letters and case', () => {
  assert.equal(foldDiacritics('Renée Dufrêne-Ölander'), 'Renee Dufrene-Olander');
  assert.equal(foldDiacritics('Göttingen'), 'Gottingen');
});

test('foldDiacritics: precomposed and decomposed input fold the same', () => {
  assert.equal(foldDiacritics('é'), foldDiacritics('é'));
});

test('nameKey: accented hyphenated name equals its slug form', () => {
  assert.equal(nameKey('Renée Dufrêne-Ölander'), nameKey('renee-dufrene-olander'));
  assert.equal(nameKey('  Renée   Dufrêne '), 'renee dufrene');
});

test('slugifyText: folds accents instead of dropping letters', () => {
  assert.equal(slugifyText('Renée Dufrêne-Ölander'), 'renee-dufrene-olander');
  assert.equal(slugifyText('Café booking (Göttingen)!'), 'cafe-booking-gottingen');
  assert.equal(slugifyText(''), '');
  assert.equal(slugifyText(null), '');
});
