import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callAnthropic } from '../lib/anthropic_client.mjs';

const BASE_ARGS = {
  prompt: 'go',
  systemPrompt: 'You are a test assistant.',
  apiKey: 'sk-ant-test',
  model: 'claude-opus-4-7',
};

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function mockFetch(response) {
  globalThis.fetch = async () => response;
}

afterEach(() => { delete globalThis.fetch; });

test('callAnthropic returns text content on success', async () => {
  mockFetch(makeResponse({ content: [{ type: 'text', text: '{"foo":"bar"}' }] }));
  const result = await callAnthropic(BASE_ARGS);
  assert.equal(result, '{"foo":"bar"}');
});

test('callAnthropic throws on HTTP error status', async () => {
  mockFetch(makeResponse('Unauthorized', 401));
  await assert.rejects(() => callAnthropic(BASE_ARGS), /Anthropic API HTTP error 401/);
});

test('callAnthropic throws when response body is not JSON', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not-json' });
  await assert.rejects(() => callAnthropic(BASE_ARGS), /non-JSON response/);
});

test('callAnthropic throws when content array is empty', async () => {
  mockFetch(makeResponse({ content: [] }));
  await assert.rejects(() => callAnthropic(BASE_ARGS), /Unexpected Anthropic API response format/);
});

test('callAnthropic throws when content text is missing', async () => {
  mockFetch(makeResponse({ content: [{ type: 'text' }] }));
  await assert.rejects(() => callAnthropic(BASE_ARGS), /Unexpected Anthropic API response format/);
});

test('callAnthropic sends correct x-api-key header', async () => {
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic(BASE_ARGS);
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-test');
});

test('callAnthropic sends anthropic-version header', async () => {
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic(BASE_ARGS);
  assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
});

test('callAnthropic sends no temperature by default (rejected by Opus 4.7+ / 5.x)', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic(BASE_ARGS);
  assert.equal('temperature' in capturedBody, false);
});

test('callAnthropic sends temperature when a caller sets one explicitly', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic({ ...BASE_ARGS, model: 'claude-haiku-4-5', temperature: 0.2 });
  assert.equal(capturedBody.temperature, 0.2);
});

test('callAnthropic sends system prompt as a cacheable text block', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic(BASE_ARGS);
  assert.ok(Array.isArray(capturedBody.system), 'system must be an array');
  assert.equal(capturedBody.system.length, 1);
  assert.equal(capturedBody.system[0].type, 'text');
  assert.equal(capturedBody.system[0].text, 'You are a test assistant.');
  assert.deepEqual(capturedBody.system[0].cache_control, { type: 'ephemeral' });
  assert.ok(Array.isArray(capturedBody.messages));
  assert.equal(capturedBody.messages[0].role, 'user');
  assert.equal(capturedBody.messages[0].content, 'go');
});

test('callAnthropic includes max_tokens in payload', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic({ ...BASE_ARGS, maxTokens: 1024 });
  assert.equal(capturedBody.max_tokens, 1024);
});

test('callAnthropic throws on fetch TypeError', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(() => callAnthropic(BASE_ARGS), /fetch failed/);
});

test('callAnthropic throws on fetch generic Error', async () => {
  globalThis.fetch = async () => { throw new Error('fetch error'); };
  await assert.rejects(() => callAnthropic(BASE_ARGS), /fetch error/);
});

test('callAnthropic retries when fetch throws a network error', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError('fetch failed');
    return makeResponse({ content: [{ type: 'text', text: 'recovered' }] });
  };
  try {
    assert.equal(await callAnthropic(BASE_ARGS), 'recovered');
    assert.equal(calls, 2);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('callAnthropic rethrows the network error after exhausting retries', async () => {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
  try {
    await assert.rejects(() => callAnthropic(BASE_ARGS), /fetch failed/);
    assert.equal(calls, 4);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('callAnthropic sends reasoningEffort as output_config.effort, never as reasoning_effort', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic({ ...BASE_ARGS, reasoningEffort: 'low' });
  assert.equal('reasoning_effort' in capturedBody, false);
  assert.equal('reasoningEffort' in capturedBody, false);
  assert.deepEqual(capturedBody.output_config, { effort: 'low' });
});

test('callAnthropic omits output_config when no effort is set', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic(BASE_ARGS);
  assert.equal('output_config' in capturedBody, false);
});

test('callAnthropic returns the first text block after thinking blocks', async () => {
  mockFetch(makeResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'answer' }] }));
  assert.equal(await callAnthropic(BASE_ARGS), 'answer');
});

test('callAnthropic throws on a refusal (HTTP 200, stop_reason refusal) with its category', async () => {
  mockFetch(makeResponse({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] }));
  await assert.rejects(() => callAnthropic(BASE_ARGS), /refused the request \(stop_reason: refusal, category: cyber\)/);
});

test('callAnthropic reports an unspecified refusal category when stop_details is null', async () => {
  mockFetch(makeResponse({ stop_reason: 'refusal', stop_details: null, content: [] }));
  await assert.rejects(() => callAnthropic(BASE_ARGS), /category: unspecified/);
});

test('callAnthropic throws on a response truncated at max_tokens, even with partial text', async () => {
  mockFetch(makeResponse({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"partial":' }] }));
  await assert.rejects(() => callAnthropic({ ...BASE_ARGS, maxTokens: 16000 }), /truncated \(stop_reason: max_tokens, max_tokens: 16000\)/);
});

test('callAnthropic names the stop_reason when no text block comes back', async () => {
  mockFetch(makeResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] }));
  await assert.rejects(() => callAnthropic(BASE_ARGS), /expected a non-empty text content block \(stop_reason: end_turn\)/);
});

test('callAnthropic retries a 529 overloaded response', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? makeResponse('{"type":"error","error":{"type":"overloaded_error"}}', 529) : makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  };
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  try {
    assert.equal(await callAnthropic(BASE_ARGS), 'ok');
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
  assert.equal(calls, 2);
});

test('callAnthropic opts into server-side refusal fallback for supported models on the Claude API', async () => {
  let capturedBody;
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    capturedHeaders = opts.headers;
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic({ ...BASE_ARGS, model: 'claude-opus-5-5' });
  assert.equal(capturedBody.fallbacks, 'default');
  assert.equal(capturedHeaders['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('callAnthropic sends no server-side fallback for other models or a custom API URL', async () => {
  const bodies = [];
  const headers = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    headers.push(opts.headers);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic({ ...BASE_ARGS, model: 'claude-haiku-5-5' });
  await callAnthropic({ ...BASE_ARGS, model: 'claude-fable-5' });
  await callAnthropic({ ...BASE_ARGS, model: 'claude-opus-5-5', apiUrl: 'https://proxy.example/v1/messages' });
  for (const [i, body] of bodies.entries()) {
    assert.equal('fallbacks' in body, false);
    assert.equal('anthropic-beta' in headers[i], false);
  }
});

// The per-stage defaults (config/models.yaml): effort in output_config, no sampling parameter, no `thinking`
// (adaptive when omitted), server-side refusal fallback where the model has one (Sonnet 5.5 yes, Haiku 5.5 no).
test('callAnthropic payload for the Sonnet 5.5 and Haiku 5.5 stage defaults', async () => {
  const sent = [];
  globalThis.fetch = async (_url, opts) => {
    sent.push({ body: JSON.parse(opts.body), headers: opts.headers });
    return makeResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'ok' }] });
  };
  assert.equal(await callAnthropic({ ...BASE_ARGS, model: 'claude-sonnet-5-5', reasoningEffort: 'medium' }), 'ok');
  assert.equal(await callAnthropic({ ...BASE_ARGS, model: 'claude-haiku-5-5', reasoningEffort: 'low' }), 'ok');
  const [sonnet, haiku] = sent;
  assert.deepEqual(sonnet.body.output_config, { effort: 'medium' });
  assert.deepEqual(haiku.body.output_config, { effort: 'low' });
  for (const { body } of sent) {
    assert.equal('temperature' in body, false);
    assert.equal('thinking' in body, false);
  }
  assert.equal(sonnet.body.fallbacks, 'default');
  assert.equal(sonnet.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal('fallbacks' in haiku.body, false);
});

test('callAnthropic does not retry a request that hit the fetch headers timeout', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
  };
  await assert.rejects(() => callAnthropic(BASE_ARGS), /fetch failed/);
  assert.equal(calls, 1);
});

test('callAnthropic sets status on HTTP errors', async () => {
  mockFetch(makeResponse('bad request', 400));
  await assert.rejects(() => callAnthropic(BASE_ARGS), (err) => err.status === 400);
});

// #134: failure injection on the current retry policy (default maxAttempts 4).
function withRecordedWaits(fn) {
  return async () => {
    const waits = [];
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (cb, ms) => { waits.push(ms); cb(); return {}; };
    try {
      await fn(waits);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  };
}

test('callAnthropic retries a 503 then returns the text of the successful response, after exactly two calls', withRecordedWaits(async (waits) => {
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? makeResponse('{"type":"error","error":{"type":"api_error"}}', 503)
    : makeResponse({ content: [{ type: 'text', text: 'recovered-text' }] }));
  assert.equal(await callAnthropic(BASE_ARGS), 'recovered-text');
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
}));

test('callAnthropic throws after exactly maxAttempts (4) calls on a persistent 503', withRecordedWaits(async (waits) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse('{"type":"error","error":{"type":"api_error"}}', 503); };
  await assert.rejects(() => callAnthropic(BASE_ARGS), (err) => err.status === 503 && err.retryable === true);
  assert.equal(calls, 4);
  assert.equal(waits.length, 3);
}));

test('callAnthropic makes exactly one call on a 401 (not retried)', withRecordedWaits(async (waits) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse('{"type":"error","error":{"type":"authentication_error"}}', 401); };
  await assert.rejects(() => callAnthropic(BASE_ARGS), (err) => err.status === 401 && err.retryable === false && err.errorType === 'PERMANENT');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
}));

test('callAnthropic retries a retryable AbortError (no fetch-timeout cause) as one failed attempt', withRecordedWaits(async (waits) => {
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new DOMException('This operation was aborted', 'AbortError');
    return makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  };
  assert.equal(await callAnthropic(BASE_ARGS), 'ok');
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
}));

test('callAnthropic rethrows a persistent AbortError after exactly maxAttempts (4) calls', withRecordedWaits(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new DOMException('This operation was aborted', 'AbortError'); };
  await assert.rejects(() => callAnthropic(BASE_ARGS), (err) => err.name === 'AbortError');
  assert.equal(calls, 4);
}));

// ADR-0041 amendment: the billed usage reaches the caller through onUsage, the return type stays text.
test('anthropicUsage: whole prompt = uncached + cache read + cache write; output includes thinking', async () => {
  const { anthropicUsage } = await import('../lib/anthropic_client.mjs');
  assert.deepEqual(
    anthropicUsage({ usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 50, output_tokens: 900 } }),
    { input: 4150, output: 900, cache_read: 4000, cache_write: 50 },
  );
  assert.deepEqual(anthropicUsage({ usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: null } }), { input: 10, output: 2, cache_read: 0, cache_write: 0 });
  assert.equal(anthropicUsage({}), null);
  assert.equal(anthropicUsage({ usage: null }), null);
  assert.equal(anthropicUsage({ usage: { input_tokens: '10', output_tokens: 2 } }), null);
  assert.equal(anthropicUsage({ usage: { input_tokens: 10 } }), null);
});

test('callAnthropic reports the usage through onUsage and still returns the text', async () => {
  mockFetch(makeResponse({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 7 } }));
  const seen = [];
  assert.equal(await callAnthropic({ ...BASE_ARGS, onUsage: (u) => seen.push(u) }), 'ok');
  assert.deepEqual(seen, [{ input: 19, output: 3, cache_read: 7, cache_write: 0 }]);
});

test('callAnthropic reports a billed refusal and a max_tokens truncation before throwing', async () => {
  for (const stop of ['refusal', 'max_tokens']) {
    mockFetch(makeResponse({ stop_reason: stop, content: [], usage: { input_tokens: 5, output_tokens: 16000 } }));
    const seen = [];
    await assert.rejects(() => callAnthropic({ ...BASE_ARGS, onUsage: (u) => seen.push(u) }));
    assert.deepEqual(seen, [{ input: 5, output: 16000, cache_read: 0, cache_write: 0 }], stop);
  }
});

test('callAnthropic without usage in the response, or without onUsage, is unchanged', async () => {
  mockFetch(makeResponse({ content: [{ type: 'text', text: 'ok' }] }));
  const seen = [];
  assert.equal(await callAnthropic({ ...BASE_ARGS, onUsage: (u) => seen.push(u) }), 'ok');
  assert.deepEqual(seen, []);
  mockFetch(makeResponse({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal(await callAnthropic(BASE_ARGS), 'ok');
});

test('anthropicUsage rejects malformed counts instead of coercing them', async () => {
  const { anthropicUsage } = await import('../lib/anthropic_client.mjs');
  for (const usage of [
    { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1, output_tokens: -2 }, { input_tokens: 1.5, output_tokens: 2 },
    { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: -5 }, { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: '3' },
  ]) assert.equal(anthropicUsage({ usage }), null, JSON.stringify(usage));
});
