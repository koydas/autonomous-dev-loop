import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { parseNestedYaml } from '../lib/yaml.mjs';
import { buildAutomationGateContext } from '../lib/coverage_checker.mjs';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = path.join(SCRIPTS_DIR, '..');
const LABELS = parseNestedYaml(readFileSync(path.join(ROOT_DIR, 'config/labels.yaml'), 'utf8'));
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
  reviewStatus = 201,
  reviewBody = null,
  labelCreateStatus = 201,
  labelUpdateStatus = 200,
  applyLabelStatus = 200,
  removeLabelStatus = 200,
  autoFixRunsInProgress = [],
  autoFixRunsQueued = [],
  autoFixRunsPending = [],
  prHeadRef = 'feature/test',
  prHeadSha = 'a'.repeat(40),
  autoFixRunsStatus = 200,
} = {}) {
  return (req, res) => {
    const { method, url } = req;

    if (url === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(anthropicJson(groqContent));
    }

    if (method === 'GET' && /\/pulls\/\d+$/.test(url)) {
      if (req.headers['accept']?.includes('vnd.github.v3.diff')) {
        res.writeHead(diffStatus);
        return res.end(diffStatus < 300 ? SAMPLE_DIFF : 'Forbidden');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ title: 'Test PR', body: 'Test PR body', head: { ref: prHeadRef, sha: prHeadSha } }));
    }

    if (method === 'GET' && url.includes('/issues/') && url.includes('/comments')) {
      res.writeHead(commentsStatus, { 'Content-Type': 'application/json' });
      return res.end(commentsStatus < 300 ? commentsBody : 'Internal Server Error');
    }

    if ((method === 'POST' || method === 'PATCH') && url.includes('/comments')) {
      res.writeHead(upsertStatus, { 'Content-Type': 'application/json' });
      return res.end(upsertStatus < 300 ? '{"id":1}' : 'Internal Server Error');
    }

    if (method === 'POST' && /\/pulls\/\d+\/reviews$/.test(url)) {
      res.writeHead(reviewStatus, { 'Content-Type': 'application/json' });
      return res.end(reviewStatus < 300 ? '{"id":1}' : (reviewBody ?? 'Internal Server Error'));
    }

    if (
      method === 'GET' &&
      /\/actions\/workflows\/auto-fix-pr\.yml\/runs\?/.test(url)
    ) {
      if (autoFixRunsStatus >= 300) {
        res.writeHead(autoFixRunsStatus, { 'Content-Type': 'application/json' });
        return res.end('error');
      }
      const target = url.includes('status=queued') ? autoFixRunsQueued
        : url.includes('status=pending') ? autoFixRunsPending
        : autoFixRunsInProgress;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ total_count: target.length, workflow_runs: target }));
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

// Default to passing evidence for the mocked PR head (prHeadSha): with no evidence at all, every
// APPROVED review would be WITHHELD (ADR-0026). Tests about missing evidence pass their own path.
const DEFAULT_EVIDENCE_PATH = path.join(os.tmpdir(), `pr-review-default-evidence-${process.pid}.json`);
await fs.writeFile(DEFAULT_EVIDENCE_PATH, JSON.stringify({
  version: 1,
  head_sha: 'a'.repeat(40),
  generated_at: 't',
  checks: [{ name: 'tests', command: 'npm test', status: 'pass', exit_code: 0, duration_ms: 1, output_tail: 'ok' }],
}));
const NO_EVIDENCE_PATH = path.join(os.tmpdir(), 'pr-review-no-evidence.json');

async function runPrReview(port, eventFile, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    GITHUB_TOKEN: 'test-token',
    ANTHROPIC_API_KEY: 'test-key',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_URL: `http://127.0.0.1:${port}/v1/messages`,
    METRICS_FILE: '/dev/null',
    // Isolate from any evidence/ directory left in the repo by a local run.
    REVIEW_EVIDENCE_PATH: DEFAULT_EVIDENCE_PATH,
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
    const post = server.requests.find((r) => r.method === 'POST' && r.url.includes('/comments'));
    assert.ok(post, 'expected a POST to the comments endpoint');
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
    const patch = server.requests.find(
      (r) => r.method === 'PATCH' && r.url.endsWith(`/issues/comments/${COMMENT_ID}`),
    );
    assert.ok(patch, `expected PATCH to /issues/comments/${COMMENT_ID}`);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review exits 1 when review submit returns non-2xx (not permission-related)', async () => {
  const server = await startMockServer(makeHandler({ reviewStatus: 500 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Review submit failed/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review exits 1 when review submit returns 422 (permissions)', async () => {
  const server = await startMockServer(makeHandler({ reviewStatus: 422 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0, `expected non-zero exit, stderr: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, /permission\/configuration issue/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review exits 1 when review submit returns 403 (insufficient scope)', async () => {
  const server = await startMockServer(makeHandler({ reviewStatus: 403 }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0, `expected non-zero exit, stderr: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, /permission\/configuration issue/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review continues when GitHub rejects APPROVE on own pull request', async () => {
  const ownPrError = JSON.stringify({
    message: 'Unprocessable Entity',
    errors: ['Review Can not approve your own pull request'],
  });
  const server = await startMockServer(
    makeHandler({
      groqContent: 'Looks good.\n\nVerdict: APPROVED',
      reviewStatus: 422,
      reviewBody: ownPrError,
    }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, /rejected the review because the actor opened the pull request/i);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review continues when GitHub rejects REQUEST_CHANGES on own pull request', async () => {
  const ownPrError = JSON.stringify({
    message: 'Unprocessable Entity',
    errors: ['Review Can not request changes on your own pull request'],
  });
  const server = await startMockServer(
    makeHandler({
      groqContent: 'Issues found.\n\nVerdict: REQUEST_CHANGES',
      reviewStatus: 422,
      reviewBody: ownPrError,
    }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, /rejected the review because the actor opened the pull request/i);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review submits review to pulls reviews endpoint', async () => {
  const server = await startMockServer(makeHandler());
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected a POST to /pulls/{n}/reviews');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review submits APPROVE event when verdict is APPROVED', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'All good.\n\nVerdict: APPROVED' }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'APPROVE');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review submits REQUEST_CHANGES event when verdict is REQUEST_CHANGES', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'Found issues.\n\nVerdict: REQUEST_CHANGES' }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'REQUEST_CHANGES');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review defaults to REQUEST_CHANGES when verdict is absent from LLM response', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'No verdict line in this response.' }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'REQUEST_CHANGES');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review detects APPROVE when verdict is a markdown heading with value on next line', async () => {
  const groqContent = '### ✅ Summary\nLooks good.\n\n### 🚀 Verdict\nAPPROVED';
  const server = await startMockServer(makeHandler({ groqContent }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'APPROVE');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review detects APPROVE when verdict is bold markdown (**APPROVED**)', async () => {
  const groqContent = '### 🚀 Verdict\n**APPROVED**';
  const server = await startMockServer(makeHandler({ groqContent }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'APPROVE');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review detects REQUEST_CHANGES when verdict is bold markdown (**REQUEST_CHANGES**)', async () => {
  const groqContent = '### 🚀 Verdict\n**REQUEST_CHANGES**';
  const server = await startMockServer(makeHandler({ groqContent }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'REQUEST_CHANGES');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review detects APPROVE when verdict uses single asterisk (*APPROVED*)', async () => {
  const groqContent = 'Summary: looks fine.\n\nVerdict: *APPROVED*';
  const server = await startMockServer(makeHandler({ groqContent }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'APPROVE');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review defaults to REQUEST_CHANGES when verdict line echoes template placeholder', async () => {
  const groqContent = '### 🚀 Verdict\n(APPROVED | REQUEST_CHANGES)';
  const server = await startMockServer(makeHandler({ groqContent }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.equal(JSON.parse(review.body).event, 'REQUEST_CHANGES');
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
    const comment = server.requests.find(
      (r) => (r.method === 'POST' || r.method === 'PATCH') && r.url.includes('/comments'),
    );
    assert.ok(comment, 'expected a comment upsert request');
    const { body } = JSON.parse(comment.body);
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
    const comment = server.requests.find(
      (r) => (r.method === 'POST' || r.method === 'PATCH') && r.url.includes('/comments'),
    );
    assert.ok(comment, 'expected a comment upsert request');
    const { body } = JSON.parse(comment.body);
    const occurrences = body.split(HEADING).length - 1;
    assert.equal(occurrences, 1, `heading should appear exactly once, found ${occurrences} times`);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review applies review-approved label on APPROVED verdict', async () => {
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
    assert.ok(JSON.parse(apply.body).labels.includes(LABELS.review.approved.name), `should apply ${LABELS.review.approved.name}`);
    const remove = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes(`/labels/${LABELS.review.changes.name}`),
    );
    assert.ok(remove, `expected DELETE for ${LABELS.review.changes.name}`);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review applies changes-requested label on REQUEST_CHANGES verdict', async () => {
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
    assert.ok(JSON.parse(apply.body).labels.includes(LABELS.review.changes.name), `should apply ${LABELS.review.changes.name}`);
    const removeApplied = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes(`/labels/${LABELS.review.changes.name}`),
    );
    assert.ok(removeApplied, `expected DELETE for ${LABELS.review.changes.name} to re-trigger label event`);
    const removeOpposite = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes(`/labels/${LABELS.review.approved.name}`),
    );
    assert.ok(removeOpposite, `expected DELETE for ${LABELS.review.approved.name}`);
    assert.ok(
      server.requests.indexOf(removeApplied) < server.requests.indexOf(apply),
      'expected changes-requested label removal before re-apply',
    );
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review does not re-pulse changes-requested when auto-fix run is already active', async () => {
  const server = await startMockServer(
    makeHandler({
      groqContent: 'Found issues.\n\nVerdict: REQUEST_CHANGES',
      autoFixRunsInProgress: [{ id: 1, head_branch: 'feature/test' }],
    }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stdout, /Skipping changes-requested re-pulse/);
    const removeApplied = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes(`/labels/${LABELS.review.changes.name}`),
    );
    assert.equal(removeApplied, undefined, 'should not remove changes-requested while auto-fix is active');
    const apply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(apply, 'expected POST to issue labels endpoint');
    assert.ok(JSON.parse(apply.body).labels.includes(LABELS.review.changes.name), `should apply ${LABELS.review.changes.name}`);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review does not re-pulse changes-requested when auto-fix status check is forbidden', async () => {
  const server = await startMockServer(
    makeHandler({
      groqContent: 'Found issues.\n\nVerdict: REQUEST_CHANGES',
      autoFixRunsStatus: 403,
    }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, /defaulting to skip re-pulse/i);
    const removeApplied = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes(`/labels/${LABELS.review.changes.name}`),
    );
    assert.equal(removeApplied, undefined, 'should not remove changes-requested when run status is unknown');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review sends short body to review endpoint, not the full comment body', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'Detailed review.\n\nVerdict: APPROVED' }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find(
      (r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url),
    );
    const comment = server.requests.find(
      (r) => (r.method === 'POST' || r.method === 'PATCH') && r.url.includes('/comments'),
    );
    assert.ok(review, 'expected POST to reviews endpoint');
    assert.ok(comment, 'expected a comment upsert');
    const reviewBody = JSON.parse(review.body).body;
    const commentBody = JSON.parse(comment.body).body;
    assert.notEqual(reviewBody, commentBody, 'review body should differ from comment body');
    assert.ok(!reviewBody.includes(HEADING), 'review body should not contain the full heading');
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
    assert.equal(patches.length, Object.keys(LABELS.review).length, 'expected PATCH for every PR review label');
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

test('buildAutomationGateContext returns empty string for non-automation diffs', () => {
  const diff = '--- a/src/app.mjs\n+++ b/src/app.mjs\n@@ -1 +1 @@\n+change\n';
  assert.equal(buildAutomationGateContext(diff), '');
});

test('buildAutomationGateContext includes automation gate booleans for automation-scope diffs', () => {
  const diff = [
    'diff --git a/.github/workflows/test.yml b/.github/workflows/test.yml',
    '+++ b/.github/workflows/test.yml',
    '@@ -0,0 +1 @@',
    '+new workflow config',
  ].join('\n');
  const ctx = buildAutomationGateContext(diff);
  assert.match(ctx, /automation_scope: true/);
  assert.match(ctx, /unit_test_updates_present: false/);
  assert.match(ctx, /docs_updates_present: false/);
  assert.match(ctx, /coverage_signal_present: false/);
});

test('pr_review re-pulses changes-requested label to reset auto-fix workflow cycle', async () => {
  const server = await startMockServer(
    makeHandler({ groqContent: 'Needs fixes.\n\nVerdict: REQUEST_CHANGES' }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const removeChangesRequested = server.requests.filter(
      (r) => r.method === 'DELETE' && r.url.includes(`/labels/${LABELS.review.changes.name}`),
    );
    assert.equal(removeChangesRequested.length, 1, 'expected a single DELETE for changes-requested label');

    const applyChangesRequested = server.requests.filter(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url) && JSON.parse(r.body).labels.includes(LABELS.review.changes.name),
    );
    assert.equal(applyChangesRequested.length, 1, 'expected a single POST re-applying changes-requested label');

    assert.ok(
      server.requests.indexOf(removeChangesRequested[0]) < server.requests.indexOf(applyChangesRequested[0]),
      'expected changes-requested label to be removed before being re-applied',
    );
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

function failOnce(handler, match, status, headers = {}) {
  let failed = false;
  return (req, res) => {
    if (!failed && match(req)) {
      failed = true;
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      return res.end('{"message":"transient"}');
    }
    return handler(req, res);
  };
}

test('pr_review ghFetch retries GitHub 429 honoring Retry-After', async () => {
  const server = await startMockServer(failOnce(
    makeHandler(),
    (req) => req.method === 'GET' && req.url.includes('/issues/') && req.url.includes('/comments'),
    429,
    { 'Retry-After': '0' },
  ));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0 after retry, stderr: ${result.stderr}`);
    const retryLine = result.stdout.split('\n').find((l) => l.includes('"msg":"retry"'));
    assert.ok(retryLine, 'expected a retry log line');
    assert.equal(JSON.parse(retryLine).waitMs, 0, 'expected Retry-After (0s) to be honored');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review ghFetch retries GitHub 500 responses', async () => {
  const server = await startMockServer(failOnce(
    makeHandler(),
    (req) => req.method === 'GET' && req.url.includes('/issues/') && req.url.includes('/comments'),
    500,
  ));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0 after retry, stderr: ${result.stderr}`);
    const lists = server.requests.filter((r) => r.method === 'GET' && r.url.includes('/issues/') && r.url.includes('/comments'));
    assert.equal(lists.length, 2);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review ghFetch does not retry a 5xx review submission (non-idempotent POST)', async () => {
  const server = await startMockServer(failOnce(
    makeHandler(),
    (req) => req.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(req.url),
    502,
  ));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Review submit failed: 502/);
    const submits = server.requests.filter((r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url));
    assert.equal(submits.length, 1, 'a retried review POST could post a duplicate review');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review does not re-pulse changes-requested while an auto-fix run is pending on its concurrency group', async () => {
  // ADR-0020: a run waiting on the per-PR concurrency group has status "pending", not "queued".
  const server = await startMockServer(
    makeHandler({
      groqContent: 'Found issues.\n\nVerdict: REQUEST_CHANGES',
      autoFixRunsPending: [{ id: 2, head_branch: 'feature/test' }],
    }),
  );
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    assert.match(result.stdout, /Skipping changes-requested re-pulse/);
    assert.ok(server.requests.some((r) => r.url.includes('status=pending')), 'expected a status=pending lookup');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review sends the configured reasoning_effort to Groq', async () => {
  const handler = makeHandler();
  const server = await startMockServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'Looks good.\n\nVerdict: APPROVED' } }] }));
    }
    return handler(req, res);
  });
  const eventFile = await writeEventFile();
  try {
    const port = server.address().port;
    const result = await runPrReview(port, eventFile, {
      ANTHROPIC_API_KEY: '',
      GROQ_API_KEY: 'groq-test',
      GROQ_API_URL: `http://127.0.0.1:${port}/v1/chat/completions`,
    });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const call = server.requests.find((r) => r.url === '/v1/chat/completions');
    assert.ok(call, 'expected a Groq call');
    const body = JSON.parse(call.body);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.reasoning_effort, 'low');
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

// --- Tool evidence (ADR-0024) ---

async function writeEvidenceFile(checks, headSha = 'a'.repeat(40)) {
  const file = path.join(os.tmpdir(), `pr-review-evidence-${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(file, JSON.stringify({ version: 1, head_sha: headSha, generated_at: 't', checks }));
  return file;
}

const EVIDENCE_PASS = { name: 'tests', command: 'npm test', status: 'pass', exit_code: 0, duration_ms: 1, output_tail: 'ok' };
const EVIDENCE_FAIL = { name: 'tests', command: 'npm test', status: 'fail', exit_code: 1, duration_ms: 1, output_tail: 'AssertionError: expected 2' };

async function runWithEvidence({ groqContent, checks, evidenceSha }) {
  const server = await startMockServer(makeHandler({ groqContent }));
  const eventFile = await writeEventFile();
  const evidenceFile = await writeEvidenceFile(checks, evidenceSha);
  try {
    const result = await runPrReview(server.address().port, eventFile, { REVIEW_EVIDENCE_PATH: evidenceFile });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find((r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url));
    const comment = server.requests.find(
      (r) => (r.method === 'POST' || r.method === 'PATCH') && /\/issues\/(\d+\/)?comments/.test(r.url),
    );
    return { result, event: JSON.parse(review.body).event, body: JSON.parse(comment.body).body };
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.unlink(evidenceFile).catch(() => {});
  }
}

test('pr_review overrides APPROVED to REQUEST_CHANGES when a check failed', async () => {
  const { event, body, result } = await runWithEvidence({
    groqContent: 'Looks fine.\n\nVerdict: APPROVED',
    checks: [EVIDENCE_FAIL],
  });
  assert.equal(event, 'REQUEST_CHANGES');
  assert.match(body, /Verdict overridden to REQUEST_CHANGES\*\* — failing checks: tests/);
  assert.match(body, /AssertionError: expected 2/);
  assert.match(result.stderr, /"evidence_override":true/);
});

test('pr_review keeps APPROVE and renders the evidence table when all checks pass', async () => {
  const { event, body } = await runWithEvidence({
    groqContent: 'Looks fine.\n\nVerdict: APPROVED',
    checks: [EVIDENCE_PASS],
  });
  assert.equal(event, 'APPROVE');
  assert.match(body, /### 🧪 Tool Evidence/);
  assert.match(body, /\| tests \| `npm test` \| PASS \(exit 0\) \|/);
  assert.doesNotMatch(body, /Verdict overridden/);
});

test('pr_review withholds approval without requesting changes when evidence is stale (head SHA mismatch)', async () => {
  const { event, body } = await runWithEvidence({
    groqContent: 'Looks fine.\n\nVerdict: APPROVED',
    checks: [EVIDENCE_FAIL],
    evidenceSha: 'b'.repeat(40),
  });
  // ADR-0026: stale evidence can neither confirm the approval nor prove a failure.
  assert.equal(event, 'COMMENT');
  assert.match(body, /No usable tool evidence — stale/);
  assert.match(body, /Approval withheld\*\* — evidence stale/);
  assert.doesNotMatch(body, /Verdict overridden/);
});

test('pr_review renders a missing-evidence notice when no evidence file exists', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'Fine.\n\nVerdict: APPROVED' }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile, { REVIEW_EVIDENCE_PATH: NO_EVIDENCE_PATH });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const comment = server.requests.find(
      (r) => (r.method === 'POST' || r.method === 'PATCH') && /\/issues\/(\d+\/)?comments/.test(r.url),
    );
    assert.match(JSON.parse(comment.body).body, /No usable tool evidence — missing: no evidence file at/);
    assert.match(result.stderr, /"evidence_state":"missing"/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review sends the tool evidence block to the LLM', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'Verdict: REQUEST_CHANGES' }));
  const eventFile = await writeEventFile();
  const evidenceFile = await writeEvidenceFile([EVIDENCE_FAIL]);
  try {
    const result = await runPrReview(server.address().port, eventFile, { REVIEW_EVIDENCE_PATH: evidenceFile });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const llmCall = server.requests.find((r) => r.url === '/v1/messages');
    const prompt = JSON.stringify(JSON.parse(llmCall.body).messages);
    assert.match(prompt, /## Tool evidence/);
    assert.match(prompt, /tests \(`npm test`\): FAIL \(exit 1\)/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.unlink(evidenceFile).catch(() => {});
  }
});

test('pr_review puts the evidence section before the LLM review when a check failed', async () => {
  const { body } = await runWithEvidence({
    groqContent: `${HEADING}\n\nLLM findings here.\n\nVerdict: REQUEST_CHANGES`,
    checks: [EVIDENCE_FAIL],
  });
  assert.ok(body.startsWith(HEADING), 'heading stays first');
  assert.equal(body.split(HEADING).length - 1, 1, 'heading appears once');
  assert.ok(body.indexOf('### 🧪 Tool Evidence') < body.indexOf('LLM findings here.'), 'evidence must precede the LLM text');
});

test('pr_review keeps the evidence section after the LLM review when nothing failed', async () => {
  const { body } = await runWithEvidence({
    groqContent: 'LLM findings here.\n\nVerdict: APPROVED',
    checks: [EVIDENCE_PASS],
  });
  assert.ok(body.indexOf('LLM findings here.') < body.indexOf('### 🧪 Tool Evidence'));
});

// --- Withheld approval (ADR-0026) ---

const reviewLabelCalls = (server) => ({
  added: server.requests.filter((r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url)).map((r) => JSON.parse(r.body).labels).flat(),
  removed: server.requests.filter((r) => r.method === 'DELETE' && /\/issues\/\d+\/labels\//.test(r.url)).map((r) => decodeURIComponent(r.url.split('/labels/')[1])),
});

test('pr_review withholds approval when a check timed out, and applies neither review label', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'Looks fine.\n\nVerdict: APPROVED' }));
  const eventFile = await writeEventFile();
  const evidenceFile = await writeEvidenceFile([{ ...EVIDENCE_PASS, status: 'timeout', exit_code: null }]);
  try {
    const result = await runPrReview(server.address().port, eventFile, { REVIEW_EVIDENCE_PATH: evidenceFile });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find((r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url));
    assert.equal(JSON.parse(review.body).event, 'COMMENT');
    assert.match(JSON.parse(review.body).body, /Approval withheld/);
    const comment = server.requests.find(
      (r) => (r.method === 'POST' || r.method === 'PATCH') && /\/issues\/(\d+\/)?comments/.test(r.url),
    );
    assert.match(JSON.parse(comment.body).body, /Approval withheld\*\* — unverified checks \(timeout or error\): tests/);
    const labels = reviewLabelCalls(server);
    assert.deepEqual(labels.added, ['review-withheld']);
    assert.deepEqual(labels.removed.sort(), ['changes-requested', 'review-approved']);
    assert.match(result.stderr, /"verdict":"WITHHELD"/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
    await fs.unlink(evidenceFile).catch(() => {});
  }
});

test('pr_review withholds approval when no evidence file exists', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'Fine.\n\nVerdict: APPROVED' }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile, { REVIEW_EVIDENCE_PATH: NO_EVIDENCE_PATH });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find((r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url));
    assert.equal(JSON.parse(review.body).event, 'COMMENT');
    assert.deepEqual(reviewLabelCalls(server).added, ['review-withheld']);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review keeps REQUEST_CHANGES and the changes-requested label when the model rejects with no evidence', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'Broken.\n\nVerdict: REQUEST_CHANGES' }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile, { REVIEW_EVIDENCE_PATH: NO_EVIDENCE_PATH });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find((r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url));
    assert.equal(JSON.parse(review.body).event, 'REQUEST_CHANGES');
    assert.deepEqual(reviewLabelCalls(server).added, ['changes-requested']);
    const comment = server.requests.find(
      (r) => (r.method === 'POST' || r.method === 'PATCH') && /\/issues\/(\d+\/)?comments/.test(r.url),
    );
    assert.doesNotMatch(JSON.parse(comment.body).body, /Approval withheld/);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review keeps APPROVE with missing evidence when the repo has no evidence config', async () => {
  const server = await startMockServer(makeHandler({ groqContent: 'Fine.\n\nVerdict: APPROVED' }));
  const eventFile = await writeEventFile();
  try {
    const result = await runPrReview(server.address().port, eventFile, {
      REVIEW_EVIDENCE_PATH: NO_EVIDENCE_PATH,
      REVIEW_EVIDENCE_CONFIG: path.join(os.tmpdir(), 'pr-review-no-evidence-config.yaml'),
    });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
    const review = server.requests.find((r) => r.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(r.url));
    assert.equal(JSON.parse(review.body).event, 'APPROVE');
    assert.deepEqual(reviewLabelCalls(server).added, ['review-approved']);
  } finally {
    server.close();
    await fs.unlink(eventFile).catch(() => {});
  }
});

test('pr_review clears review-withheld when a later review approves or requests changes', async () => {
  for (const [groqContent, applied] of [['Fine.\n\nVerdict: APPROVED', 'review-approved'], ['Broken.\n\nVerdict: REQUEST_CHANGES', 'changes-requested']]) {
    const server = await startMockServer(makeHandler({ groqContent }));
    const eventFile = await writeEventFile();
    try {
      const result = await runPrReview(server.address().port, eventFile);
      assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
      const labels = reviewLabelCalls(server);
      assert.ok(labels.added.includes(applied), `expected ${applied} to be applied`);
      assert.ok(labels.removed.includes('review-withheld'), 'expected review-withheld to be removed');
      assert.ok(!labels.added.includes('review-withheld'));
    } finally {
      server.close();
      await fs.unlink(eventFile).catch(() => {});
    }
  }
});
