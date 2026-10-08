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
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadLLMConfig, loadLabelsConfig, GROQ_MODEL_DEFAULTS } from '../lib/config.mjs';
import { loadPrompt, interpolatePrompt } from '../lib/prompts.mjs';
import {
  validateIssue,
  buildValidationUserPrompt,
  parseGroqResponse,
  formatGitHubComment,
} from '../lib/issue_validator.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles, PROTECTED_WRITE_PATHS } from '../lib/output_writer.mjs';
import { buildDeterministicPrompt } from '../lib/config.mjs';
import { createTracer } from '../lib/observability.mjs';
import { parseEvidenceConfig } from '../lib/review_evidence.mjs';

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

test('review-evidence.yaml: declares at least one check with a command', async () => {
  const checks = parseEvidenceConfig(await fs.readFile(path.join(ROOT_DIR, 'config/review-evidence.yaml'), 'utf8'));
  assert.ok(checks.length > 0);
  for (const c of checks) assert.ok(c.command, `Expected checks.${c.name}.command`);
});

test('labels.yaml: review group has approved and changes labels', () => {
  const reviewLabels = loadLabelsConfig('review');
  assert.ok(reviewLabels.approved?.name);
  assert.ok(reviewLabels.changes?.name);
});

test('labels.yaml: review group has a withheld label distinct from approved and changes (ADR-0026)', () => {
  const reviewLabels = loadLabelsConfig('review');
  assert.ok(reviewLabels.withheld?.name, 'review.withheld.name is required');
  assert.ok(reviewLabels.withheld.color && reviewLabels.withheld.description);
  assert.notEqual(reviewLabels.withheld.name, reviewLabels.approved.name);
  assert.notEqual(reviewLabels.withheld.name, reviewLabels.changes.name);
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

// ---------------------------------------------------------------------------
// 7. Observability smoke: trace file written after full pipeline run
// ---------------------------------------------------------------------------

test('observability: trace file exists and contains all expected spans after full mocked pipeline run', async () => {
  const runId = `smoke-${Date.now()}`;
  const smokeTraceDir = path.join(tmpDir, 'traces');
  const EXPECTED_STAGES = ['issue_validation', 'code_gen', 'pr_prepare', 'review', 'autofix'];

  const tracer = createTracer({ runId, issueNumber: 42, traceDir: smokeTraceDir });

  // Simulate each pipeline stage
  tracer.startSpan('issue_validation', { issueNumber: '42' });
  tracer.endSpan('issue_validation', { outcome: 'success', meta: { score: 85 } });

  tracer.startSpan('code_gen', { issueNumber: '42', model: 'test-model' });
  tracer.endSpan('code_gen', { outcome: 'success', meta: { changes_count: 2 } });

  tracer.startSpan('pr_prepare', { changes_count: 2 });
  tracer.endSpan('pr_prepare', { outcome: 'success', meta: { paths: ['src/foo.mjs'] } });

  tracer.startSpan('review', { prNumber: 1 });
  tracer.endSpan('review', { outcome: 'success', meta: { verdict: 'APPROVE', attempt: 1 } });

  tracer.startSpan('autofix', { prNumber: 1, attempt: 1 });
  tracer.endSpan('autofix', { outcome: 'success', meta: { attempt: 1 } });

  await tracer.finalize('success');

  // Assert trace file exists
  const tracePath = path.join(smokeTraceDir, `${runId}.json`);
  const stat = await fs.stat(tracePath);
  assert.ok(stat.isFile(), 'trace file must exist after finalize()');

  // Assert structure
  const trace = JSON.parse(await fs.readFile(tracePath, 'utf8'));
  assert.equal(trace.run_id, runId);
  assert.equal(trace.issue_number, 42);
  assert.equal(trace.outcome, 'success');
  assert.ok(typeof trace.started_at === 'string');
  assert.ok(typeof trace.completed_at === 'string');

  // Assert all expected stages have spans with outcome populated
  for (const stage of EXPECTED_STAGES) {
    const span = trace.spans.find(s => s.stage === stage);
    assert.ok(span, `trace must contain a span for stage "${stage}"`);
    assert.ok(span.outcome !== null && span.outcome !== undefined, `span "${stage}" must have outcome populated`);
    assert.ok(typeof span.started_at === 'string', `span "${stage}" must have started_at`);
    assert.ok(typeof span.completed_at === 'string', `span "${stage}" must have completed_at`);
    assert.ok(typeof span.duration_ms === 'number', `span "${stage}" must have duration_ms`);
  }
});

test('observability: trace file outcome is "partial" when validation fails', async () => {
  const runId = `smoke-fail-${Date.now()}`;
  const smokeTraceDir = path.join(tmpDir, 'traces');

  const tracer = createTracer({ runId, issueNumber: 99, traceDir: smokeTraceDir });

  tracer.startSpan('issue_validation', { issueNumber: '99' });
  tracer.endSpan('issue_validation', { outcome: 'failed', meta: { score: 20, valid: false } });

  await tracer.finalize('partial');

  const trace = JSON.parse(await fs.readFile(path.join(smokeTraceDir, `${runId}.json`), 'utf8'));
  assert.equal(trace.outcome, 'partial');
  assert.equal(trace.spans[0].outcome, 'failed');
});

// ADR-0021: the model must be told about every protected path the writer rejects,
// otherwise the whole patch fails at validation instead of being steered away.
for (const name of ['generation-system', 'auto-fix-system']) {
  test(`${name} prompt lists every PROTECTED_WRITE_PATHS entry`, () => {
    const prompt = loadPrompt(name);
    for (const entry of PROTECTED_WRITE_PATHS) {
      assert.ok(prompt.includes(`\`${entry}\``), `${name}.md must mention protected path \`${entry}\``);
    }
  });
}

// ---------------------------------------------------------------------------
// Generation entrypoint, real prompts and config, LLM and GitHub mocked (ADR-0019)
// ---------------------------------------------------------------------------

// Runs scripts/generate_issue_change.mjs in a scratch repo against one mock server that answers
// the Anthropic call with `changes` and records the GitHub calls.
async function runGeneration(changes, { files = {}, issueBody = 'Add a helper.', githubStatus = 201 } = {}) {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-gen-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
    await fs.writeFile(path.join(repoDir, rel), content);
  }
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(req.url === '/v1/messages' ? 200 : githubStatus, { 'Content-Type': 'application/json' });
      res.end(req.url === '/v1/messages'
        ? JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ summary: 'Add a helper', changes }) }] })
        : '{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const outputFile = path.join(repoDir, '..', `${path.basename(repoDir)}-output.txt`);
  const metricsFile = path.join(repoDir, '..', `${path.basename(repoDir)}-metrics.jsonl`);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT_DIR, 'scripts', 'generate_issue_change.mjs')], {
        cwd: repoDir,
        env: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_EVENT_PATH: '/dev/null',
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          GITHUB_OUTPUT: outputFile,
          ANTHROPIC_API_KEY: 'test-key',
          ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
          METRICS_FILE: metricsFile,
          CHECKPOINT_RUN_ID: 'smoke-gen',
          ISSUE_NUMBER: '7',
          ISSUE_TITLE: 'Add helper',
          ISSUE_BODY: issueBody,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stderr }));
    });
    const read = (file) => fs.readFile(file, 'utf8').catch(() => null);
    return { result, requests, repoDir, output: await read(outputFile), metrics: await read(metricsFile), readRepo: (rel) => read(path.join(repoDir, rel)) };
  } finally {
    server.close();
  }
}

test('generation entrypoint: a generated diff adding require( to an .mjs file is rejected without writing', async () => {
  const run = await runGeneration([
    { target_path: 'src/helper.mjs', file_content: "const fs = require('node:fs');\nexport const read = (p) => fs.readFileSync(p, 'utf8');\n" },
    { target_path: 'src/other.mjs', file_content: 'export const ok = 1;\n' },
  ]);
  try {
    assert.equal(run.result.code, 0, `expected exit 0, stderr: ${run.result.stderr}`);
    assert.equal(await run.readRepo('src/helper.mjs'), null, 'nothing is written');
    assert.equal(await run.readRepo('src/other.mjs'), null, 'no partial patch');
    assert.match(run.output, /^rejected=true$/m);
    assert.doesNotMatch(run.output, /generated_paths/);
    const comment = run.requests.find((r) => r.method === 'POST' && /\/issues\/7\/comments$/.test(r.url));
    assert.match(JSON.parse(comment.body).body, /Code Generation: Patch Rejected[\s\S]*module_system[\s\S]*src\/helper\.mjs`: adds require\(\) to an ES module/);
    const labels = run.requests.find((r) => r.method === 'POST' && /\/issues\/7\/labels$/.test(r.url));
    assert.deepEqual(JSON.parse(labels.body).labels, [loadLabelsConfig('autofix').needs_human.name]);
    const metric = JSON.parse(run.metrics.trim());
    assert.equal(metric.type, 'codegen_skip');
    assert.equal(metric.reason, 'guardrail_rejected');
    assert.deepEqual(metric.rules, ['module_system']);
    assert.match(run.result.stderr, /"event":"pr_prepare\.skipped"/);
  } finally {
    await fs.rm(run.repoDir, { recursive: true, force: true });
  }
});

test('generation entrypoint: a protected-path rejection is escalated the same way instead of failing', async () => {
  const run = await runGeneration([{ target_path: 'README.md', file_content: '# stub\n' }]);
  try {
    assert.equal(run.result.code, 0, `expected exit 0, stderr: ${run.result.stderr}`);
    assert.deepEqual(JSON.parse(run.metrics.trim()).rules, ['protected_path']);
    assert.match(run.result.stderr, /"event":"code_gen\.skipped"/);
  } finally {
    await fs.rm(run.repoDir, { recursive: true, force: true });
  }
});

test('generation entrypoint: a failed escalation still ends the stage with a terminal error event', async () => {
  const run = await runGeneration(
    [{ target_path: 'src/helper.mjs', file_content: "const fs = require('node:fs');\n" }],
    { githubStatus: 403 },
  );
  try {
    assert.equal(run.result.code, 1);
    assert.match(run.result.stderr, /"event":"pr_prepare\.error".*Label create failed/);
    assert.equal(await run.readRepo('src/helper.mjs'), null, 'nothing is written');
    assert.equal(run.metrics, null, 'no metric for an escalation that did not happen');
  } finally {
    await fs.rm(run.repoDir, { recursive: true, force: true });
  }
});

test('generation entrypoint: a patch that passes every guardrail is written and no GitHub call is made', async () => {
  const run = await runGeneration(
    [{ target_path: 'src/helper.mjs', file_content: "import fs from 'node:fs';\nimport { x } from './x.mjs';\nexport function read(p) { return fs.readFileSync(p) + x; }\n" }],
    { files: { 'src/x.mjs': 'export const x = 1;\n' } },
  );
  try {
    assert.equal(run.result.code, 0, `expected exit 0, stderr: ${run.result.stderr}`);
    assert.match(await run.readRepo('src/helper.mjs'), /readFileSync/);
    assert.match(run.output, /generated_paths<<EOF\nsrc\/helper\.mjs\nEOF/);
    assert.doesNotMatch(run.output, /rejected=true/);
    assert.deepEqual(run.requests.filter((r) => r.url !== '/v1/messages'), []);
  } finally {
    await fs.rm(run.repoDir, { recursive: true, force: true });
  }
});

test('generation entrypoint: an existing file the issue never showed cannot be rewritten (ADR-0029 on generation)', async () => {
  const run = await runGeneration(
    [{ target_path: 'src/legacy.js', file_content: 'invented\n' }],
    { files: { 'src/legacy.js': 'keep me\n' } },
  );
  try {
    assert.equal(run.result.code, 0, `expected exit 0, stderr: ${run.result.stderr}`);
    assert.equal(await run.readRepo('src/legacy.js'), 'keep me\n');
    assert.deepEqual(JSON.parse(run.metrics.trim()).rules, ['unshown_file']);
  } finally {
    await fs.rm(run.repoDir, { recursive: true, force: true });
  }
});

