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

test('callGroq returns parsed AI object on success', async () => {
  const aiContent = { summary: 'S', target_path: 'a.md', file_content: 'hello' };
  mockFetch(makeResponse({
    choices: [{ message: { content: JSON.stringify(aiContent) } }],
  }));
  const result = await callGroq(BASE_ARGS);
  assert.deepEqual(result, aiContent);
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

test('callGroq throws when AI content is not valid JSON', async () => {
  mockFetch(makeResponse({ choices: [{ message: { content: 'not json' } }] }));
  await assert.rejects(() => callGroq(BASE_ARGS), /not valid JSON/);
});

test('callGroq throws when AI content is a JSON array (not object)', async () => {
  mockFetch(makeResponse({ choices: [{ message: { content: '[]' } }] }));
  await assert.rejects(() => callGroq(BASE_ARGS), /must be an object/);
});

test('callGroq sends correct Authorization header', async () => {
  let capturedHeaders;
  const aiContent = { summary: 'S', target_path: 'a.md', file_content: 'x' };
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ choices: [{ message: { content: JSON.stringify(aiContent) } }] });
  };
  await callGroq(BASE_ARGS);
  assert.equal(capturedHeaders['Authorization'], 'Bearer key');
});

test('callGroq sends temperature 0 in payload', async () => {
  let capturedBody;
  const aiContent = { summary: 'S', target_path: 'a.md', file_content: 'x' };
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: JSON.stringify(aiContent) } }] });
  };
  await callGroq(BASE_ARGS);
  assert.equal(capturedBody.temperature, 0);
});
