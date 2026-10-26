import { test } from 'node:test';
import assert from 'node:assert/strict';

// The subject is in the fixture copy this file is graded in (no src/ beside it here), so it is loaded at run time.
const { loadAll } = await import(new URL('../src/load.mjs', import.meta.url));

test('entries are resolved objects', async () => {
  const out = await loadAll([1, 2], async (id) => id * 10);
  assert.deepEqual(out, [{ id: 1, value: 10 }, { id: 2, value: 20 }]);
});

test('the order follows the ids even when a later id finishes first', async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const out = await loadAll([1, 2], async (id) => { await delay(id === 1 ? 30 : 1); return id; });
  assert.deepEqual(out.map((entry) => entry.id), [1, 2]);
});
