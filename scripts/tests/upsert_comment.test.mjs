import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMENT_MARKER = '<!-- issue-validation-report -->';
const COMMENT_ID = 555;

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

// Routes:
//   GET  /repos/:o/:r/issues/:n/comments?... → list comments
//   POST /repos/:o/:r/issues/:n/comments     → create comment
//   PATCH /repos/:o/:r/issues/comments/:id   → update comment
function makeHandler({ listStatus = 200, listBody = '[]', upsertStatus = 201 } = {}) {
  return (req, res) => {
    const { method, url } = req;

    if (method === 'GET' && url.includes('/comments')) {
      res.writeHead(listStatus, { 'Content-Type': 'application/json' });
      return res.end(listStatus < 300 ? listBody : 'Internal Server Error');
    }

    if ((method === 'POST' || method === 'PATCH') && url.includes('/comments')) {
      res.writeHead(upsertStatus, { 'Content-Type': 'application/json' });
      return res.end(upsertStatus < 300 ? '{"id":1}' : 'Internal Server Error');
    }

    res.writeHead(404);
    res.end('not found');
  };
}

async function runUpsertComment(port, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    ISSUE_NUMBER: '1',
    COMMENT_BODY: 'Validation result here.',
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS_DIR, 'upsert_issue_validation_comment.mjs')],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('upsert_comment POSTs new comment when list returns empty', async () => {
  const server = await startMockServer(makeHandler({ listBody: '[]', upsertStatus: 201 }));
  try {
    const result = await runUpsertComment(server.address().port);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const post = server.requests.find((r) => r.method === 'POST' && r.url.includes('/comments'));
    assert.ok(post, 'expected POST to comments endpoint');
  } finally {
    server.close();
  }
});

test('upsert_comment PATCHes existing comment when one has the marker', async () => {
  const existingComments = JSON.stringify([
    { id: COMMENT_ID, body: `${COMMENT_MARKER}\nPrevious report` },
  ]);
  const server = await startMockServer(makeHandler({ listBody: existingComments, upsertStatus: 200 }));
  try {
    const result = await runUpsertComment(server.address().port);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const patch = server.requests.find((r) => r.method === 'PATCH');
    assert.ok(patch, 'expected PATCH request');
    assert.ok(
      patch.url.endsWith(`/issues/comments/${COMMENT_ID}`),
      `expected PATCH to comment ${COMMENT_ID}, got: ${patch.url}`,
    );
  } finally {
    server.close();
  }
});

test('upsert_comment adds marker when COMMENT_BODY does not contain it', async () => {
  const server = await startMockServer(makeHandler());
  try {
    const result = await runUpsertComment(server.address().port, {
      COMMENT_BODY: 'Plain comment without marker.',
    });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const upsert = server.requests.find((r) => r.method === 'POST' && r.url.includes('/comments'));
    const { body } = JSON.parse(upsert.body);
    assert.ok(body.includes(COMMENT_MARKER), 'expected marker to be present in sent body');
  } finally {
    server.close();
  }
});

test('upsert_comment does not duplicate marker when COMMENT_BODY already contains it', async () => {
  const server = await startMockServer(makeHandler());
  try {
    const result = await runUpsertComment(server.address().port, {
      COMMENT_BODY: `${COMMENT_MARKER}\nAlready marked.`,
    });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const upsert = server.requests.find((r) => r.method === 'POST' && r.url.includes('/comments'));
    const { body } = JSON.parse(upsert.body);
    const count = body.split(COMMENT_MARKER).length - 1;
    assert.equal(count, 1, `marker should appear exactly once, found ${count}`);
  } finally {
    server.close();
  }
});

test('upsert_comment exits 1 when comment list fetch fails', async () => {
  const server = await startMockServer(makeHandler({ listStatus: 500 }));
  try {
    const result = await runUpsertComment(server.address().port);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /500/);
  } finally {
    server.close();
  }
});

test('upsert_comment exits 1 when comment upsert fails', async () => {
  const server = await startMockServer(makeHandler({ upsertStatus: 422 }));
  try {
    const result = await runUpsertComment(server.address().port);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /422/);
  } finally {
    server.close();
  }
});
