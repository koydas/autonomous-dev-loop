import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWithBackoff } from '../lib/retry.mjs';

const FAST = { baseDelayMs: 1, maxDelayMs: 10, jitter: false };

test('returns value immediately when fn succeeds on the first attempt', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => { calls++; return 42; }, FAST);
  assert.equal(result, 42);
  assert.equal(calls, 1);
});

test('retries after a transient failure and returns on subsequent success', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    if (++calls < 3) throw new Error('transient');
    return 'recovered';
  }, { ...FAST, maxAttempts: 4 });
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('throws the last error after exhausting the default maxAttempts of 4', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => { calls++; throw new Error('always fails'); }, FAST),
    /always fails/,
  );
  assert.equal(calls, 4);
});

test('respects a custom maxAttempts option', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(async () => { calls++; throw new Error('x'); }, { ...FAST, maxAttempts: 2 }),
    /x/,
  );
  assert.equal(calls, 2);
});

test('bails immediately on the first attempt when error.retryable is false', async () => {
  let calls = 0;
  const err = Object.assign(new Error('permanent'), { retryable: false });
  await assert.rejects(
    () => retryWithBackoff(async () => { calls++; throw err; }, { ...FAST, maxAttempts: 4 }),
    /permanent/,
  );
  assert.equal(calls, 1);
});

test('honors error.waitMs: 0 and still retries', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    if (++calls < 2) throw Object.assign(new Error('wait zero'), { waitMs: 0 });
    return 'done';
  }, { ...FAST, maxAttempts: 3 });
  assert.equal(result, 'done');
  assert.equal(calls, 2);
});

test('caps computed delay at maxDelayMs so large baseDelayMs completes quickly', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    if (++calls < 3) throw new Error('capped');
    return 'capped-ok';
  }, { baseDelayMs: 5000, maxDelayMs: 1, jitter: false, maxAttempts: 4 });
  assert.equal(result, 'capped-ok');
  assert.equal(calls, 3);
});

test('jitter: true does not cause errors and still retries correctly', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    if (++calls < 2) throw new Error('jitter-fail');
    return 'jitter-ok';
  }, { baseDelayMs: 1, maxDelayMs: 5, jitter: true, maxAttempts: 3 });
  assert.equal(result, 'jitter-ok');
  assert.equal(calls, 2);
});

test('propagates the exact error thrown on the final attempt', async () => {
  const sentinel = Object.assign(new Error('sentinel'), { code: 'SPECIAL' });
  const thrown = await retryWithBackoff(
    async () => { throw sentinel; },
    { ...FAST, maxAttempts: 2 },
  ).catch((e) => e);
  assert.strictEqual(thrown, sentinel);
});
