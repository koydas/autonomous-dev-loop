import { test } from 'node:test';
import assert from 'node:assert/strict';

// The subject is in the fixture copy this file is graded in (no src/ beside it here), so it is loaded at run time.
const { clamp } = await import(new URL('../src/clamp.mjs', import.meta.url));

test('a value inside the range is kept', () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test('a value below min gives min', () => {
  assert.equal(clamp(-3, 0, 10), 0);
});

test('a value above max gives max', () => {
  assert.equal(clamp(42, 0, 10), 10);
});
