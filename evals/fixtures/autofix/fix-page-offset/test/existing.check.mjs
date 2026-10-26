import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageOf } from '../src/pages.mjs';

test('a page never holds more than size items', () => {
  assert.ok(pageOf([1, 2, 3, 4, 5], 1, 2).length <= 2);
});
