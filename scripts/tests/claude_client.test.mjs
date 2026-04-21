import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callClaude } from '../lib/claude_client.mjs';

const BASE_ARGS = { systemPrompt: 'You are a test assistant.', userPrompt: 'go', apiKey: 'key', model: 'llama-3.3-70b-versatile', apiUrl: 'https://api.test' };

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

test('callClaude returns raw string content on success', async () => {
  mockFetch(makeResponse({
    choices: [{ message: { content: '{"valid":true,"score":85}' } }],
  }));
  const result = await callClaude(BASE_ARGS);
  assert.equal(result, '{"valid":true,"score":85}');
});

test('callClaude throws on HTTP error status', async () => {
  mockFetch(makeResponse('Unauthorized', 401));
  await assert.rejects(() => callClaude(BASE_ARGS), /Groq API HTTP error 401/);
});

test('callClaude throws when response body is not JSON', async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not-json' });
  await assert.rejects(() => callClaude(BASE_ARGS), /non-JSON response/);
});

test('callClaude throws when choices array is empty', async () => {
  mockFetch(makeResponse({ choices: [] }));
  await assert.rejects(() => callClaude(BASE_ARGS), /Unexpected Groq API response format/);
});

test('callClaude throws when message content is missing', async () => {
  mockFetch(makeResponse({ choices: [{ message: {} }] }));
  await assert.rejects(() => callClaude(BASE_ARGS), /Unexpected Groq API response format/);
});

test('callClaude throws when content is not a string', async () => {
  mockFetch(makeResponse({ choices: [{ message: { content: 42 } }] }));
  await assert.rejects(() => callClaude(BASE_ARGS), /Unexpected Groq API response format/);
});

test('callClaude sends correct Authorization header', async () => {
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  await callClaude(BASE_ARGS);
  assert.equal(capturedHeaders['Authorization'], 'Bearer key');
});

test('callClaude sends temperature 0 in payload', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  await callClaude(BASE_ARGS);
  assert.equal(capturedBody.temperature, 0);
});

test('callClaude uses default model when not specified', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const { model: _model, ...argsWithoutModel } = BASE_ARGS;
  await callClaude(argsWithoutModel);
  assert.equal(capturedBody.model, 'llama-3.3-70b-versatile');
});

test('callClaude uses default API URL when not specified', async () => {
  let capturedUrl;
  globalThis.fetch = async (url, _opts) => {
    capturedUrl = url;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const { apiUrl: _apiUrl, ...argsWithoutUrl } = BASE_ARGS;
  await callClaude(argsWithoutUrl);
  assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/chat/completions');
});
