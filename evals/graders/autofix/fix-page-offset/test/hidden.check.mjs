import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageOf } from '../src/pages.mjs';

const list = [1, 2, 3, 4, 5];

test('page 1 starts at the first item', () => {
  assert.deepEqual(pageOf(list, 1, 2), [1, 2]);
});

test('page 2 follows page 1', () => {
  assert.deepEqual(pageOf(list, 2, 2), [3, 4]);
});

test('the last page is partial', () => {
  assert.deepEqual(pageOf(list, 3, 2), [5]);
});

test('a page past the end is empty', () => {
  assert.deepEqual(pageOf(list, 4, 2), []);
});
