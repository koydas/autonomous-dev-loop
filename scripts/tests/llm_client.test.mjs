import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLLM } from '../lib/llm_client.mjs';
import { GROQ_MODEL_DEFAULTS, GROQ_API_URL_DEFAULT, ANTHROPIC_MODEL_DEFAULTS } from '../lib/config.mjs';

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

test('callLLM routes to Anthropic when AI_PROVIDER=groq but only ANTHROPIC_API_KEY is set', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.AI_PROVIDER = 'groq';
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  };
  // AI_PROVIDER names a provider without a key: the one with a key is used (ADR-0032).
  const result = await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' });
  assert.equal(result, 'ok');
  assert.equal(capturedHeaders['x-api-key'], 'sk-ant-key');
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

test('callLLM falls back to groq when primary provider (anthropic) fails at runtime', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  // Network errors are retryable: Anthropic is retried until exhausted, then Groq takes over.
  let anthropicCalls = 0;
  let groqCalls = 0;
  let groqUrl;
  let groqHeaders;
  let groqBody;
  globalThis.fetch = async (url, opts) => {
    if (opts.headers['x-api-key']) {
      anthropicCalls++;
      throw new Error('network error');
    }
    groqCalls++;
    groqUrl = url;
    groqHeaders = opts.headers;
    groqBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: 'fallback-ok' } }] });
  };
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  let result;
  try {
    result = await callLLM({
      prompt: 'hi',
      systemPrompt: 'sys',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-4-7',
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    });
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
  assert.equal(result, 'fallback-ok');
  assert.equal(anthropicCalls, 4, 'anthropic network error must be retried before falling back');
  assert.equal(groqCalls, 1);
  // The fallback uses Groq's own config, never the primary's key, model or URL.
  assert.equal(groqHeaders['Authorization'], 'Bearer groq-key');
  assert.equal(groqUrl, GROQ_API_URL_DEFAULT);
  assert.equal(groqBody.model, GROQ_MODEL_DEFAULTS.generation);
});

function withInstantTimers(fn) {
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => { cb(); return {}; };
  return fn().finally(() => { globalThis.setTimeout = origSetTimeout; });
}

test('callLLM falls back to anthropic with its own key and model when primary groq fails', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  let anthropicHeaders;
  let anthropicBody;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) {
      anthropicHeaders = opts.headers;
      anthropicBody = JSON.parse(opts.body);
      return makeResponse({ content: [{ type: 'text', text: 'fallback-ok' }] });
    }
    return makeResponse('upstream down', 503);
  };
  const result = await withInstantTimers(() => callLLM({
    stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b',
    apiUrl: GROQ_API_URL_DEFAULT,
  }));
  assert.equal(result, 'fallback-ok');
  assert.equal(anthropicHeaders['x-api-key'], 'sk-ant-key');
  assert.equal(anthropicBody.model, ANTHROPIC_MODEL_DEFAULTS.review);
});

test('callLLM loads the fallback config for the stage it is given', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  let groqBody;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('overloaded', 529);
    groqBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  await callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-4-7' });
  assert.equal(groqBody.max_tokens, parseInt(GROQ_MODEL_DEFAULTS.review_max_tokens, 10));
  assert.equal(groqBody.temperature, parseFloat(GROQ_MODEL_DEFAULTS.review_temperature));
});

test('callLLM forwards responseFormat to the fallback call', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  let groqBody;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('overloaded', 529);
    groqBody = JSON.parse(opts.body);
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  await callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-4-7', responseFormat: null });
  assert.equal('response_format' in groqBody, false, 'review asks for free text: Groq must not be put in JSON mode');
});

test('callLLM skips the fallback when its API key is not configured', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.AI_PROVIDER = 'anthropic';
  let groqCalls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('bad request', 400);
    groqCalls++;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  await assert.rejects(
    () => callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-4-7' }),
    /All providers failed: anthropic: .*400.*, groq: skipped \(no API key configured\)/,
  );
  assert.equal(groqCalls, 0);
});

function captureStderr(fn) {
  const lines = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  return fn().finally(() => { process.stderr.write = origWrite; }).then(result => ({ result, lines }));
}

test('callLLM falls back on a permanent error (401/403) and logs it as an error', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  let groqCalls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('invalid x-api-key', 401);
    groqCalls++;
    return makeResponse({ choices: [{ message: { content: 'fallback-ok' } }] });
  };
  const { result, lines } = await captureStderr(() =>
    callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' }));
  assert.equal(result, 'fallback-ok');
  assert.equal(groqCalls, 1);
  const event = lines.filter(l => l.includes('"llm_fallback"')).map(l => JSON.parse(l))[0];
  assert.equal(event.level, 'error', 'a wrong primary key must stay visible (GitHub annotation)');
  assert.equal(event.stage, 'review');
  assert.deepEqual([event.meta.from, event.meta.to, event.meta.error_type], ['anthropic', 'groq', 'PERMANENT']);
  assert.match(event.meta.error, /401/);
});

test('callLLM logs a non-configuration primary failure (413) as a warn fallback event', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('request too large', 413);
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const { lines } = await captureStderr(() => callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' }));
  const event = lines.filter(l => l.includes('"llm_fallback"')).map(l => JSON.parse(l))[0];
  assert.equal(event.level, 'warn');
  assert.equal(event.meta.error_type, 'UNKNOWN');
});

test('callLLM reports both errors when the primary and the fallback fail', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('bad request', 400);
    return makeResponse('{"error":{"message":"model not found"}}', 404);
  };
  await assert.rejects(
    () => callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' }),
    /All providers failed: anthropic: Anthropic API HTTP error 400.*, groq: Groq API HTTP error 404/s,
  );
});

test('callLLM reports a fallback config error without calling the fallback', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  process.env.ANTHROPIC_EFFORT = 'extreme';
  let anthropicCalls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) { anthropicCalls++; return makeResponse({ content: [{ type: 'text', text: 'ok' }] }); }
    return makeResponse('bad request', 400);
  };
  try {
    await assert.rejects(
      () => callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT }),
      /All providers failed: groq: .*400.*, anthropic: Invalid anthropic effort for stage "review": extreme/s,
    );
  } finally {
    delete process.env.ANTHROPIC_EFFORT;
  }
  assert.equal(anthropicCalls, 0);
});

test('callLLM skips a Groq fallback when the prompt exceeds its input budget (would 413 until timeout)', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  let groqCalls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('overloaded', 529);
    groqCalls++;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const budget = parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10);
  const prompt = 'x'.repeat((budget + 100) * 4);
  await assert.rejects(
    () => withInstantTimers(() => callLLM({ stage: 'review', prompt, systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' })),
    new RegExp(`groq: skipped \\(prompt ~\\d+ tokens over review_max_input_tokens ${budget}\\)`),
  );
  assert.equal(groqCalls, 0);
});

test('callLLM measures the autofix fallback budget on the user prompt only', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  let groqCalls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('bad request', 400);
    groqCalls++;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const budget = parseInt(GROQ_MODEL_DEFAULTS.autofix_max_input_tokens, 10);
  // System prompt alone is over the budget: autofix still falls back, its budget excludes the system prompt.
  const result = await callLLM({ stage: 'autofix', prompt: 'fix it', systemPrompt: 's'.repeat((budget + 100) * 4), apiKey: 'sk-ant-key', model: 'claude-opus-5-5' });
  assert.equal(result, 'ok');
  assert.equal(groqCalls, 1);
});

test('callLLM uses the default provider when AI_PROVIDER is unknown', async () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.GROQ_API_KEY = 'groq-key';
  let capturedHeaders;
  globalThis.fetch = async (_url, opts) => {
    capturedHeaders = opts.headers;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const result = await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT });
  assert.equal(result, 'ok');
  assert.equal(capturedHeaders['Authorization'], 'Bearer groq-key');
});

test('callLLM throws descriptive error listing each provider failure when all fail', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.AI_PROVIDER = 'anthropic';
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  await assert.rejects(
    () => callLLM({
      prompt: 'hi',
      systemPrompt: 'sys',
      apiKey: 'sk-ant-key',
      model: 'claude-opus-4-7',
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    }),
    (err) => {
      assert.match(err.message, /All providers failed/);
      assert.match(err.message, /anthropic:/);
      assert.match(err.message, /groq:/);
      return true;
    }
  );
});

test('callLLM logs a 400 primary failure (misconfiguration) as an error fallback event', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse('effort is not supported on this model', 400);
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const { result, lines } = await captureStderr(() => callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-sonnet-4-5' }));
  assert.equal(result, 'ok');
  const event = lines.filter(l => l.includes('"llm_fallback"')).map(l => JSON.parse(l))[0];
  assert.equal(event.level, 'error');
  assert.equal(event.meta.error_type, 'UNKNOWN');
});

test('callLLM skips an over-budget Groq primary and uses the Anthropic fallback', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  let groqCalls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) return makeResponse({ content: [{ type: 'text', text: 'from anthropic' }] });
    groqCalls++;
    return makeResponse({ choices: [{ message: { content: 'ok' } }] });
  };
  const { result, lines } = await captureStderr(() => callLLM({
    stage: 'validation', prompt: 'x'.repeat(4000), systemPrompt: 'sys', apiKey: 'groq-key',
    model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT, maxInputTokens: 100,
  }));
  assert.equal(result, 'from anthropic');
  assert.equal(groqCalls, 0);
  const event = lines.filter(l => l.includes('"llm_fallback"')).map(l => JSON.parse(l))[0];
  assert.match(event.meta.error, /over validation_max_input_tokens \(100\)/);
});

test('callLLM fails on an over-budget primary without a request when no fallback key is set', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse({ choices: [{ message: { content: 'ok' } }] }); };
  await assert.rejects(
    () => callLLM({ stage: 'validation', prompt: 'x'.repeat(4000), systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT, maxInputTokens: 100 }),
    /groq: validation prompt is .* over validation_max_input_tokens \(100\).*anthropic: skipped \(no API key configured\)/,
  );
  assert.equal(calls, 0);
});
