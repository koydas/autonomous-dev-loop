// ADR-0025: validate_issue and generate_issue_change must forward the stage config
// (model, max_tokens, reasoning_effort) to Groq. pr_review and auto_fix_pr are covered
// in their own test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function startGroqMock(content) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.requests = requests;
      resolve(server);
    });
  });
}

function runScript(scriptName, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, scriptName)], {
      cwd,
      env: { PATH: process.env.PATH, METRICS_FILE: '/dev/null', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function runAgainstMock(scriptName, content, extraEnv = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reasoning-wiring-'));
  const server = await startGroqMock(content);
  try {
    const result = await runScript(scriptName, tmpDir, {
      GROQ_API_KEY: 'groq-test',
      GROQ_API_URL: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      GROQ_MAX_RETRIES: '0',
      ISSUE_NUMBER: '1',
      ISSUE_TITLE: 'Add a helper',
      ISSUE_BODY: '- [ ] helper exists',
      ...extraEnv,
    });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.equal(server.requests.length, 1, 'expected exactly one Groq call');
    return JSON.parse(server.requests[0].body);
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const VALIDATION_RESPONSE = JSON.stringify({ valid: true, score: 90, blockers: [], warnings: [], suggested_ac: [] });
const GENERATION_RESPONSE = JSON.stringify({ summary: 'add helper', changes: [{ target_path: 'out.txt', file_content: 'x' }] });
const GENERATION_ENV = { GITHUB_TOKEN: 'tok', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: '/dev/null' };

test('validate_issue sends model, max_tokens and reasoning_effort from models.yaml to Groq', async () => {
  const body = await runAgainstMock('validate_issue.mjs', VALIDATION_RESPONSE);
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 1024);
});

test('generate_issue_change sends model, max_tokens and reasoning_effort from models.yaml to Groq', async () => {
  const body = await runAgainstMock('generate_issue_change.mjs', GENERATION_RESPONSE, GENERATION_ENV);
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 4096);
});

test('validate_issue omits reasoning_effort when GROQ_REASONING_EFFORT=off', async () => {
  const body = await runAgainstMock('validate_issue.mjs', VALIDATION_RESPONSE, { GROQ_REASONING_EFFORT: 'off' });
  assert.equal('reasoning_effort' in body, false);
});

test('generate_issue_change honors the GROQ_REASONING_EFFORT override', async () => {
  const body = await runAgainstMock('generate_issue_change.mjs', GENERATION_RESPONSE, { ...GENERATION_ENV, GROQ_REASONING_EFFORT: 'medium' });
  assert.equal(body.reasoning_effort, 'medium');
});
