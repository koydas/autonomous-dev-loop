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
  for (const stage of ['VALIDATION', 'GENERATION', 'REVIEW', 'AUTOFIX']) delete process.env[`AI_PROVIDER_${stage}`];
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

// Per-stage provider (ADR-0032 amendment): the call's stage picks AI_PROVIDER_<STAGE> over AI_PROVIDER.
test('callLLM routes each stage to its AI_PROVIDER_<STAGE>, other stages to AI_PROVIDER', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  process.env.AI_PROVIDER_REVIEW = 'anthropic';
  const hits = [];
  globalThis.fetch = async (url, opts) => {
    hits.push(opts.headers['x-api-key'] ? 'anthropic' : 'groq');
    return opts.headers['x-api-key']
      ? makeResponse({ content: [{ type: 'text', text: 'a' }] })
      : makeResponse({ choices: [{ message: { content: 'g' } }] });
  };
  const answered = [];
  const onAnswer = (a) => answered.push(a.provider);
  assert.equal(await callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-sonnet-5-5', onAnswer }), 'a');
  assert.equal(await callLLM({ stage: 'validation', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT, onAnswer }), 'g');
  assert.deepEqual(hits, ['anthropic', 'groq']);
  assert.deepEqual(answered, ['anthropic', 'groq']);
});

test('callLLM per-stage primary falls back to the other provider with that provider\'s own stage config', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  process.env.AI_PROVIDER_AUTOFIX = 'groq';
  let anthropicBody;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) {
      anthropicBody = JSON.parse(opts.body);
      return makeResponse({ content: [{ type: 'text', text: 'fallback-ok' }] });
    }
    return makeResponse({ error: { message: 'model_not_found' } }, 404);
  };
  const result = await callLLM({ stage: 'autofix', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT });
  assert.equal(result, 'fallback-ok');
  assert.equal(anthropicBody.model, ANTHROPIC_MODEL_DEFAULTS.autofix);
  assert.deepEqual(anthropicBody.output_config, { effort: GROQ_MODEL_DEFAULTS.anthropic_autofix_effort });
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

test('callLLM attaches the HTTP status of each failed provider (eval circuit breaker)', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  process.env.GROQ_MAX_RETRIES = '0';
  globalThis.fetch = async (_url, opts) => (!opts.headers['x-api-key']
    ? makeResponse({ error: { message: 'Rate limit reached on tokens per day (TPD): Limit 200000, Used 199000. Please try again in 13m47.28s.' } }, 429)
    : makeResponse({ error: { message: 'Invalid API Key' } }, 401));
  try {
    await assert.rejects(
      () => callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'k', model: 'm', apiUrl: 'https://api.groq.com/openai/v1/chat/completions' }),
      (err) => {
        assert.deepEqual(err.providerErrors, [{ provider: 'groq', status: 429 }, { provider: 'anthropic', status: 401 }]);
        return true;
      },
    );
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callLLM records a null status for a provider that failed without an HTTP response', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  process.env.GROQ_MAX_RETRIES = '0';
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return {}; };
  try {
    await assert.rejects(
      () => callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'k', model: 'm', apiUrl: 'https://api.groq.com/openai/v1/chat/completions' }),
      (err) => {
        assert.deepEqual(err.providerErrors.map((p) => p.status), [null, null]);
        return true;
      },
    );
  } finally {
    globalThis.setTimeout = origSetTimeout;
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callLLM marks an Anthropic 400 primary and a Groq 429 fallback with their own statuses', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  process.env.GROQ_MAX_RETRIES = '0';
  globalThis.fetch = async (_url, opts) => (opts.headers['x-api-key']
    ? makeResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace' } }, 400)
    : makeResponse({ error: { message: 'Rate limit reached on tokens per day (TPD): Limit 200000, Used 199000. Please try again in 13m47.28s.' } }, 429));
  try {
    const { lines } = await captureStderr(() => assert.rejects(
      () => callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-sonnet-4-5' }),
      (err) => {
        assert.deepEqual(err.providerErrors, [{ provider: 'anthropic', status: 400 }, { provider: 'groq', status: 429 }]);
        assert.match(err.message, /anthropic: .*not scoped to a workspace.*groq: .*tokens per day \(TPD\)/);
        return true;
      },
    ));
    assert.ok(lines.some((l) => l.includes('"llm_fallback"')));
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callLLM marks a fallback skipped without a key, and an over-budget primary skipped without a request', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.GROQ_MAX_RETRIES = '0';
  globalThis.fetch = async () => makeResponse({ error: { message: 'Invalid API Key' } }, 401);
  try {
    await assert.rejects(
      () => callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'm', apiUrl: GROQ_API_URL_DEFAULT }),
      (err) => {
        assert.deepEqual(err.providerErrors, [{ provider: 'groq', status: 401 }, { provider: 'anthropic', status: null, skipped: 'no_api_key' }]);
        return true;
      },
    );
    await assert.rejects(
      () => callLLM({ stage: 'validation', prompt: 'x'.repeat(4000), systemPrompt: 'sys', apiKey: 'groq-key', model: 'm', apiUrl: GROQ_API_URL_DEFAULT, maxInputTokens: 100 }),
      (err) => {
        assert.deepEqual(err.providerErrors.map((p) => p.skipped), ['over_input_budget', 'no_api_key']);
        return true;
      },
    );
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

// Live evals pin the primary (ADR-0032 amendment): a fallback answer would be published as the primary's.
const GROQ_TPD_429 = { error: { message: 'Rate limit reached on tokens per day (TPD): Limit 200000, Used 199000. Please try again in 13m47.28s.' } };

test('callLLM with fallback: false never calls the fallback and marks it skipped: disabled', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  process.env.GROQ_MAX_RETRIES = '0';
  let anthropicCalls = 0;
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) { anthropicCalls++; return makeResponse({ content: [{ type: 'text', text: 'other-model' }] }); }
    return makeResponse(GROQ_TPD_429, 429);
  };
  let answered = null;
  try {
    const { lines } = await captureStderr(() => assert.rejects(
      () => callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'm', apiUrl: GROQ_API_URL_DEFAULT, fallback: false, onAnswer: (a) => { answered = a; } }),
      (err) => {
        assert.deepEqual(err.providerErrors, [{ provider: 'groq', status: 429 }, { provider: 'anthropic', status: null, skipped: 'disabled' }]);
        assert.match(err.message, /groq: .*tokens per day \(TPD\).*anthropic: skipped \(fallback disabled\)/);
        return true;
      },
    ));
    assert.equal(anthropicCalls, 0);
    assert.equal(answered, null, 'onAnswer is not called on failure');
    const events = lines.filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    const disabled = events.find((e) => e.event === 'llm_fallback_disabled');
    assert.equal(disabled.level, 'warn');
    assert.equal(disabled.meta.from, 'groq');
    assert.ok(!events.some((e) => e.event === 'llm_fallback'));
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callLLM with fallback: false still answers from the primary and reports it to onAnswer', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async () => makeResponse({ choices: [{ message: { content: 'ok' } }] });
  let answered = null;
  const result = await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'gpt-x', apiUrl: GROQ_API_URL_DEFAULT, fallback: false, onAnswer: (a) => { answered = a; } });
  assert.equal(result, 'ok');
  assert.deepEqual(answered, { provider: 'groq', model: 'gpt-x' });
});

test('callLLM with fallback: false marks an over-budget primary and the disabled fallback, without any request', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return makeResponse({ content: [{ type: 'text', text: 'x' }] }); };
  await assert.rejects(
    () => callLLM({ stage: 'validation', prompt: 'x'.repeat(4000), systemPrompt: 'sys', apiKey: 'groq-key', model: 'm', apiUrl: GROQ_API_URL_DEFAULT, maxInputTokens: 100, fallback: false }),
    (err) => {
      assert.deepEqual(err.providerErrors.map((p) => p.skipped), ['over_input_budget', 'disabled']);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('callLLM without fallback: false keeps the ADR-0032 fallback and reports the fallback provider to onAnswer', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  process.env.GROQ_MAX_RETRIES = '0';
  globalThis.fetch = async (_url, opts) => (opts.headers['x-api-key']
    ? makeResponse({ content: [{ type: 'text', text: 'fallback-ok' }] })
    : makeResponse(GROQ_TPD_429, 429));
  let answered = null;
  try {
    const { result } = await captureStderr(() => callLLM({
      stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'm', apiUrl: GROQ_API_URL_DEFAULT, onAnswer: (a) => { answered = a; },
    }));
    assert.equal(result, 'fallback-ok');
    assert.deepEqual(answered, { provider: 'anthropic', model: ANTHROPIC_MODEL_DEFAULTS.review });
  } finally {
    delete process.env.GROQ_MAX_RETRIES;
  }
});

test('callLLM reports a null model to onAnswer when the primary config carries none', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  globalThis.fetch = async () => makeResponse({ choices: [{ message: { content: 'ok' } }] });
  let answered = null;
  await callLLM({ prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', apiUrl: GROQ_API_URL_DEFAULT, onAnswer: (a) => { answered = a; } });
  assert.deepEqual(answered, { provider: 'groq', model: null });
});

// ADR-0040: one llm_call event per answered call (provider and model actually used), one
// llm_call_failed per call that no provider answered, both under the calling stage.
const llmEvents = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && (e.event === 'llm_call' || e.event === 'llm_call_failed'));

test('callLLM logs llm_call with the primary provider and model, fallback false', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async () => makeResponse({ choices: [{ message: { content: 'ok' } }] });
  const { lines } = await captureStderr(() => callLLM({ stage: 'validation', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'gpt-x', apiUrl: GROQ_API_URL_DEFAULT }));
  const [event, ...rest] = llmEvents(lines);
  assert.equal(rest.length, 0);
  assert.equal(event.event, 'llm_call');
  assert.equal(event.stage, 'validation');
  assert.equal(event.level, 'info');
  assert.deepEqual(event.meta, { provider: 'groq', model: 'gpt-x', fallback: false });
  assert.ok(Number.isInteger(event.duration_ms) && event.duration_ms >= 0);
});

test('callLLM logs llm_call with the fallback provider and its own model, fallback true', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  globalThis.fetch = async (_url, opts) => (opts.headers['x-api-key']
    ? makeResponse('invalid x-api-key', 401)
    : makeResponse({ choices: [{ message: { content: 'fallback-ok' } }] }));
  const { lines } = await captureStderr(() => callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' }));
  const events = llmEvents(lines);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'llm_call');
  assert.equal(events[0].meta.provider, 'groq');
  assert.equal(events[0].meta.fallback, true);
  assert.equal(events[0].meta.model, GROQ_MODEL_DEFAULTS.review);
});

test('callLLM logs llm_call_failed with each provider outcome when no provider answers', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  globalThis.fetch = async (_url, opts) => (opts.headers['x-api-key']
    ? makeResponse('bad request', 400)
    : makeResponse('{"error":{"message":"model not found"}}', 404));
  const { lines } = await captureStderr(() => assert.rejects(() => callLLM({ stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' })));
  const events = llmEvents(lines);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'llm_call_failed');
  assert.equal(events[0].level, 'warn');
  assert.deepEqual(events[0].meta.providers, ['anthropic:400', 'groq:404']);
});

test('callLLM logs llm_call_failed with the skip reasons when no request was made', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async () => { throw new Error('no request expected'); };
  const { lines } = await captureStderr(() => assert.rejects(() => callLLM({ stage: 'validation', prompt: 'x'.repeat(4000), systemPrompt: 'sys', apiKey: 'groq-key', model: 'm', apiUrl: GROQ_API_URL_DEFAULT, maxInputTokens: 100, fallback: false })));
  assert.deepEqual(llmEvents(lines).map((e) => e.meta.providers), [['groq:over_input_budget', 'anthropic:disabled']]);
});

// ---------------------------------------------------------------------------
// ADR-0041: each call is an llm_call child span; retries and the fallback are its span events
// ---------------------------------------------------------------------------

async function tracedCall(args, fn) {
  const { createTracer } = await import('../lib/observability.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-span-'));
  const tracer = createTracer({ runId: 'llm-span', traceDir: dir });
  try {
    await captureStderr(async () => {
      tracer.startSpan('review');
      await fn(() => callLLM(args));
      tracer.endSpan('review');
    });
    const trace = JSON.parse(fs.readFileSync(path.join(dir, 'llm-span.json'), 'utf8'));
    const stage = trace.spans.find((s) => s.stage === 'review');
    // Calls of earlier tests (no tracer yet) are adopted by the journal like early events: keep this stage's.
    return { trace, stage, llm: trace.child_spans.filter((s) => s.name === 'llm_call' && s.parent_span_id === stage.span_id) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('callLLM: an llm_call span under the stage span, GenAI attributes, estimated tokens flagged, no prompt or answer', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async () => makeResponse({ choices: [{ message: { content: 'ANSWER-TEXT-SECRET '.repeat(4) } }] });
  const { trace, stage, llm } = await tracedCall(
    { stage: 'review', prompt: 'PROMPT-BODY-SECRET', systemPrompt: 'sys', apiKey: 'groq-key', model: 'gpt-x', apiUrl: GROQ_API_URL_DEFAULT, maxTokens: 512, maxInputTokens: 3000 },
    (call) => call(),
  );
  assert.equal(llm.length, 1);
  assert.equal(llm[0].parent_span_id, stage.span_id);
  assert.equal(llm[0].status, 'ok');
  assert.ok(llm[0].duration_ms >= 0 && llm[0].completed_at);
  assert.deepEqual(llm[0].attributes, {
    'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-x', 'adl.stage': 'review', 'gen_ai.request.max_tokens': 512, 'adl.llm.max_input_tokens': 3000,
    'gen_ai.system': 'groq', 'gen_ai.response.model': 'gpt-x', 'gen_ai.usage.input_tokens': llm[0].attributes['gen_ai.usage.input_tokens'],
    'gen_ai.usage.output_tokens': llm[0].attributes['gen_ai.usage.output_tokens'], 'adl.usage.estimated': true, 'adl.llm.fallback': false,
  });
  assert.ok(llm[0].attributes['gen_ai.usage.output_tokens'] > 0);
  const callEvent = trace.events.filter((e) => e.event === 'llm_call').at(-1);
  assert.equal(callEvent.span_id, llm[0].span_id, 'the llm_call event carries the span of its call');
  const json = JSON.stringify(trace);
  assert.ok(!json.includes('PROMPT-BODY-SECRET') && !json.includes('ANSWER-TEXT-SECRET'));
});

test('callLLM: retries and the fallback are logged inside the llm_call span; the answering provider is recorded', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'anthropic';
  globalThis.fetch = async (_url, opts) => {
    if (opts.headers['x-api-key']) throw new Error('network error');
    return makeResponse({ choices: [{ message: { content: 'fallback-ok' } }] });
  };
  const { trace, llm } = await tracedCall(
    { stage: 'review', prompt: 'hi', systemPrompt: 'sys', apiKey: 'sk-ant-key', model: 'claude-opus-5-5' },
    (call) => withInstantTimers(call),
  );
  assert.equal(llm.length, 1);
  const inSpan = trace.events.filter((e) => e.span_id === llm[0].span_id).map((e) => e.event);
  assert.deepEqual([...new Set(inSpan)], ['retry.wait', 'llm_fallback', 'llm_call']);
  assert.equal(llm[0].attributes['gen_ai.system'], 'groq');
  assert.equal(llm[0].attributes['gen_ai.request.model'], 'claude-opus-5-5');
  assert.equal(llm[0].attributes['gen_ai.response.model'], GROQ_MODEL_DEFAULTS.review);
  assert.equal(llm[0].attributes['adl.llm.fallback'], true);
  assert.equal(llm[0].attributes['adl.llm.fallback_from'], 'anthropic');
  assert.equal(llm[0].attributes['adl.llm.providers'].length, 1);
  assert.match(llm[0].attributes['adl.llm.providers'][0], /^anthropic:/, 'the primary that failed before the fallback answered');
});

test('callLLM: a failed call ends its span in error with error.type and the input-budget cut', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async () => { throw new Error('no request expected'); };
  const { llm } = await tracedCall(
    { stage: 'validation', prompt: 'x'.repeat(4000), systemPrompt: 'sys', apiKey: 'groq-key', model: 'm', apiUrl: GROQ_API_URL_DEFAULT, maxInputTokens: 100, fallback: false },
    (call) => assert.rejects(call),
  );
  assert.equal(llm[0].status, 'error');
  assert.equal(llm[0].attributes['gen_ai.system'], 'groq');
  assert.deepEqual(llm[0].attributes['adl.llm.providers'], ['groq:over_input_budget', 'anthropic:disabled']);
  assert.deepEqual(llm[0].attributes['adl.llm.input_budget_skipped'], ['groq']);
  assert.equal(typeof llm[0].attributes['error.type'], 'string');
});

// #150: Groq 400 json_validate_failed → structured diagnosis event, then the ADR-0032 fallback.
const JSON_VALIDATE_BODY = { error: { code: 'json_validate_failed', message: 'invalid generated JSON' } };

test('callLLM: Groq 400 json_validate_failed logs llm_provider_error (code + status only) before falling back to Anthropic with its own URL, key and stage model', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fallback-key';
  process.env.GROQ_API_KEY = 'groq-primary-key';
  process.env.AI_PROVIDER = 'groq';
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    if (url === GROQ_API_URL_DEFAULT) return makeResponse(JSON_VALIDATE_BODY, 400);
    return makeResponse({ content: [{ type: 'text', text: 'anthropic-answer' }] });
  };
  const { result, lines } = await captureStderr(() => withInstantTimers(() => callLLM({
    stage: 'generation', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-primary-key', model: 'openai/gpt-oss-120b',
    apiUrl: GROQ_API_URL_DEFAULT,
  })));
  assert.equal(result, 'anthropic-answer');
  assert.deepEqual(requests.map((r) => r.url), [GROQ_API_URL_DEFAULT, 'https://api.anthropic.com/v1/messages'], 'one Groq request, then Anthropic');
  const anthropic = requests[1];
  assert.equal(anthropic.headers['x-api-key'], 'sk-ant-fallback-key');
  assert.equal(anthropic.headers.Authorization, undefined);
  assert.equal(anthropic.body.model, ANTHROPIC_MODEL_DEFAULTS.generation);

  const events = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const diagnosis = events.filter((e) => e.event === 'llm_provider_error');
  assert.equal(diagnosis.length, 1);
  assert.equal(diagnosis[0].stage, 'generation');
  assert.deepEqual(diagnosis[0].meta, { provider: 'groq', error_type: 'json_validate_failed', status: 400 });
  const names = events.map((e) => e.event);
  assert.ok(names.indexOf('llm_provider_error') < names.indexOf('llm_fallback'), 'diagnosis logged before the fallback');
  const line = lines.find((l) => l.includes('"llm_provider_error"'));
  assert.ok(!line.includes('invalid generated JSON'), 'no response body');
  assert.ok(!line.includes('groq-primary-key') && !line.includes('sk-ant-fallback-key'), 'no credentials');
});

test('callLLM: Groq json_validate_failed and an Anthropic failure both appear in the final error', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async (url) => (url === GROQ_API_URL_DEFAULT
    ? makeResponse(JSON_VALIDATE_BODY, 400)
    : makeResponse('{"type":"error","error":{"type":"invalid_request_error"}}', 400));
  await assert.rejects(
    () => captureStderr(() => callLLM({ stage: 'generation', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT })),
    (err) => {
      assert.match(err.message, /All providers failed: groq: Groq API HTTP error 400: .*json_validate_failed.*, anthropic: Anthropic API HTTP error 400/s);
      assert.deepEqual(err.providerErrors, [{ provider: 'groq', status: 400 }, { provider: 'anthropic', status: 400 }]);
      return true;
    },
  );
});

test('callLLM: a Groq 400 without a structured code logs no llm_provider_error and still falls back', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-key';
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  let groqCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === GROQ_API_URL_DEFAULT) { groqCalls++; return makeResponse('not json at all', 400); }
    return makeResponse({ content: [{ type: 'text', text: 'ok' }] });
  };
  const { result, lines } = await captureStderr(() => callLLM({ stage: 'generation', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT }));
  assert.equal(result, 'ok');
  assert.equal(groqCalls, 1);
  assert.ok(!lines.some((l) => l.includes('"llm_provider_error"')));
  const fallback = lines.filter((l) => l.includes('"llm_fallback"')).map((l) => JSON.parse(l))[0];
  assert.equal(fallback.level, 'error', 'a 400 stays a configuration-level fallback');
});

test('callLLM: llm_provider_error is logged even when no fallback key is configured (explicit skip)', async () => {
  process.env.GROQ_API_KEY = 'groq-key';
  process.env.AI_PROVIDER = 'groq';
  globalThis.fetch = async () => makeResponse(JSON_VALIDATE_BODY, 400);
  const lines = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    await assert.rejects(
      () => callLLM({ stage: 'generation', prompt: 'hi', systemPrompt: 'sys', apiKey: 'groq-key', model: 'openai/gpt-oss-120b', apiUrl: GROQ_API_URL_DEFAULT }),
      /groq: Groq API HTTP error 400.*anthropic: skipped \(no API key configured\)/s,
    );
  } finally {
    process.stderr.write = origWrite;
  }
  const events = lines.filter((l) => l.includes('"llm_provider_error"')).map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.meta), [{ provider: 'groq', error_type: 'json_validate_failed', status: 400 }]);
});
