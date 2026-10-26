import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemName } from '../src/inventory.mjs';

test('returns the name of a known item', () => {
  assert.equal(itemName([{ id: 1, name: 'bolt' }], 1), 'bolt');
});
