import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADING = '## 🔍 Automated Code Review';
const PR_NUMBER = 42;
const COMMENT_ID = 999;
const SAMPLE_DIFF = '--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n+added line\n';

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

function anthropicJson(content) {
  return JSON.stringify({ content: [{ type: 'text', text: content }] });
}

function makeHandler({
  diffStatus = 200,
  groqContent = 'Review text here.',
  commentsStatus = 200,
  commentsBody = '[]',
  upsertStatus = 201,
  labelCreateStatus = 201,
  labelUpdateStatus = 200,
  applyLabelStatus = 200,
  removeLabelStatus = 200,
} = {}) {
  return (req, res) => {
    const { method, url } = req;

    if (url === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(anthropicJson(groqContent));
    }

    if (method === 'GET' && /\/pulls\/\d+$/.test(url)) {
      res.writeHead(diffStatus);
      return res.end(diffStatus < 300 ? SAMPLE_DIFF : 'Forbidden');
    }

    if (method === 'GET' && url.includes('/issues/') && url.includes('/comments')) {
      res.writeHead(commentsStatus, { 'Content-Type': 'application/json' });
      return res.end(commentsStatus < 300 ? commentsBody : 'Internal Server Error');
    }

    if ((method === 'POST' || method === 'PATCH') && url.includes('/comments')) {
      res.writeHead(upsertStatus, { 'Content-Type': 'application/json' });
      return res.end(upsertStatus < 300 ? '{"id":1}' : 'Internal Server Error');
    }

    if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/labels$/.test(url)) {
      res.writeHead(labelCreateStatus, { 'Content-Type': 'application/json' });
      return res.end(labelCreateStatus < 300 ? '{"id":1,"name":"label"}' : 'error');
    }

    if (method === 'PATCH' && /\/repos\/[^/]+\/[^/]+\/labels\/[^/]+$/.test(url)) {
      res.writeHead(labelUpdateStatus, { 'Content-Type': 'application/json' });
      return res.end(labelUpdateStatus < 300 ? '{"id":1}' : 'error');
    }

    if (method === 'POST' && /\/issues\/\d+\/labels$/.test(url)) {
      res.writeHead(applyLabelStatus, { 'Content-Type': 'application/json' });
      return res.end(applyLabelStatus < 300 ? '[]' : 'error');
    }

    if (method === 'DELETE' && /\/issues\/\d+\/labels\//.test(url)) {
      res.writeHead(removeLabelStatus, { 'Content-Type': 'application/json' });
      return res.end(removeLabelStatus < 300 ? '[]' : 'error');
    }

    res.writeHead(404);
    res.end('not found');
  };
}

async function runPrReview(port, eventFile, extraEnv = {}) {
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
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, 'pr_review.mjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeEventFile(prNumber = PR_NUMBER) {
  const tmpFile = path.join(os.tmpdir(), `pr-review-biz-${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify({ pull_request: { number: prNumber } }));
  return tmpFile;
}

test('pr_review exits 1 when diff fetch returns non-2xx', async () => {
  const server = await startMockServer(makeHandler({ diffStatus: 403 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Diff fetch failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review exits 1 when comment list fetch returns non-2xx', async () => {
  const server = await startMockServer(makeHandler({ commentsStatus: 500 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Comment list failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review exits 1 when comment upsert returns non-2xx', async () => {
  const server = await startMockServer(makeHandler({ upsertStatus: 500 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Comment upsert failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review POSTs new comment when no existing comment found', async () => {
  const server = await startMockServer(makeHandler({ commentsBody: '[]', upsertStatus: 201 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const upsert = server.requests.find((r) => r.method === 'POST' && r.url.includes('/comments'));
    assert.ok(upsert, 'expected a POST to the comments endpoint');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review PATCHes existing comment when one already contains the heading', async () => {
  const existingComment = [{ id: COMMENT_ID, body: `${HEADING}\n\nprevious review` }];
  const server = await startMockServer(
    makeHandler({ commentsBody: JSON.stringify(existingComment), upsertStatus: 200 }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const patch = server.requests.find((r) => r.method === 'PATCH');
    assert.ok(patch, 'expected a PATCH request');
    assert.ok(
      patch.url.endsWith(`/issues/comments/${COMMENT_ID}`),
      `expected PATCH to /issues/comments/${COMMENT_ID}, got: ${patch.url}`,
    );
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review prepends heading when LLM response does not include it', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'Plain review text.' }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const upsert = server.requests.find((r) => (r.method === 'POST' || r.method === 'PATCH') && r.url.includes('/comments'));
    assert.ok(upsert, 'expected a comment upsert request');
    const { body } = JSON.parse(upsert.body);
    assert.ok(body.startsWith(HEADING), `expected body to start with heading, got: ${body.slice(0, 80)}`);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review does not duplicate heading when LLM response already contains it', async () => {
  const groqContent = `${HEADING}\n\nDetailed review.`;
  const server = await startMockServer(makeHandler({ groqContent }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const upsert = server.requests.find((r) => (r.method === 'POST' || r.method === 'PATCH') && r.url.includes('/comments'));
    assert.ok(upsert, 'expected a comment upsert request');
    const { body } = JSON.parse(upsert.body);
    const occurrences = body.split(HEADING).length - 1;
    assert.equal(occurrences, 1, `heading should appear exactly once, found ${occurrences} times`);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review applies review-approved and removes changes-requested on APPROVED verdict', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'All good.\n\nVerdict: APPROVED' }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const apply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(apply, 'expected POST to issue labels endpoint');
    assert.ok(
      JSON.parse(apply.body).labels.includes('review-approved'),
      'should apply review-approved',
    );

    const remove = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes('/labels/changes-requested'),
    );
    assert.ok(remove, 'expected DELETE for changes-requested');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review applies changes-requested and removes review-approved on REQUEST_CHANGES verdict', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'Found issues.\n\nVerdict: REQUEST_CHANGES' }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const apply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(apply, 'expected POST to issue labels endpoint');
    assert.ok(
      JSON.parse(apply.body).labels.includes('changes-requested'),
      'should apply changes-requested',
    );

    const remove = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes('/labels/review-approved'),
    );
    assert.ok(remove, 'expected DELETE for review-approved');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review defaults to changes-requested when verdict is absent from LLM response', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'No verdict line in this response.' }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const apply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(apply, 'expected POST to issue labels endpoint');
    assert.ok(
      JSON.parse(apply.body).labels.includes('changes-requested'),
      'should default to changes-requested',
    );
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review falls back to PATCH when label POST returns 422', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'Verdict: APPROVED', labelCreateStatus: 422 }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const patches = server.requests.filter(
      (r) => r.method === 'PATCH' && /\/repos\/[^/]+\/[^/]+\/labels\//.test(r.url),
    );
    assert.equal(patches.length, 2, 'expected PATCH for both PR review labels');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review exits 1 when label create returns unexpected error', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'Verdict: APPROVED', labelCreateStatus: 500 }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Label create failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review exits 1 when addLabel fails', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'Verdict: APPROVED', applyLabelStatus: 422 }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Add label.*failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});
