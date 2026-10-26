import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

test('a value inside the range is kept', () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test('a value below min gives min', () => {
  assert.equal(clamp(-3, 0, 10), 0);
});

test('a value above max gives max', () => {
  assert.equal(clamp(42, 0, 10), 10);
});
