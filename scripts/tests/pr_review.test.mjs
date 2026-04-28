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
  labelCreateStatus = 201,
  labelUpdateStatus = 200,
  applyLabelStatus = 200,
  removeLabelStatus = 200,
  autoFixRunsInProgress = [],
  autoFixRunsQueued = [],
  prHeadRef = 'feature/test',
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
      return res.end(JSON.stringify({ title: 'Test PR', body: 'Test PR body', head: { ref: prHeadRef } }));
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
      return res.end(reviewStatus < 300 ? '{"id":1}' : 'Internal Server Error');
    }

    if (
      method === 'GET' &&
      /\/actions\/workflows\/auto-fix-pr\.yml\/runs\?/.test(url)
    ) {
      if (autoFixRunsStatus >= 300) {
        res.writeHead(autoFixRunsStatus, { 'Content-Type': 'application/json' });
        return res.end('error');
      }
      const target = url.includes('status=queued') ? autoFixRunsQueued : autoFixRunsInProgress;
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
