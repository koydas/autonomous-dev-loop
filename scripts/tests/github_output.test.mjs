import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function startAnthropicMock(content) {
  const body = JSON.stringify({ content: [{ type: 'text', text: content }] });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function runScript(scriptName, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, scriptName)], {
      env: { PATH: process.env.PATH, ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('validate_issue.mjs writes valid/score/comment to GITHUB_OUTPUT', async () => {
  const groqContent = JSON.stringify({
    valid: true,
    score: 80,
    blockers: [],
    warnings: [],
    suggested_ac: [],
  });
  const server = await startAnthropicMock(groqContent);
  const port = server.address().port;
  const outputFile = path.join(os.tmpdir(), `gh-output-validate-${Date.now()}.txt`);
  await fs.writeFile(outputFile, '');

  try {
    const result = await runScript('validate_issue.mjs', {
      ANTHROPIC_API_KEY: 'test-key',
      ISSUE_NUMBER: '42',
      ISSUE_TITLE: 'Add login feature',
      ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
      GITHUB_OUTPUT: outputFile,
    });

    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const output = await fs.readFile(outputFile, 'utf8');
    assert.ok(output.includes('valid=true'), `expected valid=true in output, got:\n${output}`);
    assert.ok(output.includes('score=80'), `expected score=80 in output, got:\n${output}`);
    assert.ok(output.includes('comment<<EOF'), `expected comment<<EOF in output, got:\n${output}`);
  } finally {
    server.close();
    await fs.unlink(outputFile).catch(() => {});
  }
});

test('generate_issue_change.mjs exits 0 when GITHUB_OUTPUT is not set', async () => {
  const groqContent = JSON.stringify({
    summary: 'Simple change',
    changes: [{ target_path: 'src/noop.js', file_content: 'const x = 1;' }],
  });
  const server = await startAnthropicMock(groqContent);
  const port = server.address().port;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-no-output-'));
  try {
    const result = await runScript(
      'generate_issue_change.mjs',
      {
        ANTHROPIC_API_KEY: 'test-key',
        ISSUE_NUMBER: '1',
        ISSUE_TITLE: 'Simple change',
        ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
      },
      tmpDir,
    );
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('generate_issue_change.mjs exits 1 when LLM returns JSON null', async () => {
  const server = await startAnthropicMock('null');
  const port = server.address().port;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-null-'));
  try {
    const result = await runScript(
      'generate_issue_change.mjs',
      {
        ANTHROPIC_API_KEY: 'test-key',
        ISSUE_NUMBER: '1',
        ISSUE_TITLE: 'T',
        ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
      },
      tmpDir,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /AI response JSON must be an object/);
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('generate_issue_change.mjs exits 1 when LLM returns a JSON array', async () => {
  const server = await startAnthropicMock('[]');
  const port = server.address().port;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-array-'));
  try {
    const result = await runScript(
      'generate_issue_change.mjs',
      {
        ANTHROPIC_API_KEY: 'test-key',
        ISSUE_NUMBER: '1',
        ISSUE_TITLE: 'T',
        ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
      },
      tmpDir,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /AI response JSON must be an object/);
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('generate_issue_change.mjs writes checkpoint at CHECKPOINT_RUN_ID path when set', async () => {
  const groqContent = JSON.stringify({
    summary: 'Checkpoint test',
    changes: [{ target_path: 'src/chk.js', file_content: 'const chk = 1;' }],
  });
  const server = await startAnthropicMock(groqContent);
  const port = server.address().port;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-checkpoint-'));
  try {
    const result = await runScript(
      'generate_issue_change.mjs',
      {
        ANTHROPIC_API_KEY: 'test-key',
        ISSUE_NUMBER: '99',
        ISSUE_TITLE: 'T',
        ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
        CHECKPOINT_RUN_ID: 'custom-run-123',
      },
      tmpDir,
    );
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const checkpointPath = path.join(tmpDir, 'checkpoints', 'custom-run-123', 'generate.json');
    const raw = await fs.readFile(checkpointPath, 'utf8');
    const checkpoint = JSON.parse(raw);
    assert.equal(checkpoint.step, 'generate');
    assert.equal(checkpoint.data.summary, 'Checkpoint test');
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('generate_issue_change.mjs writes summary/generated_paths to GITHUB_OUTPUT', async () => {
  const groqContent = JSON.stringify({
    summary: 'Implement login feature',
    changes: [{ target_path: 'src/login.js', file_content: 'export function login() {}' }],
  });
  const server = await startAnthropicMock(groqContent);
  const port = server.address().port;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-output-gen-'));
  const outputFile = path.join(os.tmpdir(), `gh-output-generate-${Date.now()}.txt`);
  await fs.writeFile(outputFile, '');

  try {
    const result = await runScript(
      'generate_issue_change.mjs',
      {
        ANTHROPIC_API_KEY: 'test-key',
        ISSUE_NUMBER: '42',
        ISSUE_TITLE: 'Add login feature',
        ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
        GITHUB_OUTPUT: outputFile,
      },
      tmpDir,
    );

    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const output = await fs.readFile(outputFile, 'utf8');
    assert.ok(output.includes('summary<<EOF'), `expected summary<<EOF in output, got:\n${output}`);
    assert.ok(
      output.includes('Implement login feature'),
      `expected summary value in output, got:\n${output}`,
    );
    assert.ok(
      output.includes('generated_paths<<EOF'),
      `expected generated_paths<<EOF in output, got:\n${output}`,
    );
    assert.ok(output.includes('src/login.js'), `expected file path in output, got:\n${output}`);
  } finally {
    server.close();
    await fs.unlink(outputFile).catch(() => {});
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});
