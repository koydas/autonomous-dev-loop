// ADR-0039: scripts/commit_run_record.mjs — the "Commit metrics" step: runs.jsonl lines and the
// redacted run record in one commit on the metrics branch, workflow-level effects journaled first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commit_run_record.mjs');
const PLANTED = 'planted-secret-value-for-commit-test';

// Minimal Git Data API: one branch, files materialized on ref update.
function startGitHub({ branchStatus = 200, files = {} } = {}) {
  const state = { head: 'c0', files: { ...files }, commits: [], trees: {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const send = (status, payload, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
      const url = decodeURIComponent(req.url);
      if (req.method === 'GET' && url.endsWith('/git/ref/heads/metrics')) return branchStatus === 200 ? send(200, { object: { sha: state.head } }) : send(branchStatus, {});
      if (req.method === 'GET' && url.includes('/git/commits/')) return send(200, { tree: { sha: 'tree0' } });
      if (req.method === 'GET' && url.includes('/contents/')) {
        const file = url.split('/contents/')[1].split('?')[0];
        if (!(file in state.files)) return send(404, {});
        return req.headers.accept.includes('raw') ? send(200, state.files[file], 'text/plain') : send(200, { path: file });
      }
      if (req.method === 'POST' && url.endsWith('/git/trees')) { const sha = `tree${Object.keys(state.trees).length + 1}`; state.trees[sha] = body; return send(201, { sha }); }
      if (req.method === 'POST' && url.endsWith('/git/commits')) { state.commits.push(body); return send(201, { sha: `c${state.commits.length}` }); }
      if (req.method === 'PATCH' && url.endsWith('/git/refs/heads/metrics')) {
        const commit = state.commits[Number(body.sha.slice(1)) - 1];
        for (const entry of state.trees[commit.tree].tree) state.files[entry.path] = entry.content;
        state.head = body.sha;
        return send(200, {});
      }
      return send(500, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

async function run({ port, cwd, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd,
      env: {
        PATH: process.env.PATH,
        GH_TOKEN: 'tok',
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '555',
        GITHUB_RUN_ATTEMPT: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function scratch({ trace, metrics } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-record-'));
  const traceDir = path.join(cwd, 'observability', 'traces');
  await fs.mkdir(traceDir, { recursive: true });
  if (trace) await fs.writeFile(path.join(traceDir, '555.json'), JSON.stringify(trace));
  const metricsFile = path.join(cwd, '..', `${path.basename(cwd)}-metrics.jsonl`);
  if (metrics) await fs.writeFile(metricsFile, metrics);
  return { cwd, traceDir, metricsFile, cleanup: async () => { await fs.rm(cwd, { recursive: true, force: true }); await fs.rm(metricsFile, { force: true }); } };
}

const TRACE = {
  schema_version: 1,
  run_id: '555',
  started_at: '2026-10-15T09:00:00.000Z',
  completed_at: '2026-10-15T09:01:00.000Z',
  outcome: 'success',
  envelope: { workflow: 'Code Generation', run_id: '555', run_attempt: 1, repository: 'owner/repo', issue_number: 7, actor: 'github-actions[bot]', actor_type: 'bot', links: [], llm_calls: [] },
  spans: [{ stage: 'code_gen', meta: { issueNumber: 7, issueTitle: 'private title' } }],
  events: [{ ts: '2026-10-15T09:00:01.000Z', stage: 'code_gen', event: 'code_gen.error', level: 'error', meta: { error: `boom ${PLANTED}`, prompt: 'SYSTEM PROMPT' } }],
};

test('one commit carries the runs.jsonl lines and the redacted record, with the PR the workflow opened', async () => {
  const { server, state } = await startGitHub({ files: { 'metrics/runs.jsonl': '{"run_id":"1-1"}\n' } });
  const s = await scratch({ trace: TRACE, metrics: '{"run_id":"555-1"}\n' });
  try {
    const result = await run({ port: server.address().port, cwd: s.cwd, env: {
      METRICS_FILE: s.metricsFile, RUN_RECORD_MESSAGE: 'metrics: issue 7 code-generation [skip ci]', MY_TOKEN: PLANTED,
      RUN_RECORD_PR_OPERATION: 'created', RUN_RECORD_PR_URL: 'https://github.com/owner/repo/pull/8', RUN_RECORD_PR_NUMBER: '8',
    } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Committed c1 \(metrics\/runs\/2026-10\/555-1\.json\)/);
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0].message, 'metrics: issue 7 code-generation [skip ci]');
    assert.equal(state.files['metrics/runs.jsonl'], '{"run_id":"1-1"}\n{"run_id":"555-1"}\n');
    const record = JSON.parse(state.files['metrics/runs/2026-10/555-1.json']);
    assert.equal(record.run_id, '555-1');
    const json = JSON.stringify(record);
    assert.ok(!json.includes(PLANTED) && !json.includes('SYSTEM PROMPT') && !json.includes('private title'));
    const op = record.events.find((e) => e.event === 'workflow.pr_operation');
    assert.deepEqual(op.meta, { prNumber: 8, operation: 'created', url: 'https://github.com/owner/repo/pull/8' });
    assert.ok(record.envelope.links.some((l) => l.url === 'https://github.com/owner/repo/pull/8'));
  } finally {
    server.close();
    await s.cleanup();
  }
});

test('a run without a trace commits its metrics lines only and journals nothing', async () => {
  const { server, state } = await startGitHub();
  const s = await scratch({ metrics: '{"run_id":"555-1"}' });
  try {
    const result = await run({ port: server.address().port, cwd: s.cwd, env: { METRICS_FILE: s.metricsFile, RUN_RECORD_PUSH_OUTCOME: 'success' } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(Object.keys(state.files), ['metrics/runs.jsonl']);
    assert.equal(state.commits[0].message, 'metrics: run 555 [skip ci]');
    await assert.rejects(fs.access(path.join(s.traceDir, '555.json')), 'no trace is created');
  } finally {
    server.close();
    await s.cleanup();
  }
});

test('the push outcome of auto-fix is journaled; a symlinked trace is never followed', async () => {
  const { server, state } = await startGitHub();
  const s = await scratch({ trace: TRACE });
  const outside = path.join(os.tmpdir(), `outside-${process.pid}.json`);
  await fs.writeFile(outside, JSON.stringify({ ...TRACE, outcome: 'forged' }));
  try {
    const pushed = await run({ port: server.address().port, cwd: s.cwd, env: { RUN_RECORD_PUSH_OUTCOME: 'failure', RUN_RECORD_PR_NUMBER: '8' } });
    assert.equal(pushed.code, 0, pushed.stderr);
    const record = JSON.parse(state.files['metrics/runs/2026-10/555-1.json']);
    const push = record.events.find((e) => e.event === 'workflow.push');
    assert.deepEqual([push.level, push.meta.outcome], ['warn', 'failure']);

    await fs.rm(path.join(s.traceDir, '555.json'));
    await fs.symlink(outside, path.join(s.traceDir, '555.json'));
    const linked = await run({ port: server.address().port, cwd: s.cwd, env: { GITHUB_RUN_ATTEMPT: '2' } });
    assert.equal(linked.code, 0);
    assert.match(linked.stdout, /Nothing committed: nothing to commit/);
    assert.ok(!('metrics/runs/2026-10/555-2.json' in state.files));
  } finally {
    server.close();
    await s.cleanup();
    await fs.rm(outside, { force: true });
  }
});

test('a missing metrics branch or missing run metadata is a ::warning::, exit 0 (best effort)', async () => {
  const { server } = await startGitHub({ branchStatus: 404 });
  const s = await scratch({ metrics: 'x' });
  try {
    const missing = await run({ port: server.address().port, cwd: s.cwd, env: { METRICS_FILE: s.metricsFile } });
    assert.equal(missing.code, 0);
    assert.match(missing.stdout, /::warning::Failed to commit metrics after 3 attempts; data may be lost \(branch metrics not found\)/);
    const noRun = await run({ port: server.address().port, cwd: s.cwd, env: { GITHUB_RUN_ID: '' } });
    assert.equal(noRun.code, 0);
    assert.match(noRun.stdout, /::warning::commit_run_record: GITHUB_REPOSITORY and GITHUB_RUN_ID are required/);
  } finally {
    server.close();
    await s.cleanup();
  }
});

test('an unparsable trace still commits the metrics lines, with a warning that leaks no content', async () => {
  const { server, state } = await startGitHub();
  const s = await scratch({ metrics: 'L' });
  await fs.writeFile(path.join(s.traceDir, '555.json'), `{"secret": "${PLANTED}"`);
  try {
    const result = await run({ port: server.address().port, cwd: s.cwd, env: { METRICS_FILE: s.metricsFile } });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /::warning::commit_run_record: unreadable trace 555\.json \(SyntaxError\)/);
    assert.ok(!result.stdout.includes(PLANTED));
    assert.deepEqual(Object.keys(state.files), ['metrics/runs.jsonl']);
  } finally {
    server.close();
    await s.cleanup();
  }
});
