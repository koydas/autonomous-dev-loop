import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

test('zero stays zero inside the range', () => {
  assert.equal(clamp(0, 0, 10), 0);
});
