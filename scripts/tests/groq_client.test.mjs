import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callGroq } from '../lib/groq_client.mjs';

const BASE_ARGS = { prompt: 'go', systemPrompt: 'You are a test assistant.', apiKey: 'key', model: 'llama-3.1-8b-instant', apiUrl: 'https://api.test' };

function makeResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function mockFetch(response) {
  globalThis.fetch = async () => response;
}

afterEach(() => { delete globalThis.fetch; });

test('callGroq returns raw content string on success', async () => {
  const aiContent = { summary: 'S', target_path: 'a.md', file_content: 'hello' };
  const contentStr = JSON.stringify(aiContent);
  mockFetch(makeResponse({
    choices: [{ message: { content: contentStr } }],
  }));
  const result = await callGroq(BASE_ARGS);
  assert.equal(result, contentStr);
});

test('callGroq throws on HTTP error status', async () => {
  mockFetch(makeResponse('Unauthorized', 401));
  await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 401/);
});

test('callGroq throws when response body is not JSON', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not-json' });
  await assert.rejects(() => callGroq(BASE_ARGS), /non-JSON response/);
});

test('callGroq throws when choices array is missing', async () => {
  mockFetch(makeResponse({ choices: [] }));
  await assert.rejects(() => callGroq(BASE_ARGS), /Unexpected Groq API response format/);
});

test('callGroq throws when message content is missing', async () => {
  mockFetch(makeResponse({ choices: [{ message: {} }] }));
  await assert.rejects(() => callGroq(BASE_ARGS), /Unexpected Groq API response format/);
});

test('callGroq sends correct Authorization header', async () => {
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq(BASE_ARGS);
  assert.equal(capturedHeaders['Authorization'], 'Bearer key');
});

test('callGroq sends temperature 0 in payload by default', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq(BASE_ARGS);
  assert.equal(capturedBody.temperature, 0);
});

test('callGroq sends custom temperature when provided', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq({ ...BASE_ARGS, temperature: 0.2 });
  assert.equal(capturedBody.temperature, 0.2);
});

test('callGroq omits response_format when responseFormat is null', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: 'review text' } }] });
  };
  await callGroq({ ...BASE_ARGS, responseFormat: null });
  assert.equal('response_format' in capturedBody, false);
});

test('callGroq includes response_format by default', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq(BASE_ARGS);
  assert.deepEqual(capturedBody.response_format, { type: 'json_object' });
});

test('callGroq sends max_tokens when maxTokens is provided', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq({ ...BASE_ARGS, maxTokens: 16384 });
  assert.equal(capturedBody.max_tokens, 16384);
});

test('callGroq omits max_tokens when maxTokens is not provided', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq(BASE_ARGS);
  assert.equal('max_tokens' in capturedBody, false);
});

test('callGroq retries on 429 and succeeds on next attempt', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return makeResponse('Please try again in 0s', 429);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  const result = await callGroq(BASE_ARGS);
  assert.equal(result, '{}');
  assert.equal(calls, 2);
});

test('callGroq retries on 429 with Retry-After header', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return makeResponse('rate limited', 429, { 'Retry-After': '0' });
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  const result = await callGroq(BASE_ARGS);
  assert.equal(result, '{}');
  assert.equal(calls, 2);
});

test('callGroq exhausts retries on persistent 429 and throws', async () => {
  process.env.GROQ_MAX_RETRIES = '1';
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return makeResponse('Please try again in 0s', 429);
    };
    await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 429/);
    assert.equal(calls, 2);
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq uses Retry-After header seconds value as wait delay', async () => {
  const waits = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); fn(); return {}; };

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return makeResponse('rate limited', 429, { 'Retry-After': '3' });
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  process.env.GROQ_MAX_RETRIES = '1';
  try {
    await callGroq({ ...BASE_ARGS, responseFormat: null });
    assert.equal(waits[0], 3000);
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
    globalThis.setTimeout = origSetTimeout;
  }
});

test('callGroq retries when fetch throws a network error', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  process.env.GROQ_MAX_RETRIES = '1';
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError('fetch failed');
    return makeResponse({ choices: [{ message: { content: 'recovered' } }] });
  };
  try {
    assert.equal(await callGroq(BASE_ARGS), 'recovered');
    assert.equal(calls, 2);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq rethrows the network error after exhausting retries', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  process.env.GROQ_MAX_RETRIES = '1';
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(() => callGroq(BASE_ARGS), /fetch failed/);
    assert.equal(calls, 2);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq gives up instead of waiting out a rate-limit hint beyond the retry budget', async () => {
  const waits = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); fn(); return {}; };
  process.env.GROQ_MAX_RETRIES = '3';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return makeResponse('Rate limit reached. Please try again in 75.5s', 429);
  };
  try {
    await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 429/);
    assert.equal(calls, 1, 'a 75 s wait exceeds the budget: fail fast so callLLM can fall back');
    assert.deepEqual(waits, []);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq gives up when the Retry-After header exceeds the retry budget', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  process.env.GROQ_MAX_RETRIES = '3';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return makeResponse('rate limited', 429, { 'Retry-After': '90' });
  };
  try {
    await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 429/);
    assert.equal(calls, 1);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq waits out a normal TPM rate-limit hint (12.5 s) by default', async () => {
  const waits = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); fn(); return {}; };
  process.env.GROQ_MAX_RETRIES = '1';
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) return makeResponse('Rate limit reached. Please try again in 12.5s', 429);
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  try {
    assert.equal(await callGroq(BASE_ARGS), 'ok');
    assert.deepEqual(waits, [12500]);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq honors LLM_MAX_RETRY_WAIT_MS for short-timeout jobs', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  process.env.GROQ_MAX_RETRIES = '1';
  process.env.LLM_MAX_RETRY_WAIT_MS = '10000';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse('Please try again in 12.5s', 429); };
  try {
    await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 429/);
    assert.equal(calls, 1);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete process.env.GROQ_MAX_RETRIES;
    delete process.env.LLM_MAX_RETRY_WAIT_MS;
  }
});

// ADR-0028: Groq answers 413 rate_limit_exceeded when the org-wide TPM budget is momentarily
// spent (run 37174238930); the same request passed 48 s later.
const TPM_413 = { error: { message: 'Request too large for model: Limit 8000, Requested 8521', type: 'tokens', code: 'rate_limit_exceeded' } };

function withRecordedWaits(fn) {
  return async () => {
    const waits = [];
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (cb, ms) => { waits.push(ms); cb(); return {}; };
    try {
      await fn(waits);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      delete process.env.GROQ_MAX_RETRIES;
      delete process.env.LLM_MAX_RETRY_WAIT_MS;
    }
  };
}

test('callGroq retries a 413 rate_limit_exceeded (TPM window spent) and waits one TPM window', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '3';
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? makeResponse(TPM_413, 413) : makeResponse({ choices: [{ message: { content: 'ok' } }] }));
  assert.equal(await callGroq(BASE_ARGS), 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [60000]);
}));

test('callGroq does not retry a 413 without the rate_limit_exceeded code', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '3';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse({ error: { message: 'Payload too large', code: 'request_too_large' } }, 413); };
  await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 413/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
}));

test('callGroq does not retry a 413 whose body is not JSON', withRecordedWaits(async () => {
  process.env.GROQ_MAX_RETRIES = '3';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse('<html>413 Request Entity Too Large</html>', 413); };
  await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 413/);
  assert.equal(calls, 1);
}));

test('callGroq waits a full TPM window (60 s) on a 429 without wait hint, not the short backoff', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '2';
  let calls = 0;
  globalThis.fetch = async () => (++calls <= 2 ? makeResponse('rate limited', 429) : makeResponse({ choices: [{ message: { content: 'ok' } }] }));
  assert.equal(await callGroq(BASE_ARGS), 'ok');
  assert.deepEqual(waits, [60000, 60000]);
}));

test('callGroq keeps the server hint over the TPM-window default on a 413 rate limit', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '1';
  let calls = 0;
  const body = { error: { ...TPM_413.error, message: `${TPM_413.error.message}. Please try again in 31.5s` } };
  globalThis.fetch = async () => (++calls === 1 ? makeResponse(body, 413) : makeResponse({ choices: [{ message: { content: 'ok' } }] }));
  assert.equal(await callGroq(BASE_ARGS), 'ok');
  assert.deepEqual(waits, [31500]);
}));

test('callGroq does not retry a hint-less rate limit when the TPM window exceeds LLM_MAX_RETRY_WAIT_MS', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '3';
  process.env.LLM_MAX_RETRY_WAIT_MS = '45000';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse(TPM_413, 413); };
  await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 413/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
}));

test('callGroq gives up after GROQ_MAX_RETRIES TPM-window waits on a persistent 413 rate limit', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '4';
  process.env.LLM_MAX_RETRY_WAIT_MS = '60000';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse(TPM_413, 413); };
  await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 413/);
  assert.equal(calls, 5);
  assert.deepEqual(waits, [60000, 60000, 60000, 60000]);
}));

test('callGroq sends reasoning_effort when reasoningEffort is set', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq({ ...BASE_ARGS, reasoningEffort: 'low' });
  assert.equal(capturedBody.reasoning_effort, 'low');
});

test('callGroq omits reasoning_effort when reasoningEffort is not set (non-reasoning models reject it)', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  await callGroq(BASE_ARGS);
  assert.equal('reasoning_effort' in capturedBody, false);
});

test('callGroq sets status on HTTP errors', async () => {
  globalThis.fetch = async () => makeResponse('model not found', 404);
  await assert.rejects(
    () => callGroq({ prompt: 'p', systemPrompt: 's', apiKey: 'k', model: 'm', apiUrl: 'https://api.groq.com/openai/v1/chat/completions' }),
    (err) => err.status === 404,
  );
});

// #150: Groq's structured error code on a response_format JSON validation failure.
const JSON_VALIDATE_400 = { error: { code: 'json_validate_failed', message: 'invalid generated JSON' } };

test('callGroq attaches code json_validate_failed, status 400, retryable false, after exactly one request', withRecordedWaits(async (waits) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse(JSON_VALIDATE_400, 400); };
  await assert.rejects(() => callGroq(BASE_ARGS), (err) => {
    assert.equal(err.code, 'json_validate_failed');
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
}));

test('callGroq keeps a 400 with a malformed (non-JSON) body non-retryable and without a code', withRecordedWaits(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse('<html>Bad Request</html>', 400); };
  await assert.rejects(() => callGroq(BASE_ARGS), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.retryable, false);
    assert.equal(err.code, undefined);
    return true;
  });
  assert.equal(calls, 1);
}));

test('callGroq keeps any other 400 non-retryable: no code field, or a code that is not a plain identifier, is not attached', withRecordedWaits(async () => {
  for (const body of [
    { error: { message: 'unsupported parameter', type: 'invalid_request_error' } },
    { error: { code: 'contains spaces and {"body":"text"}', message: 'x' } },
    { error: { code: 42 } },
  ]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return makeResponse(body, 400); };
    await assert.rejects(() => callGroq(BASE_ARGS), (err) => {
      assert.equal(err.retryable, false);
      assert.equal(err.code, undefined, JSON.stringify(body));
      return true;
    });
    assert.equal(calls, 1);
  }
}));

test('callGroq still retries a 5xx whose body carries a code (the code does not change the retry policy)', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '1';
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? makeResponse({ error: { code: 'service_unavailable' } }, 503) : makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  assert.equal(await callGroq(BASE_ARGS), 'ok');
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
}));

// #134: failure injection on the current retry policy (GROQ_MAX_RETRIES default 3 → 4 attempts).
for (const status of [500, 502, 503, 504]) {
  test(`callGroq retries a persistent HTTP ${status} exactly maxAttempts (4) times, then throws`, withRecordedWaits(async (waits) => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return makeResponse('upstream error', status); };
    await assert.rejects(() => callGroq(BASE_ARGS), (err) => err.status === status && err.message.includes(`HTTP error ${status}`));
    assert.equal(calls, 4);
    assert.equal(waits.length, 3, 'one backoff between attempts, none after the last');
  }));
}

test('callGroq retries a retryable AbortError (fetch aborted) as one failed attempt', withRecordedWaits(async (waits) => {
  process.env.GROQ_MAX_RETRIES = '3';
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new DOMException('This operation was aborted', 'AbortError');
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  assert.equal(await callGroq(BASE_ARGS), 'ok');
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
}));

test('callGroq waits out Retry-After (3 s) on fake timers: no request before 3000 ms, the retry at 3000 ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  process.env.GROQ_MAX_RETRIES = '1';
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? makeResponse('rate limited', 429, { 'Retry-After': '3' }) : makeResponse({ choices: [{ message: { content: '{}' } }] });
  };
  try {
    const run = callGroq(BASE_ARGS);
    await settle();
    assert.equal(calls, 1);
    t.mock.timers.tick(2999);
    await settle();
    assert.equal(calls, 1, 'no retry before Retry-After');
    t.mock.timers.tick(1);
    assert.equal(await run, '{}');
    assert.equal(calls, 2);
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

// ADR-0041 amendment: measured usage through onUsage.
test('groqUsage: prompt_tokens already include the cached ones; missing or malformed usage → null', async () => {
  const { groqUsage } = await import('../lib/groq_client.mjs');
  assert.deepEqual(groqUsage({ usage: { prompt_tokens: 900, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 300 } } }), { input: 900, output: 120, cache_read: 300, cache_write: 0 });
  assert.deepEqual(groqUsage({ usage: { prompt_tokens: 9, completion_tokens: 1 } }), { input: 9, output: 1, cache_read: 0, cache_write: 0 });
  assert.equal(groqUsage({}), null);
  assert.equal(groqUsage({ usage: null }), null);
  assert.equal(groqUsage({ usage: { prompt_tokens: 9 } }), null);
});

test('callGroq reports the usage through onUsage, before the content check', async () => {
  const seen = [];
  mockFetch(makeResponse({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
  assert.equal(await callGroq({ ...BASE_ARGS, onUsage: (u) => seen.push(u) }), 'ok');
  mockFetch(makeResponse({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 50, completion_tokens: 0 } }));
  await assert.rejects(() => callGroq({ ...BASE_ARGS, onUsage: (u) => seen.push(u) }), /Unexpected Groq API response format/);
  assert.deepEqual(seen.map((u) => u.output), [5, 0]);
  mockFetch(makeResponse({ choices: [{ message: { content: 'ok' } }] }));
  assert.equal(await callGroq({ ...BASE_ARGS, onUsage: (u) => seen.push(u) }), 'ok');
  assert.equal(seen.length, 2, 'no usage in the response: no report');
});

test('groqUsage rejects malformed counts instead of coercing them', async () => {
  const { groqUsage } = await import('../lib/groq_client.mjs');
  for (const usage of [
    { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 1, completion_tokens: 0.5 },
    { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 11 } },
  ]) assert.equal(groqUsage({ usage }), null, JSON.stringify(usage));
  assert.equal(groqUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: null } } }).cache_read, 0);
});
