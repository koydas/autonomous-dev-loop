// ADR-0043 amendment (2026-10-21): scripts/item_closed.mjs — item-closed.yml journals the end of a work item as
// one `item.closed` event. No GitHub call, no LLM; the work item comes from the event payload (ADR-0041).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closedMeta, STATE_REASONS } from '../item_closed.mjs';
import { EVENT_META_ALLOWLIST, redactTrace } from '../lib/run_record.mjs';
import { traceIdFor } from '../lib/trace_context.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'item_closed.mjs');

test('closedMeta: an issue gives its closing reason, a pull request whether it was merged', () => {
  for (const reason of STATE_REASONS) assert.deepEqual(closedMeta({ kind: 'issue', stateReason: reason }), { state_reason: reason });
  assert.deepEqual(closedMeta({ kind: 'pull_request', merged: 'true' }), { merged: true });
  assert.deepEqual(closedMeta({ kind: 'pull_request', merged: 'false' }), { merged: false });
});

test('closedMeta: an unknown reason is published as unknown, a missing or invalid flag and an unknown kind fail fast', () => {
  assert.deepEqual(closedMeta({ kind: 'issue', stateReason: 'a secret body text' }), { state_reason: null });
  assert.deepEqual(closedMeta({ kind: 'issue' }), { state_reason: null });
  assert.throws(() => closedMeta({ kind: 'pull_request' }), /ITEM_MERGED must be "true" or "false"/);
  assert.throws(() => closedMeta({ kind: 'pull_request', merged: '' }), /ITEM_MERGED/);
  assert.throws(() => closedMeta({ kind: 'pull_request', merged: 'yes' }), /ITEM_MERGED/);
  assert.throws(() => closedMeta({ kind: 'discussion' }), /ITEM_KIND must be "issue" or "pull_request"/);
  assert.throws(() => closedMeta(), /ITEM_KIND/);
});

test('item.closed publishes state_reason and merged only', () => {
  assert.deepEqual(EVENT_META_ALLOWLIST['item.closed'], ['state_reason', 'merged']);
  assert.deepEqual(EVENT_META_ALLOWLIST['item.error'], ['error']);
  const trace = {
    schema_version: 2, run_id: '9', started_at: '2026-10-21T10:00:00.000Z', completed_at: '2026-10-21T10:00:01.000Z', outcome: 'success', spans: [],
    events: [{ ts: '2026-10-21T10:00:00.500Z', stage: 'item', event: 'item.closed', level: 'info', duration_ms: 3, meta: { merged: true, state_reason: 'completed', title: 'PRIVATE title', actor: 'someone', prNumber: 7 } }],
  };
  const record = redactTrace(trace, { env: {} });
  assert.deepEqual(record.events[0].meta, { merged: true, state_reason: 'completed' });
});

function run(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('CLI: the run joins the trace of the item from the event payload, opens no stage span and writes the closing event', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'item-closed-'));
  const payload = path.join(cwd, 'event.json');
  try {
    // A pull request closed on the branch of issue 5: the run belongs to the trace of issue 5.
    await fs.writeFile(payload, JSON.stringify({ action: 'closed', pull_request: { number: 8, merged: true, head: { ref: 'ai/issue-5', sha: 'a'.repeat(40) }, body: 'PRIVATE body' } }));
    const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '4242', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: payload, ITEM_KIND: 'pull_request', ITEM_MERGED: 'true' };
    const ok = await run(cwd, env);
    assert.equal(ok.code, 0, ok.stderr);
    const trace = JSON.parse(await fs.readFile(path.join(cwd, 'observability', 'traces', '4242.json'), 'utf8'));
    assert.equal(trace.trace_id, traceIdFor('owner/repo#issue-5'));
    assert.deepEqual(trace.item, { kind: 'issue', number: 5, source: 'branch', key: 'owner/repo#issue-5' });
    assert.deepEqual(trace.spans, [], 'a closing is not a pipeline stage');
    assert.deepEqual(trace.events.map((e) => e.event), ['item.start', 'item.closed']);
    const closed = trace.events.at(-1);
    assert.deepEqual(closed.meta, { merged: true });
    assert.equal(typeof closed.duration_ms, 'number');
    assert.equal(trace.envelope.event_name, 'pull_request');
    assert.equal(trace.envelope.pr_number, 8);
    assert.ok(!JSON.stringify(trace).includes('PRIVATE'));

    // An issue closed as not planned.
    await fs.writeFile(payload, JSON.stringify({ action: 'closed', issue: { number: 200, state_reason: 'not_planned', body: 'PRIVATE' } }));
    const issue = await run(cwd, { ...env, GITHUB_RUN_ID: '4244', GITHUB_EVENT_NAME: 'issues', ITEM_KIND: 'issue', ITEM_STATE_REASON: 'not_planned', ITEM_MERGED: '' });
    assert.equal(issue.code, 0, issue.stderr);
    const t2 = JSON.parse(await fs.readFile(path.join(cwd, 'observability', 'traces', '4244.json'), 'utf8'));
    assert.equal(t2.trace_id, traceIdFor('owner/repo#issue-200'));
    assert.deepEqual(t2.events.at(-1).meta, { state_reason: 'not_planned' });

    // An invalid environment fails the run with a terminal item.error event.
    const bad = await run(cwd, { ...env, GITHUB_RUN_ID: '4243', ITEM_MERGED: 'maybe' });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /::error::ITEM_MERGED must be "true" or "false"/);
    const failed = JSON.parse(await fs.readFile(path.join(cwd, 'observability', 'traces', '4243.json'), 'utf8'));
    assert.equal(failed.outcome, 'failed');
    assert.deepEqual(failed.events.map((e) => e.event), ['item.start', 'item.error']);
    assert.equal(failed.events.at(-1).level, 'error');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
