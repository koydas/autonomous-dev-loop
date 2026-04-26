import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM } from '../lib/llm_client.mjs';

const originalEnv = { ...process.env };

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

afterEach(() => {
  delete globalThis.fetch;
  // Restore AI_PROVIDER
  if (originalEnv.AI_PROVIDER === undefined) {
    delete process.env.AI_PROVIDER;
  } else {
    process.env.AI_PROVIDER = originalEnv.AI_PROVIDER;
  }
});

test('callLLM routes to Groq by default (no AI_PROVIDER)', async () => {
  delete process.env.AI_PROVIDER;
  let capturedUrl;
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const result = await callLLM({
    prompt: 'hi',
    systemPrompt: 'sys',
    apiKey: 'key',
    model: 'llama-3.3-70b-versatile',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  });
  assert.equal(result, 'ok');
  assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/chat/completions');
});

test('callLLM routes to Groq when AI_PROVIDER=groq', async () => {
  process.env.AI_PROVIDER = 'groq';
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  await callLLM({
    prompt: 'hi',
    systemPrompt: 'sys',
    apiKey: 'groq-key',
    model: 'llama-3.3-70b-versatile',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  });
  assert.equal(capturedHeaders['Authorization'], 'Bearer groq-key');
});

test('callLLM routes to Anthropic when AI_PROVIDER=anthropic', async () => {
  process.env.AI_PROVIDER = 'anthropic';
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  };
  const result = await callLLM({
    prompt: 'hi',
    systemPrompt: 'sys',
    apiKey: 'sk-ant-key',
    model: 'claude-opus-4-7',
  });
  assert.equal(result, 'ok');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-key');
});

test('callLLM is case-insensitive for AI_PROVIDER', async () => {
  process.env.AI_PROVIDER = 'ANTHROPIC';
  globalThis.fetch = async () =>
    makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  const result = await callLLM({
    prompt: 'hi',
    systemPrompt: 'sys',
    apiKey: 'sk-ant-key',
    model: 'claude-opus-4-7',
  });
  assert.equal(result, 'ok');
});
