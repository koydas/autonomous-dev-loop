import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../src/load.mjs';

test('returns one entry per id', async () => {
  const out = await loadAll([1, 2], async (id) => id * 2);
  assert.equal(out.length, 2);
});
