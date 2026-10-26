import { test } from 'node:test';
import assert from 'node:assert/strict';

// The subject is in the fixture copy this file is graded in (no src/ beside it here), so it is loaded at run time.
const { itemName } = await import(new URL('../src/inventory.mjs', import.meta.url));

test('an unknown id gives null', () => {
  assert.equal(itemName([{ id: 1, name: 'bolt' }], 2), null);
});

test('an empty list gives null', () => {
  assert.equal(itemName([], 1), null);
});

test('a known id still gives its name', () => {
  assert.equal(itemName([{ id: 1, name: 'bolt' }, { id: 2, name: 'nut' }], 2), 'nut');
});
