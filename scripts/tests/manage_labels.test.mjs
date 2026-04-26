import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
//   POST /repos/:o/:r/labels            → repo label create
//   PATCH /repos/:o/:r/labels/:name     → repo label update
//   POST /repos/:o/:r/issues/:n/labels  → apply label to issue
//   DELETE /repos/:o/:r/issues/:n/labels/:name → remove label from issue
function makeHandler({
  labelCreateStatus = 201,
  labelUpdateStatus = 200,
  applyStatus = 200,
  removeStatus = 200,
} = {}) {
  return (req, res) => {
    const { method, url } = req;

    if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/labels$/.test(url)) {
      res.writeHead(labelCreateStatus, { 'Content-Type': 'application/json' });
      return res.end(labelCreateStatus < 300 ? '{"id":1,"name":"label"}' : 'error');
    }

    if (method === 'PATCH' && /\/repos\/[^/]+\/[^/]+\/labels\/[^/]+$/.test(url)) {
      res.writeHead(labelUpdateStatus, { 'Content-Type': 'application/json' });
      return res.end(labelUpdateStatus < 300 ? '{"id":1}' : 'error');
    }

    if (method === 'POST' && /\/issues\/\d+\/labels$/.test(url)) {
      res.writeHead(applyStatus, { 'Content-Type': 'application/json' });
      return res.end(applyStatus < 300 ? '[]' : 'error');
    }

    if (method === 'DELETE' && /\/issues\/\d+\/labels\//.test(url)) {
      res.writeHead(removeStatus, { 'Content-Type': 'application/json' });
      return res.end(removeStatus === 404 ? '{"message":"not found"}' : (removeStatus < 300 ? '[]' : 'error'));
    }

    res.writeHead(404);
    res.end('not found');
  };
}

async function runManageLabels(port, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'owner/repo',
    ISSUE_NUMBER: '1',
    IS_VALID: 'true',
    GITHUB_API_URL: `http://127.0.0.1:${port}`,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, 'manage_labels.mjs')], {
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

test('manage_labels IS_VALID=true applies ready-for-dev and removes needs-refinement', async () => {
  const server = await startMockServer(makeHandler());
  try {
    const result = await runManageLabels(server.address().port, { IS_VALID: 'true' });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const apply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(apply, 'expected POST to issue labels endpoint');
    assert.ok(JSON.parse(apply.body).labels.includes('ready-for-dev'), 'should apply ready-for-dev');

    const remove = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes('/labels/needs-refinement'),
    );
    assert.ok(remove, 'expected DELETE for needs-refinement');
  } finally {
    server.close();
  }
});

test('manage_labels IS_VALID=false applies needs-refinement and removes ready-for-dev', async () => {
  const server = await startMockServer(makeHandler());
  try {
    const result = await runManageLabels(server.address().port, { IS_VALID: 'false' });
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const apply = server.requests.find(
      (r) => r.method === 'POST' && /\/issues\/\d+\/labels$/.test(r.url),
    );
    assert.ok(JSON.parse(apply.body).labels.includes('needs-refinement'), 'should apply needs-refinement');

    const remove = server.requests.find(
      (r) => r.method === 'DELETE' && r.url.includes('/labels/ready-for-dev'),
    );
    assert.ok(remove, 'expected DELETE for ready-for-dev');
  } finally {
    server.close();
  }
});

test('manage_labels falls back to PATCH when label POST returns 422', async () => {
  const server = await startMockServer(makeHandler({ labelCreateStatus: 422 }));
  try {
    const result = await runManageLabels(server.address().port);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);

    const patches = server.requests.filter(
      (r) => r.method === 'PATCH' && /\/repos\/[^/]+\/[^/]+\/labels\//.test(r.url),
    );
    assert.equal(patches.length, 2, 'expected PATCH for both labels');
  } finally {
    server.close();
  }
});

test('manage_labels exits 1 when label create returns unexpected error', async () => {
  const server = await startMockServer(makeHandler({ labelCreateStatus: 500 }));
  try {
    const result = await runManageLabels(server.address().port);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Label create failed/);
  } finally {
    server.close();
  }
});

test('manage_labels exits 1 when label PATCH update fails', async () => {
  const server = await startMockServer(makeHandler({ labelCreateStatus: 422, labelUpdateStatus: 500 }));
  try {
    const result = await runManageLabels(server.address().port);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Label update failed/);
  } finally {
    server.close();
  }
});

test('manage_labels exits 1 when addLabel fails', async () => {
  const server = await startMockServer(makeHandler({ applyStatus: 422 }));
  try {
    const result = await runManageLabels(server.address().port);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Add label.*failed/);
  } finally {
    server.close();
  }
});

test('manage_labels exits 1 when removeLabel returns non-404 error', async () => {
  const server = await startMockServer(makeHandler({ removeStatus: 500 }));
  try {
    const result = await runManageLabels(server.address().port);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /Remove label.*failed/);
  } finally {
    server.close();
  }
});

test('manage_labels succeeds when removeLabel returns 404 (label already absent)', async () => {
  const server = await startMockServer(makeHandler({ removeStatus: 404 }));
  try {
    const result = await runManageLabels(server.address().port);
    assert.equal(result.code, 0, `expected exit 0, stderr: ${result.stderr}`);
  } finally {
    server.close();
  }
});
