import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseDataset,
  loadDataset,
  filterCases,
  createRecordingLLM,
  createReplayLLM,
  runSuite,
  percentile,
  computeConfusion,
  perClassMetrics,
  computeConsistency,
  summarize,
  checkThresholds,
  formatReport,
} from '../lib/eval_harness.mjs';

// Minimal suite: the LLM returns "yes"/"no", label is that answer.
const echoSuite = {
  name: 'echo',
  async run(input, { llm }) {
    const raw = await llm({ prompt: input.q, systemPrompt: 'sys' });
    if (raw === 'boom') throw new Error('parse failed');
    return { answer: raw };
  },
  scorers: {
    exact: (expected, output) => output?.answer === expected.answer,
    only_yes: (expected, output) => (expected.answer === 'yes' ? output?.answer === 'yes' : null),
  },
  label: (output) => output.answer,
  expectedLabel: (expected) => expected.answer,
};

const fixedClock = () => {
  let t = 0;
  return () => (t += 10);
};

// ---------------------------------------------------------------------------
// parseDataset / loadDataset / filterCases
// ---------------------------------------------------------------------------

test('parseDataset parses JSONL, skips blanks and // comments, defaults tags', () => {
  const cases = parseDataset('// header\n\n{"id":"a","input":{},"expected":{}}\n{"id":"b","tags":["x"],"input":1,"expected":2}\n');
  assert.equal(cases.length, 2);
  assert.deepEqual(cases[0].tags, []);
  assert.deepEqual(cases[1].tags, ['x']);
});

test('parseDataset rejects invalid JSON with the line number', () => {
  assert.throws(() => parseDataset('{"id":"a"', 'ds.jsonl'), /ds\.jsonl:1: invalid JSON/);
});

test('parseDataset rejects missing id, input, expected and duplicate ids', () => {
  assert.throws(() => parseDataset('{"input":1,"expected":1}'), /missing string "id"/);
  assert.throws(() => parseDataset('{"id":"a","expected":1}'), /missing "input"/);
  assert.throws(() => parseDataset('{"id":"a","input":1}'), /missing "expected"/);
  assert.throws(
    () => parseDataset('{"id":"a","input":1,"expected":1}\n{"id":"a","input":1,"expected":1}'),
    /duplicate id "a"/,
  );
});

test('parseDataset rejects an empty dataset', () => {
  assert.throws(() => parseDataset('// only a comment\n', 'empty.jsonl'), /empty\.jsonl: no cases/);
});

test('loadDataset reads a file from disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-'));
  const file = path.join(dir, 'd.jsonl');
  await fs.writeFile(file, '{"id":"a","input":1,"expected":1}\n');
  assert.equal((await loadDataset(file))[0].id, 'a');
});

test('filterCases filters by any matching tag and applies limit', () => {
  const cases = parseDataset([
    '{"id":"a","tags":["x"],"input":1,"expected":1}',
    '{"id":"b","tags":["y"],"input":1,"expected":1}',
    '{"id":"c","tags":["x","y"],"input":1,"expected":1}',
  ].join('\n'));
  assert.deepEqual(filterCases(cases, { tags: ['x'] }).map((c) => c.id), ['a', 'c']);
  assert.deepEqual(filterCases(cases, { limit: 2 }).map((c) => c.id), ['a', 'b']);
  assert.equal(filterCases(cases).length, 3);
});

// ---------------------------------------------------------------------------
// LLM wrappers
// ---------------------------------------------------------------------------

test('createRecordingLLM returns raw response and latency', async () => {
  const rec = createRecordingLLM(async () => 'out', { now: fixedClock() });
  assert.deepEqual(await rec({ prompt: 'p' }), { raw: 'out', latency_ms: 10 });
});

test('createReplayLLM serves recorded calls in order per case/repeat', async () => {
  const llmFor = createReplayLLM([{ case_id: 'a', repeat: 0, calls: [{ raw: 'one' }, { raw: 'two' }] }]);
  const llm = llmFor('a#0');
  assert.equal(await llm(), 'one');
  assert.equal(await llm(), 'two');
  await assert.rejects(llm(), /no recorded call left for a#0/);
  await assert.rejects(llmFor('missing#0')(), /no recorded call left for missing#0/);
});

// ---------------------------------------------------------------------------
// runSuite
// ---------------------------------------------------------------------------

test('runSuite scores each case, records calls and labels', async () => {
  const cases = parseDataset([
    '{"id":"a","input":{"q":"yes"},"expected":{"answer":"yes"}}',
    '{"id":"b","input":{"q":"no"},"expected":{"answer":"yes"}}',
  ].join('\n'));
  const results = await runSuite({ suite: echoSuite, cases, llmFor: () => async ({ prompt }) => prompt, now: fixedClock() });
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].scores, { exact: 1, only_yes: 1 });
  assert.deepEqual(results[1].scores, { exact: 0, only_yes: 0 });
  assert.equal(results[1].label, 'no');
  assert.equal(results[1].expected_label, 'yes');
  assert.equal(results[0].calls.length, 1);
  assert.equal(results[0].calls[0].raw, 'yes');
  assert.ok(results[0].calls[0].tokens_in_est > 0);
});

test('runSuite turns a thrown run into an error scored 0 on applicable scorers', async () => {
  const cases = parseDataset('{"id":"a","input":{"q":"boom"},"expected":{"answer":"no"}}');
  const [r] = await runSuite({ suite: echoSuite, cases, llmFor: () => async ({ prompt }) => prompt });
  assert.equal(r.error, 'parse failed');
  assert.equal(r.output, null);
  assert.equal(r.label, null);
  assert.deepEqual(r.scores, { exact: 0, only_yes: null });
  assert.equal(r.calls.length, 1, 'the raw response is kept for replay even when parsing fails');
});

test('runSuite runs repeats, keeps job order with concurrency and calls onResult', async () => {
  const cases = parseDataset('{"id":"a","input":{"q":"yes"},"expected":{"answer":"yes"}}\n{"id":"b","input":{"q":"no"},"expected":{"answer":"no"}}');
  const seen = [];
  const results = await runSuite({
    suite: echoSuite, cases, repeats: 3, concurrency: 4,
    llmFor: () => async ({ prompt }) => prompt,
    onResult: (r) => seen.push(r.case_id),
  });
  assert.deepEqual(results.map((r) => `${r.case_id}#${r.repeat}`), ['a#0', 'a#1', 'a#2', 'b#0', 'b#1', 'b#2']);
  assert.equal(seen.length, 6);
});

test('runSuite passes the case/repeat key to llmFor', async () => {
  const keys = [];
  const cases = parseDataset('{"id":"a","input":{"q":"yes"},"expected":{"answer":"yes"}}');
  await runSuite({ suite: echoSuite, cases, repeats: 2, llmFor: (key) => { keys.push(key); return async () => 'yes'; } });
  assert.deepEqual(keys, ['a#0', 'a#1']);
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

test('percentile uses nearest-rank and handles empty input', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 95), 10);
});

test('computeConfusion counts errors and missing labels separately', () => {
  const confusion = computeConfusion([
    { expected_label: 'yes', label: 'yes', error: null },
    { expected_label: 'yes', label: null, error: 'x' },
    { expected_label: 'no', label: null, error: null },
    { expected_label: null, label: 'yes', error: null },
  ]);
  assert.deepEqual(confusion, { yes: { yes: 1, __error__: 1 }, no: { __none__: 1 } });
});

test('perClassMetrics computes precision, recall, F1 and support', () => {
  const m = perClassMetrics({ yes: { yes: 3, no: 1 }, no: { no: 4, yes: 2 } });
  assert.deepEqual(m.yes, { precision: 0.6, recall: 0.75, f1: 0.6667, support: 4 });
  assert.deepEqual(m.no, { precision: 0.8, recall: 0.6667, f1: 0.7273, support: 6 });
});

test('perClassMetrics returns null metrics when a class is never predicted', () => {
  const m = perClassMetrics({ yes: { no: 2 }, no: { no: 1 } });
  assert.deepEqual(m.yes, { precision: null, recall: 0, f1: null, support: 2 });
});

test('computeConsistency is null without repeats and counts stable cases otherwise', () => {
  assert.equal(computeConsistency([{ case_id: 'a', label: 'x' }]), null);
  assert.equal(computeConsistency([
    { case_id: 'a', label: 'x' }, { case_id: 'a', label: 'x' },
    { case_id: 'b', label: 'x' }, { case_id: 'b', label: 'y' },
    { case_id: 'c', label: 'x' }, { case_id: 'c', label: null, error: 'boom' },
  ]), 0.3333);
});

test('summarize aggregates scores (ignoring null), errors, latency and tokens', async () => {
  const cases = parseDataset([
    '{"id":"a","input":{"q":"yes"},"expected":{"answer":"yes"}}',
    '{"id":"b","input":{"q":"no"},"expected":{"answer":"no"}}',
    '{"id":"c","input":{"q":"boom"},"expected":{"answer":"no"}}',
  ].join('\n'));
  const results = await runSuite({ suite: echoSuite, cases, llmFor: () => async ({ prompt }) => prompt, now: fixedClock() });
  const s = summarize(results);
  assert.equal(s.n_cases, 3);
  assert.equal(s.n_runs, 3);
  assert.equal(s.error_rate, 0.3333);
  assert.deepEqual(s.scores.exact, { mean: 0.6667, n: 3 });
  assert.deepEqual(s.scores.only_yes, { mean: 1, n: 1 });
  assert.equal(s.consistency, null);
  assert.equal(s.per_class.no.recall, 0.5);
  assert.equal(s.llm_calls, 3);
  assert.ok(s.tokens_est.in > 0 && s.tokens_est.out > 0);
  assert.ok(s.latency_ms.p50 > 0);
});

test('summarize handles an empty result set', () => {
  const s = summarize([]);
  assert.equal(s.error_rate, 0);
  assert.deepEqual(s.latency_ms, { p50: null, p95: null });
});

test('checkThresholds reports min, max and missing metrics', () => {
  const summary = { error_rate: 0.2, scores: { exact: { mean: 0.5 } } };
  const failures = checkThresholds(summary, {
    'scores.exact.mean': { min: 0.8 },
    error_rate: { max: 0.1 },
    'per_class.no.recall': { min: 0.5 },
  });
  assert.deepEqual(failures.map((f) => f.metric), ['scores.exact.mean', 'error_rate', 'per_class.no.recall']);
  assert.match(failures[0].reason, /0\.5 < min 0\.8/);
  assert.match(failures[1].reason, /0\.2 > max 0\.1/);
  assert.equal(failures[2].reason, 'metric not available');
});

test('checkThresholds passes when every threshold is met and with no thresholds', () => {
  assert.deepEqual(checkThresholds({ error_rate: 0 }, { error_rate: { max: 0.05 } }), []);
  assert.deepEqual(checkThresholds({ error_rate: 0 }), []);
});

test('checkThresholds skips an optional metric the run did not measure, and enforces it once measured', () => {
  const thresholds = { consistency: { min: 0.9, optional: true } };
  assert.deepEqual(checkThresholds({ consistency: null }, thresholds), []);
  assert.deepEqual(checkThresholds({}, thresholds), []);
  assert.deepEqual(checkThresholds({ consistency: 0.95 }, thresholds), []);
  const failures = checkThresholds({ consistency: 0.8 }, thresholds);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /0\.8 < min 0\.9/);
});

test('formatReport lists metrics, threshold failures and failing cases', async () => {
  const cases = parseDataset('{"id":"a","input":{"q":"no"},"expected":{"answer":"yes"}}\n{"id":"b","input":{"q":"boom"},"expected":{"answer":"no"}}');
  const results = await runSuite({ suite: echoSuite, cases, repeats: 2, llmFor: () => async ({ prompt }) => prompt });
  const summary = summarize(results);
  const failures = checkThresholds(summary, { error_rate: { max: 0 } });
  const report = formatReport({ suite: 'echo', summary, failures, results, meta: { model: 'm' } });
  assert.match(report, /# Eval report — `echo`/);
  assert.match(report, /\*\*model\*\*: `m`/);
  assert.match(report, /\| scores\.exact \| 0 \(n=4\) \|/);
  assert.match(report, /\| consistency \| 1 \|/);
  assert.match(report, /## ❌ Threshold failures/);
  assert.match(report, /\| a \| 0 \| yes \| no \|  \|/);
  assert.match(report, /\| b \| 1 \| no \|  \| parse failed \|/);
});

test('formatReport says all thresholds met when there are no failures', () => {
  const report = formatReport({ suite: 'echo', summary: summarize([]), failures: [], results: [] });
  assert.match(report, /## ✅ All thresholds met/);
  assert.doesNotMatch(report, /Failing cases/);
});

test('createReplayLLM rethrows the recorded error once the recorded calls are exhausted', async () => {
  const llmFor = createReplayLLM([
    { case_id: 'a', repeat: 0, calls: [], error: 'Groq API error 429' },
    { case_id: 'b', repeat: 0, calls: [{ raw: 'x' }], error: 'Response missing "valid" boolean' },
  ]);
  await assert.rejects(llmFor('a#0')(), /^Error: Groq API error 429$/);
  const b = llmFor('b#0');
  assert.equal(await b(), 'x');
  await assert.rejects(b(), /Response missing "valid" boolean/);
});
