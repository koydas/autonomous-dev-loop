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
  prHeadRef = 'feature/test',
  autoFixRunsStatus = 200,
} = {}) {
  return (req, res) => {
    const { method, url } = req;

    if (url === '/v1/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(anthropicJson(groqContent));
      return;
    }

    // Add test for label operation sequence
    if (url.includes('/issues/42/labels/changes-requested')) {
      if (method === 'DELETE') {
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST') {
        res.writeHead(201).end();
        return;
      }
    }

    // Existing handler logic...
  };
}

await test('PR review workflow verifies label operation sequence', async () => {
  const server = await startMockServer(makeHandler({
    removeLabelStatus: 200,
    applyLabelStatus: 201
  }));

  // Execute test scenario
  await spawn('node', [path.join(SCRIPTS_DIR, 'run_pr_review.js')], {
    env: {
      GITHUB_TOKEN: 'test',
      AI_PROVIDER: 'groq',
      GITHUB_SERVER_URL: `http://localhost:${server.address().port}`
    }
  });

  // Verify DELETE precedes POST for label reset
  assert.strictEqual(server.requests[0].method, 'DELETE', 'Label removal must occur first');
  assert.strictEqual(server.requests[1].method, 'POST', 'Label application must follow removal');
  assert.strictEqual(server.requests.length, 2, 'Exactly two label operations required');
});