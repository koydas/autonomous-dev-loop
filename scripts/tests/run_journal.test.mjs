// ADR-0040: the run journal — every log() event in the trace file, capped and counted, plus the run envelope.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { log, createTracer, withSpan } from '../lib/observability.mjs';
import {
  attachJournal, recordEvent, buildEnvelope,
  TRACE_SCHEMA_VERSION, JOURNAL_MAX_EVENTS, JOURNAL_MAX_BYTES, EVENT_MAX_BYTES,
} from '../lib/run_journal.mjs';
import { currentSpanId, rootSpanId, JOURNAL_MAX_SPANS } from '../lib/run_journal.mjs';
import { traceIdFor, SPAN_ID_RE, TRACE_ID_RE } from '../lib/trace_context.mjs';
import { redactTrace } from '../lib/run_record.mjs';

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
  fs.writeFileSync(tracePath, JSON.stringify({ run_id: id, envelope: { run_id: '77', run_attempt: 1 }, spans: [{ stage: 'issue_validation' }], events: [{ event: 'issue_validation.pass' }], events_overflow: { count: 2, bytes: 40 }, outcome: 'success' }));
  const trace = withEnv({ GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: undefined }, () => {
    createTracer({ runId: id, traceDir: dir });
    quiet(() => log({ stage: 'issue_validation', event: 'issue_validation.labels_applied' }));
    return read(id);
  });
  assert.deepEqual(trace.events.map((e) => e.event), ['issue_validation.pass', 'issue_validation.labels_applied']);
  assert.deepEqual(trace.events_overflow, { count: 2, bytes: 40 }, 'overflow of the earlier process is kept');
  assert.equal(trace.outcome, 'success', 'the earlier outcome is not touched');
  assert.equal(trace.spans.length, 1);
});

for (const [label, envelope] of [
  ['another run', { run_id: '1', run_attempt: 1 }],
  ['another attempt of this run', { run_id: '77', run_attempt: 2 }],
  ['no envelope', undefined],
]) {
  test(`a trace already at the path from ${label} (e.g. committed in the PR head) is replaced, never adopted`, () => {
    const id = runId();
    const tracePath = path.join(dir, `${id}.json`);
    const forged = {
      run_id: id, envelope, outcome: 'success',
      spans: [{ stage: 'review', outcome: 'success', meta: { verdict: 'APPROVE' } }],
      events: [{ event: 'review.comment_posted', meta: { url: 'https://github.com/o/r/pull/1#forged' } }],
      events_overflow: { count: 9, bytes: 99 },
    };
    fs.writeFileSync(tracePath, JSON.stringify(forged));
    const trace = withEnv({ GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1' }, () => {
      const tracer = createTracer({ runId: id, traceDir: dir });
      const replaced = read(id);
      assert.deepEqual(replaced.spans, [], 'the file is replaced as soon as the tracer attaches');
      assert.equal(replaced.outcome, null);
      quiet(() => { log({ stage: 'review', event: 'review.start' }); tracer.startSpan('review'); });
      return read(id);
    });
    assert.deepEqual(trace.events.map((e) => e.event), ['review.start']);
    assert.deepEqual(trace.spans.map((s) => s.meta), [{}]);
    assert.deepEqual(trace.events_overflow, { count: 0, bytes: 0 });
    assert.deepEqual(trace.envelope.links, []);
    assert.equal(trace.envelope.run_id, '77');
  });
}

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

test('meta strings are scrubbed of this process env secrets and credential shapes; the stderr line is unchanged', () => {
  const id = runId();
  const secret = 'producer-only-k3y-0123456789';
  const token = `gsk_${'a'.repeat(24)}`;
  const { lines } = withEnv({ PRODUCER_API_KEY: secret }, () => {
    createTracer({ runId: id, traceDir: dir });
    return quiet(() => log({ stage: 's', event: 'e.secret', meta: { error: `401 for ${secret}`, nested: { list: [token, 7] } } }));
  });
  assert.deepEqual(read(id).events[0].meta, { error: '401 for [redacted]', nested: { list: ['[redacted]', 7] } });
  assert.ok(lines.some((l) => l.includes(secret)), 'stderr keeps the original line');
});

test('a secret held only by the producing step never reaches the record, though the committing step lacks it', () => {
  const id = runId();
  const secret = 'llm-step-only-k3y-9876543210';
  withEnv({ LLM_STEP_API_KEY: secret }, () => {
    createTracer({ runId: id, traceDir: dir });
    // autofix.error keeps its free-text `error` (retry.wait no longer publishes one: ADR-0040 amendment).
    quiet(() => log({ stage: 'autofix', event: 'autofix.error', level: 'error', meta: { attempt: 1, error: `rejected key ${secret}` } }));
  });
  const committerEnv = { GITHUB_SERVER_URL: 'https://github.com', GH_TOKEN: 'ghs_committer_token_0123456789' };
  const record = JSON.stringify(redactTrace(read(id), { env: committerEnv }));
  assert.ok(!record.includes(secret));
  assert.ok(record.includes('rejected key [redacted]'));
});

test('span meta is scrubbed of this process env secrets too: a secret in an endSpan error never reaches the trace or the record', async () => {
  const id = runId();
  const secret = 'span-step-only-k3y-0123456789';
  await withEnv({ LLM_STEP_API_KEY: secret }, async () => {
    const tracer = createTracer({ runId: id, traceDir: dir });
    quiet(() => {
      tracer.startSpan('code_gen', { model: `m ${secret}` });
      tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: `401 invalid key ${secret}`, paths: [secret] } });
    });
    await tracer.finalize('failed');
  });
  const raw = fs.readFileSync(path.join(dir, `${id}.json`), 'utf8');
  assert.ok(!raw.includes(secret), 'the uploaded trace artifact holds no producer secret');
  assert.deepEqual(read(id).spans[0].meta, { model: 'm [redacted]', error: '401 invalid key [redacted]', paths: ['[redacted]'] });
  const record = JSON.stringify(redactTrace(read(id), { env: { GITHUB_SERVER_URL: 'https://github.com' } }));
  assert.ok(!record.includes(secret));
  assert.ok(record.includes('401 invalid key [redacted]'));
});

test('an event logged while finalize() is pending is kept: finalize never writes a merge computed before it', async () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  // A slow disk: were finalize() to write asynchronously, its content would be computed several
  // event-loop turns before it lands; an event logged in between must not be overwritten.
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const logged = [];
  const logNow = (event) => { logged.push(event); quiet(() => log({ stage: 's', event })); };
  const { writeFile } = fsPromises;
  fsPromises.writeFile = async (...args) => {
    for (let i = 0; i < 3; i += 1) await turn();
    logNow('during.finalize.write');
    return writeFile(...args);
  };
  try {
    const pending = tracer.finalize('success');
    await turn();
    logNow('during.finalize');
    await pending;
  } finally {
    fsPromises.writeFile = writeFile;
  }
  const trace = read(id);
  assert.deepEqual(trace.events.map((e) => e.event), logged);
  assert.equal(trace.outcome, 'success');
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

// ---------------------------------------------------------------------------
// ADR-0041: span ids, span context of events, child spans, work item
// ---------------------------------------------------------------------------

async function quietAsync(fn) {
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = original; }
}

test('stage spans get a span id under the run root; events carry the span they were logged in', async () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  quiet(() => {
    log({ stage: 's', event: 'before.stage' });
    tracer.startSpan('review');
    log({ stage: 's', event: 'in.stage' });
    tracer.startSpan('review', { again: true }); // a restarted stage keeps its span id
    tracer.endSpan('review');
    log({ stage: 's', event: 'after.stage' });
  });
  await tracer.finalize('success');
  const trace = read(id);
  assert.equal(trace.schema_version, 2);
  assert.match(trace.root_span_id, SPAN_ID_RE);
  const [stage] = trace.spans;
  assert.match(stage.span_id, SPAN_ID_RE);
  assert.equal(stage.parent_span_id, trace.root_span_id);
  const spanOf = Object.fromEntries(trace.events.map((e) => [e.event, e.span_id]));
  assert.deepEqual(spanOf, { 'before.stage': trace.root_span_id, 'in.stage': stage.span_id, 'after.stage': trace.root_span_id });
  assert.equal(currentSpanId(), rootSpanId());
});

test('withSpan: nested child spans, events inside carry the innermost one, error ends the span and is rethrown', async () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  let inner;
  await quietAsync(async () => {
    tracer.startSpan('autofix');
    await withSpan('outer', { 'adl.stage': 'autofix' }, async (outer) => {
      log({ stage: 's', event: 'in.outer' });
      inner = await withSpan('llm_call', {}, async (span) => {
        span.setAttributes({ 'gen_ai.system': 'groq' });
        log({ stage: 's', event: 'in.inner' });
        return span.spanId;
      });
      outer.setAttributes({ done: true });
    });
    const boom = Object.assign(new Error('boom'), { errorType: 'TRANSIENT' });
    await assert.rejects(withSpan('llm_call', {}, async () => { throw boom; }), (err) => err === boom);
    await assert.rejects(withSpan('llm_call', {}, async (span) => { span.setAttributes({ 'error.type': 'mine' }); throw new TypeError('x'); }));
    tracer.endSpan('autofix');
  });
  await tracer.finalize('partial');
  const trace = read(id);
  const stage = trace.spans.find((s) => s.stage === 'autofix');
  const mine = trace.child_spans.filter((s) => s.parent_span_id === stage.span_id || trace.child_spans.some((p) => p.span_id === s.parent_span_id && p.parent_span_id === stage.span_id));
  const outer = mine.find((s) => s.name === 'outer');
  const innerSpan = mine.find((s) => s.span_id === inner);
  assert.equal(outer.parent_span_id, stage.span_id);
  assert.equal(innerSpan.parent_span_id, outer.span_id);
  assert.deepEqual([outer.status, innerSpan.status], ['ok', 'ok']);
  assert.deepEqual(outer.attributes, { 'adl.stage': 'autofix', done: true });
  assert.equal(trace.events.find((e) => e.event === 'in.inner').span_id, inner);
  assert.equal(trace.events.find((e) => e.event === 'in.outer').span_id, outer.span_id);
  const failed = mine.filter((s) => s.status === 'error');
  assert.deepEqual(failed.map((s) => s.attributes['error.type']), ['TRANSIENT', 'mine'], 'the caller error.type is kept');
  assert.ok(failed.every((s) => s.completed_at && s.duration_ms >= 0));
});

test('withSpan: concurrent calls (eval workers) keep their own span context', async () => {
  const id = runId();
  createTracer({ runId: id, traceDir: dir });
  const tick = () => new Promise((r) => setImmediate(r));
  const ids = await quietAsync(() => Promise.all(['a', 'b', 'c'].map((name) => withSpan('eval.case', { name }, async (span) => {
    for (let i = 0; i < 3; i++) { await tick(); log({ stage: 'eval', event: `case.${name}` }); }
    return span.spanId;
  }))));
  const trace = read(id);
  ['a', 'b', 'c'].forEach((name, i) => {
    const events = trace.events.filter((e) => e.event === `case.${name}`);
    assert.equal(events.length, 3);
    assert.ok(events.every((e) => e.span_id === ids[i]), `case ${name} events stay in its span`);
  });
});

test(`span cap: past ${JOURNAL_MAX_SPANS} child spans, the rest is counted in spans_overflow and still runs`, async () => {
  const id = runId();
  const tracer = createTracer({ runId: id, traceDir: dir });
  let ran = 0;
  await quietAsync(async () => { for (let i = 0; i < JOURNAL_MAX_SPANS + 4; i++) await withSpan('llm_call', {}, async () => { ran += 1; }); });
  await tracer.finalize('success');
  const trace = read(id);
  assert.equal(ran, JOURNAL_MAX_SPANS + 4, 'business logic always runs');
  assert.equal(trace.child_spans.length, JOURNAL_MAX_SPANS);
  assert.deepEqual(trace.spans_overflow, { count: 4 });
});

test('a later step of the same job adopts the run root and its child spans; a foreign trace contributes none', () => {
  const id = runId();
  const tracePath = path.join(dir, `${id}.json`);
  const root = 'b'.repeat(16);
  const child = { span_id: 'c'.repeat(16), parent_span_id: root, name: 'llm_call', status: 'ok', attributes: {} };
  fs.writeFileSync(tracePath, JSON.stringify({ run_id: id, envelope: { run_id: '88', run_attempt: 1 }, root_span_id: root, spans: [], child_spans: [child], spans_overflow: { count: 2 }, events: [] }));
  const trace = withEnv({ GITHUB_RUN_ID: '88', GITHUB_RUN_ATTEMPT: '1' }, () => {
    quiet(() => log({ stage: 's', event: 'pre.attach' }));
    createTracer({ runId: id, traceDir: dir });
    quiet(() => log({ stage: 's', event: 'post.attach' }));
    return read(id);
  });
  assert.equal(trace.root_span_id, root);
  assert.ok(trace.events.every((e) => e.span_id === root), 'events of this process join the adopted root');
  assert.deepEqual(trace.child_spans.map((s) => s.span_id), [child.span_id]);
  assert.deepEqual(trace.spans_overflow, { count: 2 });

  const foreignId = runId();
  fs.writeFileSync(path.join(dir, `${foreignId}.json`), JSON.stringify({ envelope: { run_id: '1', run_attempt: 1 }, root_span_id: root, child_spans: [child] }));
  const fresh = withEnv({ GITHUB_RUN_ID: '88', GITHUB_RUN_ATTEMPT: '1' }, () => { createTracer({ runId: foreignId, traceDir: dir }); return read(foreignId); });
  assert.notEqual(fresh.root_span_id, root);
  assert.deepEqual(fresh.child_spans, []);
});

test('the trace carries the work item and trace id: PR body parsed for numbers only, trace.work_item hints after it', () => {
  const id = runId();
  const payloadPath = path.join(dir, `event-${id}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ pull_request: { number: 8, head: { ref: 'feature/x' }, body: 'PRIVATE BODY text. Closes #5' } }));
  const trace = withEnv({ ...ACTIONS_ENV, GITHUB_EVENT_PATH: payloadPath }, () => {
    createTracer({ runId: id, traceDir: dir });
    quiet(() => log({ stage: 'review', event: 'trace.work_item', meta: { prNumber: 8, branchIssue: 6, closingIssues: [] } }));
    return read(id);
  });
  assert.deepEqual(trace.item, { kind: 'issue', number: 6, source: 'branch', key: `${ACTIONS_ENV.GITHUB_REPOSITORY}#issue-6` }, 'the PR head branch (hint) wins over the body');
  assert.equal(trace.trace_id, traceIdFor(`${ACTIONS_ENV.GITHUB_REPOSITORY}#issue-6`));
  assert.ok(!JSON.stringify(trace).includes('PRIVATE BODY'), 'the body is never kept');

  const runOnly = runId();
  const t2 = withEnv({ ...ACTIONS_ENV, GITHUB_EVENT_PATH: path.join(dir, 'missing.json') }, () => { createTracer({ runId: runOnly, traceDir: dir }); quiet(() => log({ stage: 'eval', event: 'eval.start' })); return read(runOnly); });
  assert.equal(t2.item.kind, 'run', 'no item: the run is its own trace (evals)');
  assert.match(t2.trace_id, TRACE_ID_RE);
});
