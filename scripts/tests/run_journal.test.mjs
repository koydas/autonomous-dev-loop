// ADR-0039: the run journal — every log() event in the trace file, capped and counted, plus the run envelope.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log, createTracer } from '../lib/observability.mjs';
import {
  attachJournal, recordEvent, buildEnvelope,
  TRACE_SCHEMA_VERSION, JOURNAL_MAX_EVENTS, JOURNAL_MAX_BYTES, EVENT_MAX_BYTES,
} from '../lib/run_journal.mjs';

let dir;
let seq = 0;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const runId = () => `run-${process.pid}-${++seq}`;
const read = (id, d = dir) => JSON.parse(fs.readFileSync(path.join(d, `${id}.json`), 'utf8'));

function quiet(fn) {
  const out = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { out.push(String(chunk)); return true; };
  try { return { result: fn(), lines: out }; } finally { process.stderr.write = original; }
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('every log() event of the run lands in trace.events, in order, next to the spans', async () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  quiet(() => {
    log({ stage: 'review', event: 'review.start', meta: { prNumber: 3 } });
    tracer.startSpan('review', { prNumber: 3 });
    log({ stage: 'review', event: 'review.verdict', duration_ms: 12, meta: { verdict: 'APPROVE' } });
    tracer.endSpan('review', { outcome: 'success' });
  });
  await tracer.finalize('success');
  const trace = read(id);
  assert.equal(trace.schema_version, TRACE_SCHEMA_VERSION);
  assert.deepEqual(trace.events.map((e) => e.event), ['review.start', 'review.verdict']);
  assert.equal(trace.events[1].duration_ms, 12);
  assert.deepEqual(trace.events[1].meta, { verdict: 'APPROVE' });
  assert.equal(trace.spans.length, 1);
  assert.equal(trace.outcome, 'success');
  assert.deepEqual(trace.events_overflow, { count: 0, bytes: 0 });
});

test('the trace is readable after each event (no tracer write needed), so a killed job keeps its events', () => {
  const id = runId();
  createTracer({ runId: id, traceDir: dir });
  quiet(() => log({ stage: 's', event: 'e.one' }));
  assert.deepEqual(read(id).events.map((e) => e.event), ['e.one']);
  assert.deepEqual(read(id).spans, []);
});

test('events logged before the tracer exists are adopted by it', () => {
  const id = runId();
  quiet(() => log({ stage: 's', event: 'before.tracer' }));
  // The previous test's sink is still attached: re-attaching to a new path starts a new run journal.
  const tracer = createTracer({ runId: id, traceDir: dir });
  quiet(() => { log({ stage: 's', event: 'after.tracer' }); tracer.startSpan('s'); });
  assert.deepEqual(read(id).events.map((e) => e.event), ['after.tracer']);
});

test('a later process (next step of the job) appends to the events already in the trace', () => {
  const id = runId();
  const tracePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(tracePath, JSON.stringify({ run_id: id, spans: [{ stage: 'issue_validation' }], events: [{ event: 'issue_validation.pass' }], events_overflow: { count: 2, bytes: 40 }, outcome: 'success' }));
  createTracer({ runId: id, traceDir: dir });
  quiet(() => log({ stage: 'issue_validation', event: 'issue_validation.labels_applied' }));
  const trace = read(id);
  assert.deepEqual(trace.events.map((e) => e.event), ['issue_validation.pass', 'issue_validation.labels_applied']);
  assert.deepEqual(trace.events_overflow, { count: 2, bytes: 40 }, 'overflow of the earlier process is kept');
  assert.equal(trace.outcome, 'success', 'the earlier outcome is not touched');
  assert.equal(trace.spans.length, 1);
});

test(`count cap: past ${JOURNAL_MAX_EVENTS} events, the rest is counted in events_overflow, not kept`, async () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  quiet(() => { for (let i = 0; i < JOURNAL_MAX_EVENTS + 3; i++) log({ stage: 's', event: 'e.n', meta: { i } }); });
  assert.equal(read(id).events_overflow.count, 0, 'a full journal does not rewrite the file per overflowed event');
  await tracer.finalize('success');
  const trace = read(id);
  assert.equal(trace.events.length, JOURNAL_MAX_EVENTS);
  assert.equal(trace.events.at(-1).meta.i, JOURNAL_MAX_EVENTS - 1, 'the first events are kept');
  assert.equal(trace.events_overflow.count, 3);
  assert.ok(trace.events_overflow.bytes > 0);
});

test(`byte cap: the journal never holds more than ${JOURNAL_MAX_BYTES} bytes of events`, () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  const filler = 'x'.repeat(EVENT_MAX_BYTES - 400);
  const n = Math.ceil(JOURNAL_MAX_BYTES / (EVENT_MAX_BYTES - 200)) + 2;
  quiet(() => { for (let i = 0; i < n; i++) log({ stage: 's', event: 'e.big', meta: { filler } }); tracer.endSpan('s'); });
  const trace = read(id);
  const kept = trace.events.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)), 0);
  assert.ok(kept <= JOURNAL_MAX_BYTES, `${kept} bytes kept`);
  assert.ok(trace.events_overflow.count >= 1);
  assert.equal(trace.events.length + trace.events_overflow.count, n, 'every event is kept or counted');
});

test('an event over EVENT_MAX_BYTES keeps its name and timing; its meta is replaced by its size', () => {
  const id = runId();
  createTracer({ runId: id, traceDir: dir });
  quiet(() => log({ stage: 'review', event: 'review.huge', level: 'warn', duration_ms: 5, meta: { blob: 'y'.repeat(EVENT_MAX_BYTES * 2) } }));
  const [event] = read(id).events;
  assert.equal(event.event, 'review.huge');
  assert.equal(event.level, 'warn');
  assert.equal(event.duration_ms, 5);
  assert.deepEqual(Object.keys(event.meta), ['_meta_dropped_bytes']);
  assert.ok(event.meta._meta_dropped_bytes > EVENT_MAX_BYTES);
});

test('a circular meta is journaled as the serialized stderr line ([Circular]), never throws', () => {
  const id = runId();
  createTracer({ runId: id, traceDir: dir });
  const meta = { a: 1 };
  meta.self = meta;
  quiet(() => log({ stage: 's', event: 'e.circular', meta }));
  assert.deepEqual(read(id).events[0].meta, { a: 1, self: '[Circular]' });
});

test('stdout is never written (GITHUB_OUTPUT protocol)', () => {
  const id = runId();
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    const tracer = createTracer({ runId: id, traceDir: dir });
    quiet(() => { log({ stage: 's', event: 'e.x' }); tracer.startSpan('s'); });
  } finally { process.stdout.write = original; }
  assert.deepEqual(writes, []);
});

test('a journal write failure is one trace_write_failed warn per process, never a throw or a loop', () => {
  const id = runId();
  const blocked = path.join(dir, `blocked-${id}`);
  fs.mkdirSync(blocked);
  // The trace path is a directory: every read and write fails with EISDIR.
  fs.mkdirSync(path.join(blocked, `${id}.json`));
  createTracer({ runId: id, traceDir: blocked });
  const { lines } = quiet(() => { log({ stage: 's', event: 'e.1' }); log({ stage: 's', event: 'e.2' }); log({ stage: 's', event: 'e.3' }); });
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.filter((e) => e.event === 'trace_write_failed').length, 1);
  assert.deepEqual(parsed.filter((e) => e.event.startsWith('e.')).map((e) => e.event), ['e.1', 'e.2', 'e.3']);
});

test('a missing trace directory is not an error: the events stay in memory for the next tracer write', () => {
  const id = runId();
  const gone = path.join(dir, `gone-${id}`);
  const tracer = createTracer({ runId: id, traceDir: gone });
  fs.rmSync(gone, { recursive: true, force: true });
  const { lines } = quiet(() => log({ stage: 's', event: 'e.lost' }));
  assert.ok(!lines.some((l) => l.includes('trace_write_failed')));
  quiet(() => tracer.startSpan('s'));
  assert.deepEqual(read(id, gone).events.map((e) => e.event), ['e.lost']);
});

test('an unparsable trace (tracer write in flight) is left alone; the next tracer write carries the event', () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  fs.writeFileSync(path.join(dir, `${id}.json`), '{"run_id": "half-writ');
  quiet(() => log({ stage: 's', event: 'e.pending' }));
  assert.equal(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'), '{"run_id": "half-writ');
  quiet(() => tracer.startSpan('s'));
  assert.deepEqual(read(id).events.map((e) => e.event), ['e.pending']);
});

test('recordEvent ignores a line that is not JSON and attachJournal never throws', () => {
  assert.equal(recordEvent('not json'), null);
  assert.doesNotThrow(() => attachJournal({ tracePath: path.join(dir, 'x', 'y.json'), skeleton: () => ({ spans: [] }) }));
});

// ---------------------------------------------------------------------------
// Run envelope
// ---------------------------------------------------------------------------

const ACTIONS_ENV = {
  GITHUB_WORKFLOW: 'PR Review',
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_ACTOR: 'octocat',
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_SERVER_URL: 'https://github.com',
};

test('envelope: workflow, run id/attempt, trigger, actor type, PR number, head SHA and URLs from env + payload', () => {
  const sha = 'a'.repeat(40);
  const env = buildEnvelope(ACTIONS_ENV, { pull_request: { number: 12, head: { sha } }, sender: { type: 'User' } }, []);
  assert.equal(env.workflow, 'PR Review');
  assert.equal(env.run_id, '123456789');
  assert.equal(env.run_attempt, 2);
  assert.equal(env.event_name, 'pull_request');
  assert.equal(env.actor, 'octocat');
  assert.equal(env.actor_type, 'human');
  assert.equal(env.pr_number, 12);
  assert.equal(env.issue_number, null);
  assert.equal(env.head_sha, sha);
  assert.equal(env.run_url, 'https://github.com/owner/repo/actions/runs/123456789/attempts/2');
  assert.equal(env.pr_url, 'https://github.com/owner/repo/pull/12');
  assert.equal(env.issue_url, null);
});

test('envelope: a bot sender or a [bot] actor is a bot; no actor is null', () => {
  assert.equal(buildEnvelope({ ...ACTIONS_ENV, GITHUB_ACTOR: 'koydas' }, { sender: { type: 'Bot' } }).actor_type, 'bot');
  assert.equal(buildEnvelope({ ...ACTIONS_ENV, GITHUB_ACTOR: 'github-actions[bot]' }, null).actor_type, 'bot');
  assert.equal(buildEnvelope({}, null).actor_type, null);
});

test('envelope: issue events, PR comments (issue.pull_request), dispatch inputs and push heads', () => {
  assert.equal(buildEnvelope(ACTIONS_ENV, { issue: { number: 4 } }).issue_number, 4);
  const comment = buildEnvelope(ACTIONS_ENV, { issue: { number: 9, pull_request: true } });
  assert.deepEqual([comment.pr_number, comment.issue_number], [9, null]);
  assert.equal(buildEnvelope(ACTIONS_ENV, { inputs: { issue_number: '17' } }).issue_number, 17);
  assert.equal(buildEnvelope(ACTIONS_ENV, { after: 'b'.repeat(40) }).head_sha, 'b'.repeat(40));
});

test('envelope: numbers the payload lacks are filled from the first event meta; no env → null URLs', () => {
  const events = [{ event: 'review.start', meta: { prNumber: '31' } }, { event: 'review.skipped', meta: { headSha: 'c'.repeat(40) } }, { event: 'code_gen.start', meta: { issueNumber: 8 } }];
  const env = buildEnvelope(ACTIONS_ENV, { after: undefined }, events);
  assert.deepEqual([env.pr_number, env.issue_number, env.head_sha], [31, 8, 'c'.repeat(40)]);
  const bare = buildEnvelope({}, null, []);
  assert.deepEqual([bare.run_url, bare.pr_url, bare.run_attempt, bare.workflow], [null, null, 1, null]);
});

test('envelope: links from event meta.url and one llm_calls entry per llm_call / llm_call_failed', () => {
  const events = [
    { stage: 'review', event: 'llm_call', duration_ms: 900, meta: { provider: 'groq', model: 'openai/gpt-oss-120b', fallback: false } },
    { stage: 'review', event: 'review.comment_posted', meta: { url: 'https://github.com/owner/repo/pull/1#issuecomment-5' } },
    { stage: 'autofix', event: 'llm_call_failed', duration_ms: 3, meta: { providers: ['groq:429'] } },
    { stage: 'review', event: 'review.labels_applied', meta: { url: null } },
  ];
  const env = buildEnvelope(ACTIONS_ENV, null, events);
  assert.deepEqual(env.links, [{ event: 'review.comment_posted', url: 'https://github.com/owner/repo/pull/1#issuecomment-5' }]);
  assert.deepEqual(env.llm_calls, [
    { stage: 'review', provider: 'groq', model: 'openai/gpt-oss-120b', fallback: false, outcome: 'answered', duration_ms: 900 },
    { stage: 'autofix', provider: null, model: null, fallback: false, outcome: 'failed', duration_ms: 3 },
  ]);
});

test('the trace carries the envelope built from the Actions env and GITHUB_EVENT_PATH', () => {
  const id = runId();
  const payloadPath = path.join(dir, `event-${id}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ issue: { number: 77, title: 'secret title', body: 'body' }, sender: { type: 'User', login: 'u' } }));
  withEnv({ ...ACTIONS_ENV, GITHUB_EVENT_NAME: 'issues', GITHUB_EVENT_PATH: payloadPath }, () => {
    const tracer = createTracer({ runId: id, traceDir: dir });
    quiet(() => tracer.startSpan('issue_validation'));
  });
  const { envelope } = read(id);
  assert.equal(envelope.issue_number, 77);
  assert.equal(envelope.event_name, 'issues');
  assert.equal(envelope.issue_url, 'https://github.com/owner/repo/issues/77');
  assert.ok(!JSON.stringify(envelope).includes('secret title'), 'only the fields the envelope needs are read from the payload');
});

test('an unreadable GITHUB_EVENT_PATH leaves the payload fields null', () => {
  const id = runId();
  withEnv({ ...ACTIONS_ENV, GITHUB_EVENT_PATH: path.join(dir, 'missing.json') }, () => {
    const tracer = createTracer({ runId: id, traceDir: dir });
    quiet(() => tracer.startSpan('s'));
  });
  assert.equal(read(id).envelope.pr_number, null);
});
