import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireEnv, loadConfigFromEnv, buildDeterministicPrompt, detectProvider, loadLLMConfig } from '../lib/config.mjs';

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

test('detectProvider returns groq when both keys set and AI_PROV

// loadLLMConfig temperature validation tests


test('loadLLMConfig accepts temperature 0', () => {
  const GROQ_MODEL_DEFAULTS = { temperature: 0 };
  const config = loadLLMConfig('generation');
  assert.equal(config.temperature, 0);
});

test('loadLLMConfig accepts temperature 2', () => {
  const GROQ_MODEL_DEFAULTS = { temperature: 2 };
  const config = loadLLMConfig('generation');
  assert.equal(config.temperature, 2);
});

test('loadLLMConfig rejects temperature -0.0001', () => {
  const GROQ_MODEL_DEFAULTS = { temperature: -0.0001 };
  assert.throws(() => loadLLMConfig('generation'), /Invalid temperature/);
});

test('loadLLMConfig rejects temperature 2.0001', () => {
  const GROQ_MODEL_DEFAULTS = { temperature: 2.0001 };
  assert.throws(() => loadLLMConfig('generation'), /Invalid temperature/);
});