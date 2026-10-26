import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemName } from '../src/inventory.mjs';

test('an unknown id gives null', () => {
  assert.equal(itemName([{ id: 1, name: 'bolt' }], 2), null);
});

test('an empty list gives null', () => {
  assert.equal(itemName([], 1), null);
});

test('a known id still gives its name', () => {
  assert.equal(itemName([{ id: 1, name: 'bolt' }, { id: 2, name: 'nut' }], 2), 'nut');
});
