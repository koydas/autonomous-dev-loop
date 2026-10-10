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
