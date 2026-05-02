import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireEnv, loadConfigFromEnv, buildDeterministicPrompt, detectProvider, loadLLMConfig, GROQ_MODEL_DEFAULTS } from '../lib/config.mjs';

const ALL_LLM_VARS = ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'AI_PROVIDER', 'ANTHROPIC_MODEL', 'GROQ_MODEL', 'GROQ_API_URL', 'ANTHROPIC_API_URL'];
const REQUIRED_VARS = ['ISSUE_NUMBER', 'ISSUE_TITLE', ...ALL_LLM_VARS];

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

function unsetEnv(...names) {
  for (const name of names) delete process.env[name];
}

beforeEach(() => unsetEnv(...REQUIRED_VARS, 'ISSUE_BODY'));
afterEach(() => unsetEnv(...REQUIRED_VARS, 'ISSUE_BODY'));

// detectProvider

test('detectProvider returns anthropic when only ANTHROPIC_API_KEY is set', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key' });
  assert.equal(detectProvider(), 'anthropic');
});

test('detectProvider returns groq when only GROQ_API_KEY is set', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  assert.equal(detectProvider(), 'groq');
});

test('detectProvider returns groq when no keys are set', () => {
  assert.equal(detectProvider(), 'groq');
});

test('detectProvider returns groq when both keys set and no AI_PROVIDER', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key' });
  assert.equal(detectProvider(), 'groq');
});

test('detectProvider returns groq when AI_PROVIDER=groq regardless of keys', () => {
  setEnv({ AI_PROVIDER: 'groq' });
  assert.equal(detectProvider(), 'groq');
});

test('detectProvider returns anthropic when AI_PROVIDER=anthropic regardless of keys', () => {
  setEnv({ GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'anthropic' });
  assert.equal(detectProvider(), 'anthropic');
});

test('detectProvider AI_PROVIDER is case-insensitive', () => {
  setEnv({ AI_PROVIDER: 'GROQ' });
  assert.equal(detectProvider(), 'groq');
});

test('detectProvider returns groq when both

// loadLLMConfig temperature validation
// GROQ_MODEL_DEFAULTS is a mutable module-level object; we mutate generation_temperature
// in-process so the validation logic in loadLLMConfig actually runs with the desired value.

test('loadLLMConfig accepts temperature 0', () => {
  const original = GROQ_MODEL_DEFAULTS.generation_temperature;
  GROQ_MODEL_DEFAULTS.generation_temperature = 0;
  setEnv({ GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq', GROQ_MODEL: 'default' });
  try {
    const config = loadLLMConfig('generation');
    assert.equal(config.temperature, 0);
  } finally {
    GROQ_MODEL_DEFAULTS.generation_temperature = original;
  }
});

test('loadLLMConfig accepts temperature 2', () => {
  const original = GROQ_MODEL_DEFAULTS.generation_temperature;
  GROQ_MODEL_DEFAULTS.generation_temperature = 2;
  setEnv({ GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq', GROQ_MODEL: 'default' });
  try {
    const config = loadLLMConfig('generation');
    assert.equal(config.temperature, 2);
  } finally {
    GROQ_MODEL_DEFAULTS.generation_temperature = original;
  }
});

test('loadLLMConfig rejects temperature -0.0001', () => {
  const original = GROQ_MODEL_DEFAULTS.generation_temperature;
  GROQ_MODEL_DEFAULTS.generation_temperature = -0.0001;
  setEnv({ GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq', GROQ_MODEL: 'default' });
  try {
    assert.throws(() => loadLLMConfig('generation'), /Invalid temperature/);
  } finally {
    GROQ_MODEL_DEFAULTS.generation_temperature = original;
  }
});

test('loadLLMConfig rejects temperature 2.0001', () => {
  const original = GROQ_MODEL_DEFAULTS.generation_temperature;
  GROQ_MODEL_DEFAULTS.generation_temperature = 2.0001;
  setEnv({ GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq', GROQ_MODEL: 'default' });
  try {
    assert.throws(() => loadLLMConfig('generation'), /Invalid temperature/);
  } finally {
    GROQ_MODEL_DEFAULTS.generation_temperature = original;
  }
});