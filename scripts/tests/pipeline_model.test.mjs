import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeUrl, anyValue, otlpAttributes, nanoToMs, normalizeRun, normalizeTrace, parseRunsJsonl, buildPipelineModel,
  eventSummary, feedEntries, RUN_ID_RE, MAX_MONTHS,
} from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf, V1_REVIEW, V2_REVIEW, TRACE_PR_220 } from './fixtures/pipeline/records.mjs';

test('safeUrl keeps https URLs only, as given', () => {
  assert.equal(safeUrl('https://github.com/o/r/pull/1#issuecomment-2'), 'https://github.com/o/r/pull/1#issuecomment-2');
  for (const bad of ['http://github.com/x', 'javascript:alert(1)', 'https://x.io/"onmouseover=1', 'https://x y', 'https://', `https://x.io/${'a'.repeat(300)}`, null, 42, 'https://[::1']) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});

test('anyValue decodes OTLP AnyValues and drops anything else', () => {
  assert.equal(anyValue({ stringValue: 'a' }), 'a');
  assert.equal(anyValue({ stringValue: 3 }), null);
  assert.equal(anyValue({ intValue: '6299' }), 6299);
  assert.equal(anyValue({ intValue: 12 }), 12);
  assert.equal(anyValue({ intValue: '1e3' }), null);
  assert.equal(anyValue({ intValue: '99999999999999999' }), null);
  assert.equal(anyValue({ doubleValue: 0.5 }), 0.5);
  assert.equal(anyValue({ doubleValue: 'x' }), null);
  assert.equal(anyValue({ boolValue: true }), true);
  assert.equal(anyValue({ boolValue: 'true' }), null);
  assert.deepEqual(anyValue({ arrayValue: { values: [{ stringValue: 'a' }, { kvlistValue: {} }, { intValue: '2' }] } }), ['a', 2]);
  assert.equal(anyValue({ arrayValue: {} }), null);
  assert.equal(anyValue({ kvlistValue: { values: [] } }), null);
  assert.equal(anyValue('x'), null);
});

test('otlpAttributes keeps the first value of a key and skips malformed entries', () => {
  assert.deepEqual(otlpAttributes([{ key: 'a', value: { stringValue: '1' } }, { key: 'a', value: { stringValue: '2' } }, null, { key: 3 }, { key: 'b', value: {} }]), { a: '1' });
  assert.deepEqual(otlpAttributes('nope'), {});
});

test('nanoToMs converts decimal-string nanoseconds; zero, junk and over 20 digits are null', () => {
  assert.equal(nanoToMs('1792201883448000000'), 1792201883448);
  for (const bad of ['0', '-1', 'abc', 17, '999999999999999999999']) assert.equal(nanoToMs(bad), null, String(bad));
});

test('normalizeRun: a production v2 record → nested waterfall run → stage → LLM call and side effects', () => {
  const { run, error } = normalizeRun(V2_REVIEW(), 'metrics/runs/2026-10/38992537605-1.json');
  assert.equal(error, undefined);
  assert.equal(run.run_id, '38992537605-1');
  assert.equal(run.month, '2026-10');
  assert.equal(run.flat, false);
  assert.deepEqual(run.waterfall.map((s) => [s.name, s.kind, s.depth]), [
    ['run', 'run', 0], ['review', 'stage', 1], ['llm_call', 'llm', 2],
    ['review.comment_posted', 'effect', 2], ['review.review_submitted', 'effect', 2], ['review.labels_applied', 'effect', 2],
  ]);
  const llm = run.waterfall[2];
  assert.deepEqual([llm.provider, llm.model, llm.tokens], ['groq', 'openai/gpt-oss-120b', { in: 6299, out: 126, estimated: true }]);
  assert.match(run.waterfall[3].links[0], /^https:\/\/github\.com\/koydas\/autonomous-dev-loop\/pull\/220#issuecomment-/);
  assert.deepEqual(run.llm.map((c) => [c.provider, c.tokens_in, c.tokens_out, c.estimated]), [['groq', 6299, 126, true]]);
  assert.equal(run.pr_number, 220);
  assert.equal(run.item.kind, 'pr');
  assert.equal(run.trace_id, '48c0763e8e6261b16939887b4abf414c');
  assert.equal(run.duration_ms, 5311);
});

test('normalizeRun: a v1 record renders flat, LLM calls from its envelope and token events', () => {
  const { run } = normalizeRun(V1_REVIEW(), 'metrics/runs/2026-10/38848221354-1.json');
  assert.equal(run.flat, true);
  assert.equal(run.schema_version, 1);
  assert.deepEqual(run.waterfall.map((s) => [s.name, s.kind, s.depth, s.outcome]), [['run', 'run', 0, 'partial'], ['review', 'stage', 1, 'skipped']]);
  assert.deepEqual(run.llm, []);
  assert.ok(run.trace_id, 'trace id derived from the envelope (readRunRecord)');
  const v1 = JSON.parse(V1_REVIEW());
  v1.envelope.llm_calls = [{ provider: 'groq', model: 'm', duration_ms: 9, outcome: 'failed' }, { provider: 'anthropic', model: 'c' }];
  v1.events.push({ ts: '2026-10-16T04:09:00.600Z', stage: 'review', event: 'review.llm_request', level: 'info', meta: { input_tokens_est: 50 } });
  v1.events.push({ ts: '2026-10-16T04:09:00.700Z', stage: 'review', event: 'review.llm_response', level: 'info', meta: { output_tokens_est: 5 } });
  const calls = normalizeRun(v1, 'x').run.llm;
  assert.deepEqual(calls.map((c) => [c.provider, c.tokens_in, c.tokens_out, c.failed]), [['groq', 50, 5, true], ['anthropic', 0, 0, false]]);
  // Token events without an llm_calls entry still count (provider unknown).
  v1.envelope.llm_calls = [];
  assert.deepEqual(normalizeRun(v1, 'x').run.llm.map((c) => [c.provider, c.tokens_in]), [[null, 50]]);
  // A v1 failed outcome and stage → error status; no timing at all stays null.
  v1.outcome = 'failed';
  v1.spans[0].outcome = 'failed';
  delete v1.spans[0].meta;
  delete v1.completed_at;
  const flat = normalizeRun(v1, 'x').run;
  assert.deepEqual(flat.waterfall.map((s) => s.status), ['error', 'error']);
  assert.equal(flat.duration_ms, null);
  assert.equal(flat.month, '2026-10', 'month from started_at when the path has none');
});

test('normalizeRun rejects unreadable records and run ids that cannot name a page', () => {
  assert.match(normalizeRun('{nope').error, /not a readable run record/);
  assert.match(normalizeRun({ schema_version: 9 }).error, /not a readable/);
  for (const runId of ['../../x', '1-2-3', null, 'abc-1']) {
    assert.match(normalizeRun({ ...JSON.parse(V1_REVIEW()), run_id: runId }).error, /run_id missing or malformed/);
  }
  assert.ok(RUN_ID_RE.test('38992537605-1'));
});

test('normalizeRun: forged OTLP spans — duplicate ids, unknown parents and cycles are kept, never lost or looped', () => {
  const rec = JSON.parse(V2_REVIEW());
  const spans = rec.otlp.resourceSpans[0].scopeSpans[0].spans;
  const base = spans[1];
  spans.push({ ...base, spanId: 'aaaaaaaaaaaaaaaa', parentSpanId: 'bbbbbbbbbbbbbbbb', name: 'a' });
  spans.push({ ...base, spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', name: 'b' });
  spans.push({ ...base, name: 'dup' }); // same spanId as the stage
  spans.push({ ...base, spanId: 'cccccccccccccccc', parentSpanId: 'ffffffffffffffff', name: 'orphan', status: { code: 2 }, startTimeUnixNano: '0', endTimeUnixNano: 'x' });
  spans.push({ spanId: 'not-hex', name: 'bad' });
  const { run } = normalizeRun(rec, 'p');
  const names = run.waterfall.map((s) => s.name);
  assert.ok(!names.includes('dup') && !names.includes('bad'));
  assert.ok(names.includes('a') && names.includes('b'));
  const orphan = run.waterfall.find((s) => s.name === 'orphan');
  assert.deepEqual([orphan.depth, orphan.status, orphan.start, orphan.end], [0, 'error', null, null]);
  // An OTLP block with no valid span falls back to the flat view.
  rec.otlp.resourceSpans = [{ scopeSpans: [{ spans: [{ spanId: 'zz' }] }] }, { scopeSpans: 'x' }, null];
  assert.equal(normalizeRun(rec, 'p').run.flat, true);
});

test('normalizeTrace joins an index to the loaded runs and splits the lead time', () => {
  const { run } = normalizeRun(V2_REVIEW(), 'metrics/runs/2026-10/38992537605-1.json');
  const { trace } = normalizeTrace(TRACE_PR_220(), new Map([[run.run_id, run]]));
  assert.equal(trace.runs.length, 3);
  assert.deepEqual(trace.runs.map((r) => Boolean(r.run)), [false, false, true]);
  assert.equal(trace.lead_time_ms, 1853299);
  assert.equal(trace.running_ms, 6784 + 6665 + 5311);
  assert.equal(trace.waiting_ms, 1853299 - trace.running_ms);
  assert.equal(trace.item.kind, 'pr');
});

test('normalizeTrace: lead time computed when the index lacks it; overlapping runs counted once', () => {
  const idx = { schema_version: 1, trace_id: 'a'.repeat(32), item: null, runs: [
    { run_id: '1-1', started_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:10:00Z' },
    { run_id: '2-1', started_at: '2026-10-01T00:05:00Z', completed_at: '2026-10-01T00:20:00Z' },
    { run_id: '3-1', started_at: '2026-10-01T01:00:00Z', completed_at: '2026-10-01T01:00:30Z' },
    { run_id: '../evil' }, 'junk',
  ] };
  const { trace } = normalizeTrace(JSON.stringify(idx));
  assert.equal(trace.lead_time_ms, 3630000);
  assert.equal(trace.running_ms, 1200000 + 30000);
  assert.equal(trace.dropped_runs, 2);
  assert.equal(trace.item, null);
  const empty = normalizeTrace({ schema_version: 1, trace_id: 'b'.repeat(32), runs: [] }).trace;
  assert.deepEqual([empty.lead_time_ms, empty.waiting_ms, empty.first_started_at], [null, null, null]);
});

test('normalizeTrace rejects what is not a trace index', () => {
  assert.match(normalizeTrace('{').error, /not JSON/);
  assert.match(normalizeTrace({ schema_version: 2 }).error, /schema_version 1/);
  assert.match(normalizeTrace({ schema_version: 1, trace_id: '../x' }).error, /trace_id/);
  assert.match(normalizeTrace({ schema_version: 1, trace_id: 'a'.repeat(32), runs: {} }).error, /runs is not an array/);
});

test('parseRunsJsonl keeps object lines with a type and counts the rest', () => {
  assert.deepEqual(parseRunsJsonl('{"type":"pr"}\n\nnot json\n[1]\n{"x":1}\n'), { lines: [{ type: 'pr' }], bad: 3 });
  assert.deepEqual(parseRunsJsonl(undefined), { lines: [], bad: 0 });
});

test('buildPipelineModel keeps the newest months, skips malformed and duplicate records with a warning', () => {
  const months = Array.from({ length: MAX_MONTHS + 2 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  const records = months.map((m, i) => ({ path: `metrics/runs/${m}/${i + 1}-1.json`, text: JSON.stringify({ ...JSON.parse(V1_REVIEW()), run_id: `${i + 1}-1`, started_at: `${m}-02T00:00:00.000Z` }) }));
  records.push({ path: 'metrics/runs/2026-08/bad.json', text: '{oops' });
  records.push({ path: 'metrics/runs/2026-08/dup.json', text: records[7].text });
  records.push({ path: 'metrics/runs/not-a-month/x.json', text: records[7].text });
  const logs = [];
  const model = buildPipelineModel({ records, runsJsonl: '{"type":"pr"}\nbad\n', log: (m) => logs.push(m) });
  assert.deepEqual(model.months, months.slice(2).reverse());
  assert.deepEqual(model.skippedMonths, ['2026-02', '2026-01']);
  assert.equal(model.runs.length, MAX_MONTHS);
  assert.equal(model.runs[0].run_id, '8-1', 'newest first');
  assert.ok(model.warnings.some((w) => /bad\.json skipped: not a readable run record/.test(w)));
  assert.ok(model.warnings.some((w) => /dup\.json skipped: run 8-1 already loaded/.test(w)));
  assert.ok(model.warnings.some((w) => /1 unparseable line/.test(w)));
  assert.equal(logs.length, model.warnings.length);
  assert.equal(model.legacy.length, 1);
});

test('buildPipelineModel warns for an index naming a record it cannot load, and for a broken index', () => {
  const v2 = { path: 'metrics/runs/2026-10/38992537605-1.json', text: V2_REVIEW() };
  const model = buildPipelineModel({ records: [v2], traces: [{ path: 'metrics/traces/48c0763e8e6261b16939887b4abf414c.json', text: TRACE_PR_220() }, { path: 'metrics/traces/x.json', text: '[]' }] });
  assert.equal(model.traces.length, 1);
  assert.ok(model.warnings.some((w) => /run 38990364970-1 has no loadable record/.test(w)));
  assert.ok(model.warnings.some((w) => /x\.json skipped: not a trace index/.test(w)));
  assert.equal(model.tracesById.get('48c0763e8e6261b16939887b4abf414c').runs[2].run.run_id, '38992537605-1');
  assert.deepEqual(buildPipelineModel().runs, []);
});

test('eventSummary picks the decisive meta keys; feedEntries orders every event newest first', () => {
  assert.equal(eventSummary({ verdict: 'APPROVE', rules: ['a', 'b'], reason: '', prNumber: 3, error: null }), 'verdict=APPROVE · rules=a,b');
  assert.equal(eventSummary(undefined), '');
  const a = makeRecord({ runId: '200', start: Date.parse('2026-10-10T00:00:00Z'), events: [{ event: 'review.verdict', meta: { verdict: 'APPROVE', url: 'javascript:x' } }] });
  const b = makeRecord({ runId: '201', start: Date.parse('2026-10-11T00:00:00Z'), prNumber: null, item: { kind: 'issue', number: 5, source: 'issue_event' }, events: [{ event: 'issue_validation.comment_posted', meta: { issueNumber: 5, url: 'https://github.com/o/r/issues/5#c' } }] });
  const model = buildPipelineModel({ records: asFiles([a, b]), traces: indexesOf([a, b]) });
  const feed = feedEntries(model.runs);
  assert.deepEqual(feed.map((f) => f.event), ['issue_validation.comment_posted', 'review.verdict']);
  assert.deepEqual([feed[0].issue, feed[0].pr, feed[0].url], [5, null, 'https://github.com/o/r/issues/5#c']);
  assert.deepEqual([feed[1].pr, feed[1].url, feed[1].summary], [7, null, 'verdict=APPROVE']);
});

// LLM cost (llm_cost.mjs): measured usage, pipeline stage and list price per call and per run.
test('normalizeRun: a measured llm_call carries its cache split, pipeline stage and measured cost', () => {
  const rec = makeRecord({ runId: '900', provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1_000_000, tokensOut: 100_000, usage: { cacheRead: 800_000, cacheWrite: 0 } });
  const { run } = normalizeRun(JSON.stringify(rec), 'metrics/runs/2026-10/900-1.json');
  const [call] = run.llm;
  assert.deepEqual([call.estimated, call.cache_read, call.cache_write, call.stage, call.pipeline_stage, call.cost.basis], [false, 800_000, 0, 'review', 'review', 'measured']);
  assert.ok(Math.abs(call.cost.usd - (200_000 * 4 + 800_000 * 0.2 + 100_000 * 20) / 1e6) < 1e-9);
  assert.deepEqual(run.waterfall.find((s) => s.kind === 'llm').tokens, { in: 1_000_000, out: 100_000, estimated: false, cache_read: 800_000, cache_write: 0 });
  assert.equal(run.cost.calls, 1);
  assert.equal(run.cost.measured, 1);
  assert.equal(run.cost.usd, call.cost.usd);
});

test('normalizeRun: an estimated call, a record without the estimated flag and a v1 record price as estimates', () => {
  const est = normalizeRun(JSON.stringify(makeRecord({ runId: '901', provider: 'anthropic', model: 'claude-opus-5-5', stage: 'autofix' }))).run;
  assert.deepEqual([est.llm[0].cost.basis, est.llm[0].pipeline_stage, est.llm[0].cache_read], ['estimated', 'autofix', null]);
  const rec = makeRecord({ runId: '902', provider: 'anthropic', model: 'claude-opus-5-5' });
  const llm = rec.otlp.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name === 'llm_call');
  llm.attributes = llm.attributes.filter((a) => a.key !== 'adl.usage.estimated');
  assert.equal(normalizeRun(JSON.stringify(rec)).run.llm[0].estimated, true, 'no flag: never read as measured');
  const v1 = normalizeRun(V1_REVIEW(), 'metrics/runs/2026-10/38848221354-1.json').run;
  for (const c of v1.llm) assert.equal(c.cost.basis, c.provider === 'groq' ? 'free' : c.cost.basis);
  assert.ok(v1.llm.every((c) => c.stage === 'review' && c.pipeline_stage === 'review'), 'v1: stage from the envelope');
  assert.equal(v1.cost.calls, v1.llm.length);
});
