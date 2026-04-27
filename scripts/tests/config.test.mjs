import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireEnv, loadConfigFromEnv, buildDeterministicPrompt, detectProvider } from '../lib/config.mjs';

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

test('detectProvider returns anthropic when no keys are set', () => {
  assert.equal(detectProvider(), 'anthropic');
});

test('detectProvider returns anthropic when both keys set and no AI_PROVIDER', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key' });
  assert.equal(detectProvider(), 'anthropic');
});

test('detectProvider returns groq when both keys set and AI_PROVIDER=groq', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq' });
  assert.equal(detectProvider(), 'groq');
});

test('detectProvider returns anthropic when both keys set and AI_PROVIDER=anthropic', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'anthropic' });
  assert.equal(detectProvider(), 'anthropic');
});

test('detectProvider AI_PROVIDER tiebreaker is case-insensitive', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'GROQ' });
  assert.equal(detectProvider(), 'groq');
});

test('detectProvider ignores AI_PROVIDER when only one key is set', () => {
  setEnv({ GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'anthropic' });
  assert.equal(detectProvider(), 'groq');
});

// requireEnv

test('requireEnv returns trimmed value when set', () => {
  process.env.TEST_VAR = '  hello  ';
  assert.equal(requireEnv('TEST_VAR'), 'hello');
  delete process.env.TEST_VAR;
});

test('requireEnv throws when variable is missing', () => {
  delete process.env.TEST_VAR;
  assert.throws(() => requireEnv('TEST_VAR'), /Missing required environment variable: TEST_VAR/);
});

test('requireEnv throws when variable is empty string', () => {
  process.env.TEST_VAR = '   ';
  assert.throws(() => requireEnv('TEST_VAR'), /Missing required environment variable: TEST_VAR/);
  delete process.env.TEST_VAR;
});

// loadConfigFromEnv

test('loadConfigFromEnv returns full config with all vars set', () => {
  setEnv({ ISSUE_NUMBER: '7', ISSUE_TITLE: 'Fix bug', ISSUE_BODY: 'Details', ANTHROPIC_API_KEY: 'sk-ant-123' });
  const config = loadConfigFromEnv();
  assert.equal(config.issueNumber, '7');
  assert.equal(config.issueTitle, 'Fix bug');
  assert.equal(config.issueBody, 'Details');
  assert.equal(config.apiKey, 'sk-ant-123');
  assert.equal(config.model, 'claude-opus-4-7');
});

test('loadConfigFromEnv uses default Anthropic model when ANTHROPIC_MODEL not set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'k' });
  const { model } = loadConfigFromEnv();
  assert.equal(model, 'claude-opus-4-7');
});

test('loadConfigFromEnv uses custom model when ANTHROPIC_MODEL is set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001' });
  const { model } = loadConfigFromEnv();
  assert.equal(model, 'claude-haiku-4-5-20251001');
});

test('loadConfigFromEnv defaults ISSUE_BODY when not set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'k' });
  const { issueBody } = loadConfigFromEnv();
  assert.equal(issueBody, '(no body provided)');
});

test('loadConfigFromEnv throws when ANTHROPIC_API_KEY is missing', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T' });
  assert.throws(() => loadConfigFromEnv(), /ANTHROPIC_API_KEY/);
});

test('loadConfigFromEnv throws when ISSUE_NUMBER is missing', () => {
  setEnv({ ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'k' });
  assert.throws(() => loadConfigFromEnv(), /ISSUE_NUMBER/);
});

test('loadConfigFromEnv uses Groq when only GROQ_API_KEY is set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', GROQ_API_KEY: 'groq-key' });
  const config = loadConfigFromEnv();
  assert.equal(config.apiKey, 'groq-key');
  assert.equal(config.model, 'llama-3.3-70b-versatile');
});

test('loadConfigFromEnv uses Anthropic when both keys set and no AI_PROVIDER', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key' });
  const config = loadConfigFromEnv();
  assert.equal(config.apiKey, 'ant-key');
  assert.equal(config.model, 'claude-opus-4-7');
});

test('loadConfigFromEnv uses AI_PROVIDER=groq tiebreaker when both keys set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq' });
  const config = loadConfigFromEnv();
  assert.equal(config.apiKey, 'groq-key');
  assert.equal(config.model, 'llama-3.3-70b-versatile');
});

// buildDeterministicPrompt

test('buildDeterministicPrompt includes issue fields', () => {
  const prompt = buildDeterministicPrompt({ issueNumber: '42', issueTitle: 'Add docs', issueBody: 'Please add docs' });
  assert.ok(prompt.includes('42'));
  assert.ok(prompt.includes('Add docs'));
  assert.ok(prompt.includes('Please add docs'));
});

test('buildDeterministicPrompt contains JSON output schema keys', () => {
  const prompt = buildDeterministicPrompt({ issueNumber: '1', issueTitle: 'T', issueBody: 'B' });
  assert.ok(prompt.includes('summary'));
  assert.ok(prompt.includes('changes'));
  assert.ok(prompt.includes('target_path'));
  assert.ok(prompt.includes('file_content'));
});

test('buildDeterministicPrompt returns a non-empty string', () => {
  const prompt = buildDeterministicPrompt({ issueNumber: '1', issueTitle: 'T', issueBody: 'B' });
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.length > 0);
});
