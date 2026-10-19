import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryWithBackoff, parseRetryAfterMs, transientHttpError, MAX_RETRY_AFTER_MS, isRetrySafeGitHubRequest } from '../lib/retry.mjs';

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

test('parseRetryAfterMs converts delta-seconds to milliseconds', () => {
  assert.equal(parseRetryAfterMs('3'), 3000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs('1.5'), 1500);
});

test('parseRetryAfterMs converts an HTTP-date relative to now', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
});

test('parseRetryAfterMs clamps a past HTTP-date to 0', () => {
  const now = Date.parse('2026-01-01T00:00:10Z');
  assert.equal(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:05 GMT', now), 0);
});

test('parseRetryAfterMs returns undefined for missing, empty, negative or garbage values', () => {
  for (const value of [null, undefined, '', '   ', '-1', 'soon']) {
    assert.equal(parseRetryAfterMs(value), undefined, `value=${JSON.stringify(value)}`);
  }
});

function fakeResponse(status, headers = {}) {
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null } };
}

test('transientHttpError returns null for non-transient statuses', () => {
  for (const status of [200, 201, 204, 301, 400, 401, 403, 404, 409, 422]) {
    assert.equal(transientHttpError(fakeResponse(status), 'ctx'), null, `status ${status}`);
  }
});

test('transientHttpError returns a retryable error for 429 and 5xx', () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const err = transientHttpError(fakeResponse(status), 'GitHub API (/x)');
    assert.ok(err instanceof Error, `status ${status}`);
    assert.equal(err.status, status);
    assert.notEqual(err.retryable, false);
    assert.equal(err.waitMs, undefined, 'no Retry-After => default backoff');
    assert.match(err.message, new RegExp(`GitHub API \\(/x\\).*${status}`));
  }
});

test('transientHttpError carries Retry-After as waitMs', () => {
  const err = transientHttpError(fakeResponse(429, { 'retry-after': '2' }), 'ctx');
  assert.equal(err.waitMs, 2000);
  assert.notEqual(err.retryable, false);
});

test('transientHttpError gives up when Retry-After exceeds the wait budget', () => {
  const err = transientHttpError(fakeResponse(429, { 'retry-after': String(MAX_RETRY_AFTER_MS / 1000 + 1) }), 'ctx');
  assert.equal(err.retryable, false, 'a wait the job timeout cannot absorb must not be retried');
});

test('transientHttpError honors a custom maxRetryAfterMs', () => {
  const res = fakeResponse(503, { 'retry-after': '5' });
  assert.equal(transientHttpError(res, 'ctx', { maxRetryAfterMs: 1000 }).retryable, false);
  assert.notEqual(transientHttpError(res, 'ctx', { maxRetryAfterMs: 5000 }).retryable, false);
});

test('isRetrySafeGitHubRequest treats GET/HEAD/PUT/PATCH/DELETE as retry-safe', () => {
  for (const method of [undefined, 'GET', 'get', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isRetrySafeGitHubRequest(method, '/repos/o/r/issues/1/comments'), true, `method ${method}`);
  }
});

test('isRetrySafeGitHubRequest treats label POSTs as retry-safe (422 on duplicate / set union)', () => {
  assert.equal(isRetrySafeGitHubRequest('POST', '/repos/o/r/labels'), true);
  assert.equal(isRetrySafeGitHubRequest('POST', '/repos/o/r/issues/5/labels'), true);
});

test('isRetrySafeGitHubRequest treats comment and review POSTs as not retry-safe', () => {
  assert.equal(isRetrySafeGitHubRequest('POST', '/repos/o/r/issues/5/comments'), false);
  assert.equal(isRetrySafeGitHubRequest('POST', '/repos/o/r/pulls/5/reviews'), false);
  assert.equal(isRetrySafeGitHubRequest('POST', '/repos/o/r/labels/extra'), false);
});

test('transientHttpError does not retry 5xx for non-retry-safe requests', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.equal(transientHttpError(fakeResponse(status), 'ctx', { retrySafe: false }).retryable, false, `status ${status}`);
  }
});

test('transientHttpError still retries 429 for non-retry-safe requests (rejected before processing)', () => {
  assert.notEqual(transientHttpError(fakeResponse(429), 'ctx', { retrySafe: false }).retryable, false);
});

// #134: deterministic backoff and AbortError handling, node:test fake timers (no real waits).
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('retryWithBackoff waits exactly 200/400/800 ms (baseDelayMs 200, maxAttempts 4, no jitter), then throws with no further delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const failure = Object.assign(new Error('upstream 503'), { status: 503 });
  const run = retryWithBackoff(async () => { calls++; throw failure; }, { baseDelayMs: 200, maxAttempts: 4, jitter: false });
  const outcome = run.then(() => 'resolved', (err) => err);
  await settle();
  assert.equal(calls, 1);
  for (const delay of [200, 400, 800]) {
    const before = calls;
    t.mock.timers.tick(delay - 1);
    await settle();
    assert.equal(calls, before, `no attempt before ${delay} ms`);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(calls, before + 1, `next attempt at exactly ${delay} ms`);
  }
  assert.equal(await outcome, failure);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(calls, 4, 'no fifth attempt');
});

test('retryWithBackoff counts a retryable AbortError as one failed attempt and retries it per policy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const run = retryWithBackoff(async () => {
    if (++calls === 1) throw Object.assign(new DOMException('This operation was aborted', 'AbortError'), { retryable: true });
    return 'ok';
  }, { baseDelayMs: 200, maxAttempts: 4, jitter: false });
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(200);
  assert.equal(await run, 'ok');
  assert.equal(calls, 2);
});

test('retryWithBackoff exhausts maxAttempts on a persistent retryable AbortError and rethrows it', async () => {
  let calls = 0;
  const abort = new DOMException('This operation was aborted', 'AbortError');
  await assert.rejects(
    () => retryWithBackoff(async () => { calls++; throw abort; }, { ...FAST, maxAttempts: 3 }),
    (err) => err === abort && err.name === 'AbortError',
  );
  assert.equal(calls, 3);
});
