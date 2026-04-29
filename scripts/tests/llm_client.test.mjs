import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM } from '../lib/llm_client.mjs';

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

afterEach(() => {
  delete globalThis.fetch;
  delete process.env.AI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
});

test('callLLM routes to Anthropic when only ANTHROPIC_API_KEY is set', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  };
  const result = await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-4-7' });
  assert.equal(result, 'ok');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-key');
});

test('callLLM routes to Groq when only GROQ_API_KEY is set', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const result = await callLLM({
    prompt: 'hi',
    systemPrompt: 'sys',
    apiKey: 'groq-key',
    model: 'llama-3.3-70b-versatile',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  });
  assert.equal(result, 'ok');
  assert.equal(capturedHeaders['Authorization'], 'Bearer groq-key');
});

test('callLLM defaults to Groq when no keys are set', async () => {
  globalThis.fetch = async () => makeResponse({ choices: [{ message: { content: 'ok' } }] });
  const result = await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'qwen/qwen3-32b', apiUrl: 'https://api.groq.com/openai/v1/chat/completions' });
  assert.equal(result, 'ok');
});

test('callLLM routes to Groq when AI_PROVIDER=groq even if only ANTHROPIC_API_KEY is set', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async (_url, opts) => {
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  // callGroq will be invoked; key enforcement happens in loadLLMConfig (not tested here)
  const result = await callLLM({
    prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'llama-3.3-70b-versatile',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
  });
  assert.equal(result, 'ok');
});

test('callLLM routes to Groq when AI_PROVIDER=groq and both keys are set', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
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

test('callLLM defaults to Groq when both keys set and no AI_PROVIDER', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'qwen/qwen3-32b', apiUrl: 'https://api.groq.com/openai/v1/chat/completions' });
  assert.equal(capturedHeaders['Authorization'], 'Bearer groq-key');
});

test('callLLM AI_PROVIDER is case-insensitive', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'ANTHROPIC';
  globalThis.fetch = async () => makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  const result = await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-4-7' });
  assert.equal(result, 'ok');
});
