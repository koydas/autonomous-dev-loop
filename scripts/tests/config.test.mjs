import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireEnv, loadConfigFromEnv, buildDeterministicPrompt } from '../lib/config.mjs';

const REQUIRED_VARS = ['ISSUE_NUMBER', 'ISSUE_TITLE', 'GROQ_API_KEY'];

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

function unsetEnv(...names) {
  for (const name of names) delete process.env[name];
}

beforeEach(() => unsetEnv(...REQUIRED_VARS, 'ISSUE_BODY', 'GROQ_MODEL', 'GROQ_API_URL'));
afterEach(() => unsetEnv(...REQUIRED_VARS, 'ISSUE_BODY', 'GROQ_MODEL', 'GROQ_API_URL'));

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
  setEnv({ ISSUE_NUMBER: '7', ISSUE_TITLE: 'Fix bug', ISSUE_BODY: 'Details', GROQ_API_KEY: 'key123' });
  const config = loadConfigFromEnv();
  assert.equal(config.issueNumber, '7');
  assert.equal(config.issueTitle, 'Fix bug');
  assert.equal(config.issueBody, 'Details');
  assert.equal(config.apiKey, 'key123');
  assert.equal(config.model, 'llama-3.3-70b-versatile');
});

test('loadConfigFromEnv uses default model when GROQ_MODEL not set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', GROQ_API_KEY: 'k' });
  const { model } = loadConfigFromEnv();
  assert.equal(model, 'llama-3.3-70b-versatile');
});

test('loadConfigFromEnv uses custom model when GROQ_MODEL is set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', GROQ_API_KEY: 'k', GROQ_MODEL: 'llama-3-70b' });
  const { model } = loadConfigFromEnv();
  assert.equal(model, 'llama-3-70b');
});

test('loadConfigFromEnv defaults ISSUE_BODY when not set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', GROQ_API_KEY: 'k' });
  const { issueBody } = loadConfigFromEnv();
  assert.equal(issueBody, '(no body provided)');
});

test('loadConfigFromEnv throws when GROQ_API_KEY is missing', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T' });
  assert.throws(() => loadConfigFromEnv(), /GROQ_API_KEY/);
});

test('loadConfigFromEnv throws when ISSUE_NUMBER is missing', () => {
  setEnv({ ISSUE_TITLE: 'T', GROQ_API_KEY: 'k' });
  assert.throws(() => loadConfigFromEnv(), /ISSUE_NUMBER/);
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
