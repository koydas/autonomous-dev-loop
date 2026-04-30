/**
 * Smoke tests: end-to-end pipeline coverage with mocked LLM.
 *
 * Unlike unit tests (which test functions in isolation), these tests exercise
 * multiple modules together using real config files and real prompt templates.
 * They catch integration failures that unit tests cannot — e.g. a prompt
 * placeholder that no longer matches what the code passes in.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLLMConfig, loadLabelsConfig, GROQ_MODEL_DEFAULTS } from '../lib/config.mjs';
import { loadPrompt, interpolatePrompt } from '../lib/prompts.mjs';
import {
  validateIssue,
  buildValidationUserPrompt,
  parseGroqResponse,
  formatGitHubComment,
} from '../lib/issue_validator.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles } from '../lib/output_writer.mjs';
import { buildDeterministicPrompt } from '../lib/config.mjs';

const PIPELINE_STAGES = ['validation', 'generation', 'review', 'autofix'];
const ALL_PROMPTS = [
  'validation-system',
  'validation-user',
  'generation-system',
  'generation-user',
  'pr-review-system',
  'pr-review-user',
  'auto-fix-system',
  'auto-fix-user',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Env vars to restore after each test that mutates process.env */
const ENV_VARS = ['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER', 'GROQ_MODEL', 'ANTHROPIC_MODEL'];

function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
function restoreEnv(snapshot) {
  for (const k of ENV_VARS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
}

// ---------------------------------------------------------------------------
// 1. Config files — models.yaml and labels.yaml integrity
// ---------------------------------------------------------------------------

test('models.yaml: all pipeline stages have a model defined', () => {
  for (const stage of PIPELINE_STAGES) {
    assert.ok(
      GROQ_MODEL_DEFAULTS[stage],
      `Expected GROQ_MODEL_DEFAULTS["${stage}"] to be defined in models.yaml`,
    );
  }
});

test('models.yaml: all pipeline stages have a temperature defined', () => {
  for (const stage of PIPELINE_STAGES) {
    const key = `${stage}_temperature`;
    assert.ok(
      GROQ_MODEL_DEFAULTS[key] !== undefined,
      `Expected GROQ_MODEL_DEFAULTS["${key}"] in models.yaml`,
    );
  }
});

test('labels.yaml: issue group has valid and invalid labels with required fields', () => {
  const issueLabels = loadLabelsConfig('issue');
  for (const key of ['valid', 'invalid']) {
    assert.ok(issueLabels[key], `Expected issue.${key} label`);
    assert.ok(issueLabels[key].name, `Expected issue.${key}.name`);
    assert.ok(issueLabels[key].color, `Expected issue.${key}.color`);
    assert.ok(issueLabels[key].description, `Expected issue.${key}.description`);
  }
});

test('labels.yaml: review group has approved and changes labels', () => {
  const reviewLabels = loadLabelsConfig('review');
  assert.ok(reviewLabels.approved?.name);
  assert.ok(reviewLabels.changes?.name);
});

test('labels.yaml: autofix group has attempt1, attempt2, attempt3 labels', () => {
  const autofixLabels = loadLabelsConfig('autofix');
  for (const key of ['attempt1', 'attempt2', 'attempt3']) {
    assert.ok(autofixLabels[key]?.name, `Expected autofix.${key}.name`);
  }
});

// ---------------------------------------------------------------------------
// 2. Prompt files — all prompts load and contain expected placeholders
// ---------------------------------------------------------------------------

test('all prompt files load without error', () => {
  for (const name of ALL_PROMPTS) {
    const content = loadPrompt(name);
    assert.ok(typeof content === 'string' && content.length > 0, `Prompt "${name}" is empty or failed to load`);
  }
});

test('validation-user prompt contains {{issueTitle}} and {{issueBody}}', () => {
  const tmpl = loadPrompt('validation-user');
  assert.ok(tmpl.includes('{{issueTitle}}'));
  assert.ok(tmpl.includes('{{issueBody}}'));
});

test('generation-user prompt contains {{issueNumber}}, {{issueTitle}}, {{issueBody}}, {{fileContents}}', () => {
  const tmpl = loadPrompt('generation-user');
  assert.ok(tmpl.includes('{{issueNumber}}'));
  assert.ok(tmpl.includes('{{issueTitle}}'));
  assert.ok(tmpl.includes('{{issueBody}}'));
  assert.ok(tmpl.includes('{{fileContents}}'));
});

test('pr-review-user prompt contains {{issueTitle}}, {{issueBody}}, {{diff}}', () => {
  const tmpl = loadPrompt('pr-review-user');
  assert.ok(tmpl.includes('{{issueTitle}}'));
  assert.ok(tmpl.includes('{{issueBody}}'));
  assert.ok(tmpl.includes('{{diff}}'));
});

test('auto-fix-user prompt contains {{reviewFeedback}}, {{diff}}, {{fileContents}}', () => {
  const tmpl = loadPrompt('auto-fix-user');
  assert.ok(tmpl.includes('{{reviewFeedback}}'));
  assert.ok(tmpl.includes('{{diff}}'));
  assert.ok(tmpl.includes('{{fileContents}}'));
});

// ---------------------------------------------------------------------------
// 3. Issue validation pipeline (real prompts + mocked LLM)
// ---------------------------------------------------------------------------

test('validation pipeline: valid issue end-to-end', async () => {
  const issueTitle = 'Add login endpoint with JWT authentication';
  const issueBody = [
    '## Acceptance Criteria',
    '- [ ] POST /api/login accepts email and password',
    '- [ ] Returns a signed JWT on success',
    '- [ ] Returns 401 on invalid credentials',
  ].join('\n');

  const mockLLM = async () =>
    JSON.stringify({
      valid: true,
      score: 88,
      blockers: [],
      warnings: ['Consider rate-limiting the endpoint'],
      suggested_ac: ['Endpoint rejects empty credentials', 'Token expiry is configurable'],
    });

  const result = await validateIssue({ issueTitle, issueBody, callGroq: mockLLM });

  assert.equal(result.valid, true);
  assert.equal(result.score, 88);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.warnings.length, 1);

  const comment = formatGitHubComment(result, issueTitle);
  assert.ok(comment.includes('✅'), 'Comment should show ✅ for valid issue');
  assert.ok(comment.includes('88/100'), 'Comment should include score');
  assert.ok(comment.includes('Suggested Acceptance Criteria'));
});

test('validation pipeline: invalid issue end-to-end', async () => {
  const issueTitle = 'Fix the bug';
  const issueBody = '';

  const mockLLM = async () =>
    JSON.stringify({
      valid: false,
      score: 25,
      blockers: ['Title is too vague to determine scope', 'No acceptance criteria provided'],
      warnings: [],
      suggested_ac: ['Define which bug is being fixed', 'Add steps to reproduce'],
    });

  const result = await validateIssue({ issueTitle, issueBody, callGroq: mockLLM });

  assert.equal(result.valid, false);
  assert.equal(result.blockers.length, 2);

  const comment = formatGitHubComment(result, issueTitle);
  assert.ok(comment.includes('🚫'), 'Comment should show 🚫 for invalid issue');
  assert.ok(comment.includes('Blockers'));
  assert.ok(comment.includes('Next step'), 'Invalid comment should include next step guidance');
});

test('validation pipeline: real prompt template is used (not a stub)', () => {
  const prompt = buildValidationUserPrompt('Add search feature', 'Users need to search items');
  assert.ok(prompt.includes('Add search feature'), 'Prompt must contain the issue title');
  assert.ok(prompt.includes('Users need to search items'), 'Prompt must contain the issue body');
  assert.ok(!prompt.includes('{{issueTitle}}'), 'Placeholders must be fully substituted');
  assert.ok(!prompt.includes('{{issueBody}}'), 'Placeholders must be fully substituted');
});

// ---------------------------------------------------------------------------
// 4. Code generation output pipeline (real validate + write)
// ---------------------------------------------------------------------------

let tmpDir;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-test-'));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true }).catch(() => {});
});

test('generation pipeline: realistic LLM JSON response is parsed, validated, and written', async () => {
  const llmResponse = JSON.stringify({
    summary: 'Add a utility module for string formatting',
    changes: [
      {
        target_path: 'src/utils/format.js',
        file_content: 'export function capitalize(str) {\n  return str.charAt(0).toUpperCase() + str.slice(1);\n}\n',
      },
      {
        target_path: 'src/utils/format.test.js',
        file_content: "import { capitalize } from './format.js';\nconsole.assert(capitalize('hello') === 'Hello');\n",
      },
    ],
  });

  const parsed = parseJsonResponse(llmResponse);
  const { summary, changes } = validateAiOutput(parsed);

  assert.equal(summary, 'Add a utility module for string formatting');
  assert.equal(changes.length, 2);
  assert.equal(changes[0].targetPath, 'src/utils/format.js');

  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const writtenPaths = await writeGeneratedFiles(changes);
    assert.equal(writtenPaths.length, 2);

    const content = await fs.readFile(path.join(tmpDir, 'src/utils/format.js'), 'utf8');
    assert.ok(content.includes('capitalize'));
  } finally {
    process.chdir(originalCwd);
  }
});

test('generation pipeline: LLM response wrapped in markdown fences is handled', () => {
  const llmResponse = [
    '```json',
    '{"summary":"Fix typo in readme","changes":[{"target_path":"README.md","file_content":"# My Project\\n"}]}',
    '```',
  ].join('\n');

  const parsed = parseJsonResponse(llmResponse);
  assert.equal(parsed.summary, 'Fix typo in readme');
});

// ---------------------------------------------------------------------------
// 5. buildDeterministicPrompt uses real generation-user.md template
// ---------------------------------------------------------------------------

test('buildDeterministicPrompt: all placeholders are substituted in the real template', () => {
  const prompt = buildDeterministicPrompt({
    issueNumber: '42',
    issueTitle: 'Implement dark mode toggle',
    issueBody: 'Users want a dark mode toggle in the settings panel.',
    fileContents: '// No existing files relevant to this issue.',
  });

  assert.ok(prompt.includes('42'), 'Issue number must appear in prompt');
  assert.ok(prompt.includes('Implement dark mode toggle'), 'Issue title must appear in prompt');
  assert.ok(prompt.includes('Users want a dark mode toggle'), 'Issue body must appear in prompt');
  assert.ok(!prompt.includes('{{issueNumber}}'), 'No unsubstituted placeholders');
  assert.ok(!prompt.includes('{{issueTitle}}'), 'No unsubstituted placeholders');
  assert.ok(!prompt.includes('{{issueBody}}'), 'No unsubstituted placeholders');
  assert.ok(!prompt.includes('{{fileContents}}'), 'No unsubstituted placeholders');
});

test('buildDeterministicPrompt: output schema keys appear in the prompt', () => {
  const prompt = buildDeterministicPrompt({
    issueNumber: '1',
    issueTitle: 'T',
    issueBody: 'B',
  });

  assert.ok(prompt.includes('summary'), 'Prompt must include output schema key: summary');
  assert.ok(prompt.includes('target_path'), 'Prompt must include output schema key: target_path');
  assert.ok(prompt.includes('file_content'), 'Prompt must include output schema key: file_content');
});

// ---------------------------------------------------------------------------
// 6. LLM config loading per stage with real models.yaml
// ---------------------------------------------------------------------------

test('loadLLMConfig: groq — all stages produce a valid config shape', () => {
  const snapshot = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  try {
    setEnv({ GROQ_API_KEY: 'test-groq-key' });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_PROVIDER;

    for (const stage of PIPELINE_STAGES) {
      const cfg = loadLLMConfig(stage);
      assert.equal(cfg.provider, 'groq');
      assert.equal(cfg.apiKey, 'test-groq-key');
      assert.ok(typeof cfg.model === 'string' && cfg.model.length > 0, `Stage "${stage}" must have a model`);
      if (cfg.temperature !== undefined) {
        assert.ok(
          typeof cfg.temperature === 'number' && cfg.temperature >= 0 && cfg.temperature <= 2,
          `Stage "${stage}" temperature must be 0–2`,
        );
      }
    }
  } finally {
    restoreEnv(snapshot);
  }
});

test('loadLLMConfig: anthropic — all stages produce a valid config shape', () => {
  const snapshot = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  try {
    setEnv({ ANTHROPIC_API_KEY: 'test-ant-key', AI_PROVIDER: 'anthropic' });
    delete process.env.GROQ_API_KEY;

    for (const stage of PIPELINE_STAGES) {
      const cfg = loadLLMConfig(stage);
      assert.equal(cfg.provider, 'anthropic');
      assert.equal(cfg.apiKey, 'test-ant-key');
      assert.ok(typeof cfg.model === 'string' && cfg.model.length > 0);
    }
  } finally {
    restoreEnv(snapshot);
  }
});

test('loadLLMConfig: autofix stage has maxTokens set from models.yaml', () => {
  const snapshot = Object.fromEntries(ENV_VARS.map((k) => [k, process.env[k]]));
  try {
    setEnv({ GROQ_API_KEY: 'test-key' });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AI_PROVIDER;

    const cfg = loadLLMConfig('autofix');
    assert.ok(typeof cfg.maxTokens === 'number' && cfg.maxTokens > 0, 'autofix stage must have maxTokens');
  } finally {
    restoreEnv(snapshot);
  }
});
