import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log, createTracer } from '../lib/observability.mjs';

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

let traceDir;

before(async () => {
  traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-test-'));
});

after(async () => {
  await fs.rm(traceDir, { recursive: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStderr(fn) {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return lines;
}

async function captureStderrAsync(fn) {
  const lines = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { await fn(); } finally { process.stderr.write = original; }
  return lines;
}

function readTrace(runId, dir) {
  return JSON.parse(readFileSync(path.join(dir, `${runId}.json`), 'utf8'));
}

// ---------------------------------------------------------------------------
// log() — unit tests
// ---------------------------------------------------------------------------

test('log emits a JSON line to stderr', () => {
  const lines = captureStderr(() => {
    log({ stage: 'test_stage', event: 'test_event', level: 'info' });
  });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.stage, 'test_stage');
  assert.equal(parsed.event, 'test_event');
  assert.equal(parsed.level, 'info');
});

test('log includes ts, run_id, stage, event, level, duration_ms, meta fields', () => {
  const lines = captureStderr(() => {
    log({ stage: 's', event: 'e', level: 'warn', duration_ms: 42, meta: { foo: 'bar' } });
  });
  const parsed = JSON.parse(lines[0]);
  assert.ok(typeof parsed.ts === 'string', 'ts must be a string');
  assert.ok(typeof parsed.run_id === 'string', 'run_id must be a string');
  assert.equal(parsed.duration_ms, 42);
  assert.deepEqual(parsed.meta, { foo: 'bar' });
});

test('log defaults duration_ms to null when omitted', () => {
  const lines = captureStderr(() => { log({ stage: 's', event: 'e' }); });
  assert.equal(JSON.parse(lines[0]).duration_ms, null);
});

test('log defaults meta to {} when omitted', () => {
  const lines = captureStderr(() => { log({ stage: 's', event: 'e' }); });
  assert.deepEqual(JSON.parse(lines[0]).meta, {});
});

test('log uses GITHUB_RUN_ID env var as run_id', () => {
  const prev = process.env.GITHUB_RUN_ID;
  process.env.GITHUB_RUN_ID = 'run-xyz';
  const lines = captureStderr(() => { log({ stage: 's', event: 'e' }); });
  if (prev === undefined) delete process.env.GITHUB_RUN_ID;
  else process.env.GITHUB_RUN_ID = prev;
  assert.equal(JSON.parse(lines[0]).run_id, 'run-xyz');
});

test('log falls back to "local" when GITHUB_RUN_ID is unset', () => {
  const prev = process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ID;
  const lines = captureStderr(() => { log({ stage: 's', event: 'e' }); });
  if (prev !== undefined) process.env.GITHUB_RUN_ID = prev;
  assert.equal(JSON.parse(lines[0]).run_id, 'local');
});

test('log emits GitHub Actions annotation for error level when GITHUB_ACTIONS=true', () => {
  const prevGA = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  const lines = captureStderr(() => {
    log({ stage: 's', event: 'e', level: 'error', meta: { file: 'foo.mjs', line: 10 } });
  });
  if (prevGA === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = prevGA;

  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith('::error'), 'second line must be a GHA annotation');
  assert.ok(lines[1].includes('foo.mjs'), 'annotation must include the file');
});

test('log does not emit GHA annotation for info level even when GITHUB_ACTIONS=true', () => {
  const prevGA = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  const lines = captureStderr(() => { log({ stage: 's', event: 'e', level: 'info' }); });
  if (prevGA === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = prevGA;
  assert.equal(lines.length, 1);
});

test('log never throws on circular meta', () => {
  const circ = {};
  circ.self = circ;
  assert.doesNotThrow(() => log({ stage: 's', event: 'e', meta: circ }));
});

test('log output is always valid JSON', () => {
  const lines = captureStderr(() => {
    log({ stage: 'test', event: 'some.event', level: 'info', meta: { text: '"quotes" & <special>' } });
  });
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

// ---------------------------------------------------------------------------
// createTracer() — happy-path tests
// ---------------------------------------------------------------------------

test('tracer.startSpan creates trace file with span entry', () => {
  const runId = `start-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: 7, traceDir });

  tracer.startSpan('issue_validation', { model: 'llama' });

  const trace = readTrace(runId, traceDir);
  assert.equal(trace.run_id, runId);
  assert.equal(trace.issue_number, 7);
  assert.ok(typeof trace.started_at === 'string');
  assert.equal(trace.spans.length, 1);
  assert.equal(trace.spans[0].stage, 'issue_validation');
  assert.equal(trace.spans[0].outcome, null);
  assert.equal(trace.spans[0].meta.model, 'llama');
});

test('tracer.endSpan populates completed_at, duration_ms, and outcome', async () => {
  const runId = `end-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: 8, traceDir });

  tracer.startSpan('code_gen', { issueNumber: '8' });
  await new Promise(r => setTimeout(r, 5));
  tracer.endSpan('code_gen', { outcome: 'success', meta: { changes_count: 3 } });

  const span = readTrace(runId, traceDir).spans[0];
  assert.equal(span.outcome, 'success');
  assert.ok(typeof span.completed_at === 'string');
  assert.ok(typeof span.duration_ms === 'number' && span.duration_ms >= 0);
  assert.equal(span.meta.changes_count, 3);
});

test('tracer.finalize writes completed_at and outcome', async () => {
  const runId = `finalize-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: 9, traceDir });

  tracer.startSpan('review', { prNumber: 42 });
  tracer.endSpan('review', { outcome: 'success' });
  await tracer.finalize('success');

  const trace = readTrace(runId, traceDir);
  assert.equal(trace.outcome, 'success');
  assert.ok(typeof trace.completed_at === 'string');
});

test('tracer accumulates multiple spans in insertion order', async () => {
  const runId = `multi-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: 10, traceDir });

  for (const stage of ['issue_validation', 'code_gen', 'pr_prepare']) {
    tracer.startSpan(stage, {});
    tracer.endSpan(stage, { outcome: 'success' });
  }
  await tracer.finalize('success');

  const trace = readTrace(runId, traceDir);
  assert.deepEqual(trace.spans.map(s => s.stage), ['issue_validation', 'code_gen', 'pr_prepare']);
  assert.ok(trace.spans.every(s => s.outcome === 'success'));
});

test('tracer span outcome defaults to success when not specified', () => {
  const runId = `default-outcome-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: null, traceDir });
  tracer.startSpan('autofix', {});
  tracer.endSpan('autofix');
  assert.equal(readTrace(runId, traceDir).spans[0].outcome, 'success');
});

test('tracer creates nested traceDir that does not exist', async () => {
  const nested = path.join(traceDir, 'deep', 'nested');
  const runId = `mkdirp-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: null, traceDir: nested });
  tracer.startSpan('s', {});
  await tracer.finalize('success');
  assert.equal(readTrace(runId, nested).run_id, runId);
});

test('tracer re-using a stage name updates the existing span rather than duplicating', () => {
  const runId = `upsert-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: null, traceDir });
  tracer.startSpan('code_gen', { pass: 1 });
  tracer.startSpan('code_gen', { pass: 2 });
  const trace = readTrace(runId, traceDir);
  assert.equal(trace.spans.length, 1, 'must not duplicate the span');
  assert.equal(trace.spans[0].meta.pass, 2);
});

// ---------------------------------------------------------------------------
// createTracer() — error-containment tests
// ---------------------------------------------------------------------------

test('tracer.endSpan does not throw when startSpan was never called', () => {
  const runId = `no-start-${Date.now()}`;
  const tracer = createTracer({ runId, issueNumber: null, traceDir });
  assert.doesNotThrow(() => tracer.endSpan('stage_x', { outcome: 'success' }));
});

test('tracer.finalize emits warn log and does not throw when traceDir path is blocked', async () => {
  // Place a regular file where the traceDir would be, so mkdir fails immediately (ENOTDIR)
  const blocker = path.join(traceDir, `blocker-finalize-${Date.now()}`);
  writeFileSync(blocker, 'not-a-dir');
  const fakeTraceDir = path.join(blocker, 'child');

  const lines = await captureStderrAsync(async () => {
    const tracer = createTracer({ runId: 'bad-dir', issueNumber: null, traceDir: fakeTraceDir });
    await tracer.finalize('success');
  });

  const warnLines = lines.filter(l => {
    try { return JSON.parse(l).level === 'warn'; } catch { return false; }
  });
  assert.ok(warnLines.length >= 1, 'must emit at least one warn-level log on write failure');
});

test('tracer.startSpan does not throw when traceDir path is blocked', () => {
  // Place a regular file where the traceDir would be, so mkdirSync fails immediately (ENOTDIR)
  const blocker = path.join(traceDir, `blocker-start-${Date.now()}`);
  writeFileSync(blocker, 'not-a-dir');
  const fakeTraceDir = path.join(blocker, 'child');

  const lines = captureStderr(() => {
    const tracer = createTracer({ runId: 'bad-start', issueNumber: null, traceDir: fakeTraceDir });
    assert.doesNotThrow(() => tracer.startSpan('s', {}));
  });

  const warnLines = lines.filter(l => {
    try { return JSON.parse(l).level === 'warn'; } catch { return false; }
  });
  assert.ok(warnLines.length >= 1, 'must emit warn-level log on write failure');
});
