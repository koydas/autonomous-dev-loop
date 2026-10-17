// ADR-0041: scripts/reset_auto_fix.mjs — the reset-auto-fix workflow's logic, instrumented so the run
// joins the trace of the PR's work item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { resetAutoFix, resetLabels } from '../reset_auto_fix.mjs';
import { traceIdFor } from '../lib/trace_context.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'reset_auto_fix.mjs');
const LABELS = resetLabels(readFileSync(path.join(ROOT, 'config', 'labels.yaml'), 'utf8'));

function fakeRequest({ present = [], applyStatus = 200, failOn = null, pr = { number: 8, head: { ref: 'ai/issue-5' }, body: '' } } = {}) {
  const calls = [];
  const request = async (method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    if (failOn && `${method} ${apiPath}`.startsWith(failOn)) return { status: 500, ok: false };
    if (method === 'GET') return { status: 200, ok: true, json: pr };
    if (method === 'DELETE') {
      const label = decodeURIComponent(apiPath.split('/labels/')[1]);
      return present.includes(label) || label === LABELS.changesLabel ? { status: 200, ok: true } : { status: 404, ok: false };
    }
    return { status: applyStatus, ok: applyStatus < 300 };
  };
  return { request, calls };
}

const quiet = async (fn) => {
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = original; }
};

test('resetLabels: attempt labels and changes-requested come from config/labels.yaml', () => {
  assert.equal(LABELS.attemptLabels.length, 3);
  assert.ok(LABELS.attemptLabels.every((l) => typeof l === 'string' && l));
  assert.equal(typeof LABELS.changesLabel, 'string');
});

test('resetAutoFix: removes the present attempt labels, re-applies changes-requested when asked', async () => {
  const { request, calls } = fakeRequest({ present: [LABELS.attemptLabels[0], LABELS.attemptLabels[2]] });
  const result = await quiet(() => resetAutoFix({ request, prNumber: 8, retrigger: true, ...LABELS }));
  assert.deepEqual(result, { removed: [LABELS.attemptLabels[0], LABELS.attemptLabels[2]], retriggered: true });
  assert.deepEqual(calls.at(-1), { method: 'POST', apiPath: '/issues/8/labels', body: { labels: [LABELS.changesLabel] } });
  const noRetrigger = fakeRequest();
  assert.deepEqual(await quiet(() => resetAutoFix({ request: noRetrigger.request, prNumber: 8, retrigger: false, ...LABELS })), { removed: [], retriggered: false });
  assert.ok(!noRetrigger.calls.some((c) => c.method === 'POST'));
});

test('resetAutoFix: a non-404 API failure throws with the path and status', async () => {
  const { request } = fakeRequest({ failOn: 'DELETE /issues/8/labels/' });
  await assert.rejects(quiet(() => resetAutoFix({ request, prNumber: 8, retrigger: true, ...LABELS })), /GitHub API DELETE \/issues\/8\/labels\/.+ → 500/);
  const refused = fakeRequest({ applyStatus: 404 });
  assert.equal((await quiet(() => resetAutoFix({ request: refused.request, prNumber: 8, retrigger: true, ...LABELS }))).retriggered, false);
});

function startGitHub(pr) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(req.method === 'GET' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(req.method === 'GET' ? JSON.stringify(pr) : '{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function run(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: the run writes a trace in the work item of the PR (branch ai/issue-<n>), with its stage span and events', async () => {
  const server = await startGitHub({ number: 8, head: { ref: 'ai/issue-5' }, body: 'PRIVATE body' });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-'));
  await fs.mkdir(path.join(cwd, 'config'));
  await fs.copyFile(path.join(ROOT, 'config', 'labels.yaml'), path.join(cwd, 'config', 'labels.yaml'));
  try {
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_RUN_ID: '4242', PR_NUMBER: '8', RETRIGGER: 'false' };
    const ok = await run(cwd, env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Removed 0 auto-fix-attempt label\(s\) from PR #8\./);
    const trace = JSON.parse(await fs.readFile(path.join(cwd, 'observability', 'traces', '4242.json'), 'utf8'));
    assert.equal(trace.trace_id, traceIdFor('owner/repo#issue-5'));
    assert.equal(trace.item.source, 'branch');
    assert.deepEqual(trace.spans.map((s) => [s.stage, s.outcome]), [['autofix_reset', 'success']]);
    assert.deepEqual(trace.events.map((e) => e.event), ['autofix_reset.start', 'trace.work_item', 'autofix_reset.labels_removed', 'autofix_reset.complete']);
    assert.ok(!JSON.stringify(trace).includes('PRIVATE'));

    const bad = await run(cwd, { ...env, PR_NUMBER: 'x', GITHUB_RUN_ID: '4243' });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /::error::PR_NUMBER \(positive integer\)/);
    const failed = JSON.parse(await fs.readFile(path.join(cwd, 'observability', 'traces', '4243.json'), 'utf8'));
    assert.equal(failed.outcome, 'failed');
    assert.ok(failed.events.some((e) => e.event === 'autofix_reset.error'));
  } finally {
    server.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
