import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callGroq } from '../lib/groq_client.mjs';

const BASE_ARGS = { prompt: 'go', systemPrompt: 'You are a test assistant.', apiKey: 'key', model: 'llama-3.1-8b-instant', apiUrl: 'https://api.test' };

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

test('callGroq retries on 429 and succeeds on the second attempt', async () => {
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false, status: 429,
        headers: { get: () => null },
        text: async () => 'rate limited',
      };
    }
    return makeResponse({ choices: [{ message: { content: '{"ok":true}' } }] });
  };
  process.env.GROQ_MAX_RETRIES = '1';
  try {
    const result = await callGroq({ ...BASE_ARGS, responseFormat: null });
    assert.equal(result, '{"ok":true}');
    assert.equal(callCount, 2);
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq throws after exhausting all retries on 429', async () => {
  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: () => null },
    text: async () => 'rate limited',
  });
  process.env.GROQ_MAX_RETRIES = '1';
  try {
    await assert.rejects(() => callGroq(BASE_ARGS), /Groq API HTTP error 429/);
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callGroq uses Retry-After header seconds value as wait delay', async () => {
  const waits = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); fn(); return {}; };

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: false, status: 429,
        headers: { get: (h) => h === 'Retry-After' ? '3' : null },
        text: async () => 'rate limited',
      };
    }
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
