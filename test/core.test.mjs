import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/capture.mjs';
import { classifyElement, inScope } from '../src/explore.mjs';
import { normalizeUrl } from '../src/identity.mjs';

test('URL normalization strips fragments, sorts queries, and replaces record ids', () => {
  assert.equal(
    normalizeUrl('https://app.example.com/records/123?z=2&a=hello&id=550e8400-e29b-41d4-a716-446655440000#tab'),
    'https://app.example.com/records/:id?a=hello&id=%3Aid&z=%3Aid',
  );
});

test('scope checks exact hosts and proper subdomains only', () => {
  assert.equal(inScope('https://app.example.com/path', 'https://example.com'), true);
  assert.equal(inScope('https://example.com/path', 'https://example.com'), true);
  assert.equal(inScope('https://badexample.com/path', 'https://example.com'), false);
  assert.equal(inScope('javascript:alert(1)', 'https://example.com'), false);
});

test('do-not-click classification catches destructive and payment context', () => {
  const base = {
    href: null,
    tag: 'button',
    type: 'submit',
    name: '',
    formTypes: [],
  };
  assert.equal(classifyElement({ ...base, text: 'Log out', context: '' }, 'https://example.com'), 'destructive-floor');
  assert.equal(classifyElement({
    ...base,
    text: 'Confirm',
    context: 'Enter card number and CVC',
    formTypes: ['text'],
  }, 'https://example.com'), 'destructive-floor');
  assert.equal(classifyElement({ ...base, text: 'Add plan', context: '' }, 'https://example.com'), null);
});

test('CLI parsing validates and supplies defaults', () => {
  const options = parseArgs(['localhost:3000', '--explore', '--budget', '30', '--delay', '0']);
  assert.equal(options.url, 'http://localhost:3000/');
  assert.equal(options.explore, true);
  assert.equal(options.budget, 30);
  assert.throws(() => parseArgs(['example.com', '--budget', '-1']), /non-negative integer/);
});
