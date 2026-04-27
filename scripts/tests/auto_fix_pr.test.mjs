import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PR_NUMBER = 55;
const REVIEW_ID = 42;

function startMockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (d) => (rawBody += d));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: rawBody });
      handler(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.requests = requests;
      resolve(server);
    });
  });
}

function anthropicJson(text) {
  return JSON.stringify({ content: [{ type: 'text', text }] });
}

function validLLMJson(filePath = 'fix-output.txt') {
  return anthropicJson(
    JSON.stringify({
      summary: 'Fixed the reported issue',
      changes: [{ target_path: filePath, file_content: 'fixed content' }],
    }),
  );
}

function makeHandler({
  labelsStatus = 200,
  labelsBody = '[]',
  inlineCommentsStatus = 200,
  inlineCommentsBody = '[]',
  diffStatus = 200,
  diffBody = '--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n+added line\n',
  llmResponse = null,
  labelCreateStatus = 201,
  applyLabelStatus = 200,
  postCommentStatus = 201,
  commentsStatus = 200,
  commentsBody = '[]',
} = {}) {
  return (req, res) => {
    const { method, url } = req;

    if (url === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(llmResponse ?? validLLMJson());
    }

    if (method === 'GET' && /\/issues\/\d+\/labels$/.test(url)) {
      res.writeHead(labelsStatus, { 'Content-Type': 'application/json' });
      return res.end(labelsStatus < 300 ? labelsBody : 'Internal Server Error');
    }

    if (method === 'GET' && /\/reviews\/\d+\/comments$/.test(url)) {
      res.writeHead(inlineCommentsStatus, { 'Content-Type': 'application/json' });
      return res.end(inlineCommentsStatus < 300 ? inlineCommentsBody : 'error');
    }

    if (method === 'GET' && /\/pulls\/\d+$/.test(url)) {
      res.writeHead(diffStatus);
      return res.end(diffStatus < 300 ? diffBody : 'Forbidden');
    }

    if (method === 'POST' && /\/issues\/\d+\/comments$/.test(url)) {
      res.writeHead(postCommentStatus, { 'Content-Type': 'application/json' });
      return res.end(postCommentStatus < 300 ? '{"id":1}' : 'error');
    }

    if (method === 'GET' && /\/issues\/\d+\/comments\?per_page=100$/.test(url)) {
      res.writeHead(commentsStatus, { 'Content-Type': 'application/json' });
      return res.end(commentsStatus < 300 ? commentsBody : 'error');
    }

    if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/labels$/.test(url)) {
      res.writeHead(labelCreateStatus, { 'Content-Type': 'application/json' });
      return res.end(labelCreateStatus < 300 ? '{"id":1}' : 'error');
    }

    if (method === 'POST' && /\/issues\/\d+\/labels$/.test(url)) {
      res.writeHead(applyLabelStatus, { 'Content-Type': 'application/json' });
      return res.end(applyLabelStatus < 300 ? '[]' : 'error');
    }

    res.writeHead(404);
    res.end('not found');
  };
}

async function writeEventFile(prNumber = PR_NUMBER, reviewId = REVIEW_ID) {
  const tmpFile = path.join(os.tmpdir(), `auto-fix-evt-${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(
    tmpFile,
    JSON.stringify({
      pull_request: { number: prNumber },
      review: { id: reviewId, body: 'Fix the bug on line 5.', state: 'changes_requested' },
    }),
  );
  return tmpFile;
}

async function runAutoFix(port, eventFile, { extraEnv = {}, cwd = null } = {}) {
  const env = {
    PATH: process.env.PATH,
    GITHUB_TOKEN: 'test-token',
    ANTHROPIC_API_KEY: 'test-key',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, 'auto_fix_pr.mjs')], {
      env,
      cwd: cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('auto_fix_pr exits 1 when label list fetch fails', async () => {
  const server = await startMockServer(makeHandler({ labelsStatus: 500 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Label list failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('auto_fix_pr exits 0 and posts exhausted comment when max attempts reached', async () => {
  const maxLabels = JSON.stringify([
    { name: 'auto-fix-attempt-1' },
    { name: 'auto-fix-attempt-2' },
    { name: 'auto-fix-attempt-3' },
  ]);
  const server = await startMockServer(makeHandler({ labelsBody: maxLabels }));
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const comment = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/comments$/.test(r.url),
    );
    assert.ok(comment, 'expected a POST comment for exhausted state');
    assert.match(JSON.parse(comment.body).body, /Auto-Fix Exhausted/);
    assert.equal(
      server.requests.filter((r) => r.url === '/v1/messages').length,
      0,
      'LLM should not be called when attempts exhausted',
    );
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('auto_fix_pr exits 1 when diff fetch fails', async () => {
  const server = await startMockServer(makeHandler({ diffStatus: 403 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Diff fetch failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('auto_fix_pr exits 1 when LLM returns invalid JSON', async () => {
  const server = await startMockServer(
    makeHandler({ llmResponse: anthropicJson('not json at all') }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /not valid JSON/i);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('auto_fix_pr exits 1 when LLM returns JSON with no changes array', async () => {
  const server = await startMockServer(
    makeHandler({ llmResponse: anthropicJson(JSON.stringify({ summary: 'ok', changes: [] })) }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('auto_fix_pr falls back to automated review comment when review payload has no feedback', async () => {
  const commentsBody = JSON.stringify([
    { body: 'Random note' },
    {
      body: '## 🔍 Automated Code Review\n\nPlease fix the lint error in `src/index.js`.',
    },
  ]);
  const server = await startMockServer(
    makeHandler({
      commentsBody,
      llmResponse: validLLMJson('fixed.txt'),
      inlineCommentsBody: JSON.stringify([]),
    }),
  );
  const eventFile = await writeEventFile();
  const outputFile = path.join(os.tmpdir(), `autofix-output-${Date.now()}.txt`);
  try {
    const rawEvent = JSON.parse(await fs.readFile(eventFile, 'utf8'));
    rawEvent.review.body = '';
    await fs.writeFile(eventFile, JSON.stringify(rawEvent));

    const result = await runAutoFix(server.address().port, eventFile, {
      extraEnv: { GITHUB_OUTPUT: outputFile },
    });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stdout, /feedback fallback/i);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.unlink(outputFile).catch(() => {});
  }
});

test('auto_fix_pr writes generated files and applies attempt-1 label on first run', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-fix-run-'));
  const server = await startMockServer(makeHandler({ llmResponse: validLLMJson('fixed.txt') }));
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile, { cwd: tmpDir });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const written = await fs.readFile(path.join(tmpDir, 'fixed.txt'), 'utf8');
    assert.equal(written, 'fixed content');

    const labelApply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(labelApply, 'expected label apply request');
    assert.ok(JSON.parse(labelApply.body).labels.includes('auto-fix-attempt-1'));
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('auto_fix_pr applies attempt-2 label when attempt-1 already exists', async () => {
  const existingLabels = JSON.stringify([{ name: 'auto-fix-attempt-1' }]);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-fix-run-'));
  const server = await startMockServer(
    makeHandler({ labelsBody: existingLabels, llmResponse: validLLMJson('out.txt') }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile, { cwd: tmpDir });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const labelApply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(labelApply, 'expected label apply request');
    assert.ok(JSON.parse(labelApply.body).labels.includes('auto-fix-attempt-2'));
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('auto_fix_pr includes inline review comments in LLM prompt', async () => {
  const inlineComments = JSON.stringify([
    { path: 'src/foo.js', original_line: 10, body: 'Rename this variable.' },
  ]);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-fix-run-'));
  const server = await startMockServer(
    makeHandler({ inlineCommentsBody: inlineComments, llmResponse: validLLMJson('out.txt') }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile, { cwd: tmpDir });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const llmCall = server.requests.find((r) => r.url === '/v1/messages');
    assert.ok(llmCall, 'expected LLM call');
    const userMsg = JSON.parse(llmCall.body).messages[0].content;
    assert.match(userMsg, /src\/foo\.js/, 'inline comment file path should appear in prompt');
    assert.match(userMsg, /Rename this variable/, 'inline comment body should appear in prompt');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('auto_fix_pr continues when inline comment fetch fails', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-fix-run-'));
  const server = await startMockServer(
    makeHandler({ inlineCommentsStatus: 500, llmResponse: validLLMJson('out.txt') }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile, { cwd: tmpDir });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});

test('auto_fix_pr creates attempt label in repo before applying it', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-fix-run-'));
  const server = await startMockServer(makeHandler({ llmResponse: validLLMJson('out.txt') }));
  const eventFile = await writeEventFile();
  try {
    const result = await runAutoFix(server.address().port, eventFile, { cwd: tmpDir });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const labelCreate = server.requests.find(
      (r) => r.method === 'POST' && /\/repos\/[^/]+\/[^/]+\/labels$/.test(r.url),
    );
    assert.ok(labelCreate, 'expected repo label create request');
    assert.equal(JSON.parse(labelCreate.body).name, 'auto-fix-attempt-1');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.rm(tmpDir, { recursive: true }).catch(() => {});
  }
});
