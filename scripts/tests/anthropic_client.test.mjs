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

test('callAnthropic sends temperature 0 by default', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic(BASE_ARGS);
  assert.equal(capturedBody.temperature, 0);
});

test('callAnthropic sends system prompt at root level', async () => {
  let capturedBody;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ content: [{ type: 'text', text: '{}' }] });
  };
  await callAnthropic(BASE_ARGS);
  assert.equal(capturedBody.system, 'You are a test assistant.');
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
