import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQuery, cleanText, dedupeKey, MAX_LEN } from '../assets/js/validate.mjs';

test('cleans whitespace and control characters, caps length', () => {
  assert.equal(cleanText('  related\n\trates   ladder '), 'related rates ladder');
  assert.equal(cleanText('x'.repeat(500)).length, MAX_LEN);
});

test('accepts ordinary math searches', () => {
  for (const s of ['ladder sliding down a wall', 'integration by parts ln x', 'taylor series e^x around 0',
    'math 125 final 2023 problem 4', 'solve y\'\' + 4y = 0', 'limit as x -> 0 of sin(3x)/x', 'eigenvalues 3x3 matrix']) {
    assert.ok(checkQuery(s).ok, s);
  }
});

test('rejects emails and phone numbers', () => {
  for (const s of ['email me at jane.doe@uw.edu', 'jane @ gmail.com', 'text me 206-555-1234', 'call (206) 555 1234', '+1 206 555 1234', '2065551234']) {
    assert.equal(checkQuery(s).ok, false, s);
  }
});

test('rejects too short, no letters, and duplicates', () => {
  assert.equal(checkQuery(' a ').ok, false);
  assert.equal(checkQuery('12 + 34').ok, false);
  const seen = new Set([dedupeKey('Related rates, ladder!')]);
  assert.equal(checkQuery('related   rates ladder', seen).ok, false);
  assert.ok(checkQuery('related rates cone', seen).ok);
});
