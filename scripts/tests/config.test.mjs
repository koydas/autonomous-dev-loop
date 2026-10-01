import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { estimateTokens } from '../lib/metrics.mjs';
import { loadPrompt } from '../lib/prompts.mjs';
import { requireEnv, loadConfigFromEnv, buildDeterministicPrompt, detectProvider, loadLLMConfig, GROQ_MODEL_DEFAULTS, validateStartup } from '../lib/config.mjs';

const ALL_LLM_VARS = ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'AI_PROVIDER', 'ANTHROPIC_MODEL', 'GROQ_MODEL', 'GROQ_API_URL', 'ANTHROPIC_API_URL', 'GROQ_REASONING_EFFORT'];
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

test('detectProvider returns groq when both keys set and AI_PROVIDER=groq', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq' });
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

test('loadConfigFromEnv throws when GROQ_API_KEY is missing', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T' });
  assert.throws(() => loadConfigFromEnv(), /GROQ_API_KEY/);
});

test('loadConfigFromEnv throws when ISSUE_NUMBER is missing', () => {
  setEnv({ ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'k' });
  assert.throws(() => loadConfigFromEnv(), /ISSUE_NUMBER/);
});

test('loadConfigFromEnv uses Groq when only GROQ_API_KEY is set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', GROQ_API_KEY: 'groq-key' });
  const config = loadConfigFromEnv();
  assert.equal(config.apiKey, 'groq-key');
});

test('loadConfigFromEnv uses Groq when both keys set and no AI_PROVIDER', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key' });
  const config = loadConfigFromEnv();
  assert.equal(config.apiKey, 'groq-key');
});

test('loadConfigFromEnv uses AI_PROVIDER=groq tiebreaker when both keys set', () => {
  setEnv({ ISSUE_NUMBER: '1', ISSUE_TITLE: 'T', ANTHROPIC_API_KEY: 'ant-key', GROQ_API_KEY: 'groq-key', AI_PROVIDER: 'groq' });
  const config = loadConfigFromEnv();
  assert.equal(config.apiKey, 'groq-key');
});


test('loadLLMConfig uses openai/gpt-oss-120b defaults for generation and autofix', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const generationCfg = loadLLMConfig('generation');
  const autofixCfg = loadLLMConfig('autofix');
  assert.equal(generationCfg.model, 'openai/gpt-oss-120b');
  assert.equal(autofixCfg.model, 'openai/gpt-oss-120b');
});

test('loadLLMConfig returns maxInputTokens, diffRatio, feedbackRatio for autofix stage', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const cfg = loadLLMConfig('autofix');
  assert.equal(typeof cfg.maxInputTokens, 'number');
  assert.ok(cfg.maxInputTokens > 0, 'maxInputTokens should be positive');
  assert.equal(typeof cfg.diffRatio, 'number');
  assert.ok(cfg.diffRatio > 0 && cfg.diffRatio < 1, 'diffRatio must be in (0,1)');
  assert.equal(typeof cfg.feedbackRatio, 'number');
  assert.ok(cfg.feedbackRatio > 0 && cfg.feedbackRatio < 1, 'feedbackRatio must be in (0,1)');
});

test('loadLLMConfig returns undefined budget fields for stages without them', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const cfg = loadLLMConfig('generation');
  assert.equal(cfg.maxInputTokens, undefined);
  assert.equal(cfg.diffRatio, undefined);
  assert.equal(cfg.feedbackRatio, undefined);
});

test('loadLLMConfig rejects invalid max_input_tokens', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const original = GROQ_MODEL_DEFAULTS.autofix_max_input_tokens;
  GROQ_MODEL_DEFAULTS.autofix_max_input_tokens = -1;
  try {
    assert.throws(() => loadLLMConfig('autofix'), /Invalid max_input_tokens/);
  } finally {
    GROQ_MODEL_DEFAULTS.autofix_max_input_tokens = original;
  }
});

test('loadLLMConfig rejects diff_ratio outside (0,1)', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const original = GROQ_MODEL_DEFAULTS.autofix_diff_ratio;
  GROQ_MODEL_DEFAULTS.autofix_diff_ratio = 1.5;
  try {
    assert.throws(() => loadLLMConfig('autofix'), /Invalid diff_ratio/);
  } finally {
    GROQ_MODEL_DEFAULTS.autofix_diff_ratio = original;
  }
});

test('loadLLMConfig rejects feedback_ratio outside (0,1)', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const original = GROQ_MODEL_DEFAULTS.autofix_feedback_ratio;
  GROQ_MODEL_DEFAULTS.autofix_feedback_ratio = 0;
  try {
    assert.throws(() => loadLLMConfig('autofix'), /Invalid feedback_ratio/);
  } finally {
    GROQ_MODEL_DEFAULTS.autofix_feedback_ratio = original;
  }
});

test('loadLLMConfig rejects diff_ratio + feedback_ratio >= 1', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const origDiff = GROQ_MODEL_DEFAULTS.autofix_diff_ratio;
  const origFeedback = GROQ_MODEL_DEFAULTS.autofix_feedback_ratio;
  GROQ_MODEL_DEFAULTS.autofix_diff_ratio = 0.6;
  GROQ_MODEL_DEFAULTS.autofix_feedback_ratio = 0.4;
  try {
    assert.throws(() => loadLLMConfig('autofix'), /must sum to less than 1\.0/);
  } finally {
    GROQ_MODEL_DEFAULTS.autofix_diff_ratio = origDiff;
    GROQ_MODEL_DEFAULTS.autofix_feedback_ratio = origFeedback;
  }
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

// validateStartup

const STARTUP_VARS = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_PATH', 'ISSUE_NUMBER', 'ISSUE_TITLE', 'ISSUE_BODY'];

function setStartupEnv(overrides = {}) {
  const defaults = {
    GITHUB_TOKEN: 'token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: '/tmp/event.json',
    ISSUE_NUMBER: '1',
    ISSUE_TITLE: 'title',
    ISSUE_BODY: 'body',
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) process.env[k] = v;
}

function unsetStartupEnv() {
  for (const k of STARTUP_VARS) delete process.env[k];
}

test('validateStartup passes when all env vars are set and prompt files exist', () => {
  setStartupEnv();
  try {
    assert.doesNotThrow(() => validateStartup());
  } finally {
    unsetStartupEnv();
  }
});

test('validateStartup throws when GITHUB_TOKEN is missing', () => {
  setStartupEnv();
  delete process.env.GITHUB_TOKEN;
  try {
    assert.throws(() => validateStartup(), /GITHUB_TOKEN/);
  } finally {
    unsetStartupEnv();
  }
});

test('validateStartup throws when GITHUB_REPOSITORY is missing', () => {
  setStartupEnv();
  delete process.env.GITHUB_REPOSITORY;
  try {
    assert.throws(() => validateStartup(), /GITHUB_REPOSITORY/);
  } finally {
    unsetStartupEnv();
  }
});

test('validateStartup throws when GITHUB_EVENT_PATH is missing', () => {
  setStartupEnv();
  delete process.env.GITHUB_EVENT_PATH;
  try {
    assert.throws(() => validateStartup(), /GITHUB_EVENT_PATH/);
  } finally {
    unsetStartupEnv();
  }
});

test('validateStartup throws when ISSUE_NUMBER is missing', () => {
  setStartupEnv();
  delete process.env.ISSUE_NUMBER;
  try {
    assert.throws(() => validateStartup(), /ISSUE_NUMBER/);
  } finally {
    unsetStartupEnv();
  }
});

test('validateStartup throws when ISSUE_TITLE is missing', () => {
  setStartupEnv();
  delete process.env.ISSUE_TITLE;
  try {
    assert.throws(() => validateStartup(), /ISSUE_TITLE/);
  } finally {
    unsetStartupEnv();
  }
});

test('validateStartup throws when generation-system.md is missing', () => {
  setStartupEnv();
  const dir = mkdtempSync(join(tmpdir(), 'prompts-test-'));
  writeFileSync(join(dir, 'generation-user.md'), 'dummy');
  try {
    assert.throws(() => validateStartup(dir), /generation-system\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    unsetStartupEnv();
  }
});

test('validateStartup throws when generation-user.md is missing', () => {
  setStartupEnv();
  const dir = mkdtempSync(join(tmpdir(), 'prompts-test-'));
  writeFileSync(join(dir, 'generation-system.md'), 'dummy');
  try {
    assert.throws(() => validateStartup(dir), /generation-user\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    unsetStartupEnv();
  }
});


// loadLLMConfig temperature validation
// GROQ_MODEL_DEFAULTS is a mutable module-level object; we mutate generation_temperature
// in-process so the validation logic in loadLLMConfig actually runs with the desired value.

test('loadLLMConfig accepts temperature 0', () => {
  const original = GROQ_MODEL_DEFAULTS.generation_temperature;
  GROQ_MODEL_DEFAULTS.generation_temperature = 0;
  setEnv({ GROQ_API_KEY: 'groq-key' });
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
  setEnv({ GROQ_API_KEY: 'groq-key' });
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
  setEnv({ GROQ_API_KEY: 'groq-key' });
  try {
    assert.throws(() => loadLLMConfig('generation'), /Invalid temperature/);
  } finally {
    GROQ_MODEL_DEFAULTS.generation_temperature = original;
  }
});

test('loadLLMConfig rejects temperature 2.0001', () => {
  const original = GROQ_MODEL_DEFAULTS.generation_temperature;
  GROQ_MODEL_DEFAULTS.generation_temperature = 2.0001;
  setEnv({ GROQ_API_KEY: 'groq-key' });
  try {
    assert.throws(() => loadLLMConfig('generation'), /Invalid temperature/);
  } finally {
    GROQ_MODEL_DEFAULTS.generation_temperature = original;
  }
});

// ADR-0024: Groq retired qwen/qwen3-32b (2026-07-17) and llama-3.3-70b-versatile (2026-08-16).
const RETIRED_GROQ_MODELS = ['qwen/qwen3-32b', 'llama-3.3-70b-versatile'];

test('no pipeline stage defaults to a Groq model that has been retired', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  for (const stage of ['validation', 'generation', 'review', 'autofix']) {
    const { model } = loadLLMConfig(stage);
    assert.ok(!RETIRED_GROQ_MODELS.includes(model), `${stage} defaults to retired model ${model}`);
  }
});

test('loadLLMConfig returns the configured reasoningEffort for every Groq stage', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  for (const stage of ['validation', 'generation', 'review', 'autofix']) {
    assert.equal(loadLLMConfig(stage).reasoningEffort, 'low', `${stage} reasoningEffort`);
  }
});

test('loadLLMConfig returns undefined reasoningEffort when the stage key is absent', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const original = GROQ_MODEL_DEFAULTS.review_reasoning_effort;
  delete GROQ_MODEL_DEFAULTS.review_reasoning_effort;
  try {
    assert.equal(loadLLMConfig('review').reasoningEffort, undefined);
  } finally {
    GROQ_MODEL_DEFAULTS.review_reasoning_effort = original;
  }
});

test('loadLLMConfig throws on an invalid reasoning_effort value', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const original = GROQ_MODEL_DEFAULTS.review_reasoning_effort;
  GROQ_MODEL_DEFAULTS.review_reasoning_effort = 'none';
  try {
    assert.throws(() => loadLLMConfig('review'), /Invalid reasoning_effort for stage "review": none/);
  } finally {
    GROQ_MODEL_DEFAULTS.review_reasoning_effort = original;
  }
});

test('autofix token budget fits Groq free-tier 8K TPM for openai/gpt-oss-120b', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const { maxInputTokens, maxTokens } = loadLLMConfig('autofix');
  const systemTokens = estimateTokens(loadPrompt('auto-fix-system'));
  assert.ok(systemTokens + maxInputTokens + maxTokens <= 8000,
    `system (${systemTokens}) + input (${maxInputTokens}) + output (${maxTokens}) must stay within 8000 TPM`);
});

test('loadConfigFromEnv forwards the generation reasoningEffort', () => {
  setEnv({ GROQ_API_KEY: 'groq-key', ISSUE_NUMBER: '1', ISSUE_TITLE: 't' });
  try {
    assert.equal(loadConfigFromEnv().reasoningEffort, 'low');
  } finally {
    delete process.env.ISSUE_NUMBER;
    delete process.env.ISSUE_TITLE;
  }
});

test('every Groq stage sets an explicit max_tokens (reasoning tokens count toward the 8K TPM per request)', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  for (const stage of ['validation', 'generation', 'review', 'autofix']) {
    const { maxTokens } = loadLLMConfig(stage);
    assert.ok(Number.isInteger(maxTokens) && maxTokens > 0, `${stage} maxTokens must be set, got ${maxTokens}`);
  }
});

test('loadLLMConfig falls back to the global reasoning_effort key when the stage key is absent', () => {
  setEnv({ GROQ_API_KEY: 'groq-key' });
  const originalStage = GROQ_MODEL_DEFAULTS.review_reasoning_effort;
  delete GROQ_MODEL_DEFAULTS.review_reasoning_effort;
  GROQ_MODEL_DEFAULTS.reasoning_effort = 'high';
  try {
    assert.equal(loadLLMConfig('review').reasoningEffort, 'high');
  } finally {
    delete GROQ_MODEL_DEFAULTS.reasoning_effort;
    GROQ_MODEL_DEFAULTS.review_reasoning_effort = originalStage;
  }
});

test('GROQ_REASONING_EFFORT overrides the per-stage reasoning_effort for every stage', () => {
  setEnv({ GROQ_API_KEY: 'groq-key', GROQ_REASONING_EFFORT: ' High ' });
  for (const stage of ['validation', 'generation', 'review', 'autofix']) {
    assert.equal(loadLLMConfig(stage).reasoningEffort, 'high', `${stage} reasoningEffort`);
  }
});

test('GROQ_REASONING_EFFORT=off drops reasoningEffort (non-reasoning GROQ_MODEL override)', () => {
  setEnv({ GROQ_API_KEY: 'groq-key', GROQ_MODEL: 'some-non-reasoning-model', GROQ_REASONING_EFFORT: 'off' });
  for (const stage of ['validation', 'generation', 'review', 'autofix']) {
    assert.equal(loadLLMConfig(stage).reasoningEffort, undefined, `${stage} reasoningEffort`);
  }
});

test('GROQ_REASONING_EFFORT set to an empty string falls back to models.yaml', () => {
  setEnv({ GROQ_API_KEY: 'groq-key', GROQ_REASONING_EFFORT: '' });
  assert.equal(loadLLMConfig('review').reasoningEffort, 'low');
});

test('loadLLMConfig throws on an invalid GROQ_REASONING_EFFORT value', () => {
  setEnv({ GROQ_API_KEY: 'groq-key', GROQ_REASONING_EFFORT: 'none' });
  assert.throws(() => loadLLMConfig('review'), /Invalid reasoning_effort for stage "review": none \(must be low, medium, high or off\)/);
});

test('loadLLMConfig ignores GROQ_REASONING_EFFORT for the anthropic provider', () => {
  setEnv({ ANTHROPIC_API_KEY: 'ant-key', AI_PROVIDER: 'anthropic', GROQ_REASONING_EFFORT: 'high' });
  assert.equal(loadLLMConfig('review').reasoningEffort, undefined);
});
