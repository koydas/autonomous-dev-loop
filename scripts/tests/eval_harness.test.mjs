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
  detectQuotaExhaustion,
  estimateRunTokens,
  checkTokenBudget,
} from '../lib/eval_harness.mjs';
import { partitionPublishable } from '../lib/eval_scorecard.mjs';

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

// ---------------------------------------------------------------------------
// Circuit breaker / token estimate
// ---------------------------------------------------------------------------

// Verbatim shape of Evals run 37719923057 (Groq TPD exhausted, Anthropic key invalid).
const TPD_ERROR = 'All providers failed: groq: Groq API HTTP error 429: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 198931, Requested 2984. Please try again in 13m47.28s. Need more tokens?","type":"tokens","code":"rate_limit_exceeded"}}, anthropic: Anthropic API HTTP error 401: {"error":{"message":"Invalid API Key"}}';

test('detectQuotaExhaustion parses a Groq TPD 429 with limit, usage and retry-after', () => {
  const q = detectQuotaExhaustion(new Error(TPD_ERROR));
  assert.deepEqual(
    { provider: q.provider, quota: q.quota, limit: q.limit, used: q.used, retry_after: q.retry_after },
    { provider: 'groq', quota: 'tokens per day (TPD)', limit: 200000, used: 198931, retry_after: '13m47.28s' },
  );
  assert.equal(q.message, TPD_ERROR);
});

test('detectQuotaExhaustion matches a daily quota from a bare message (replay) without limit or retry hint', () => {
  const q = detectQuotaExhaustion('quota on requests per day (RPD) reached');
  assert.deepEqual([q.provider, q.quota, q.limit, q.used, q.retry_after], ['unknown', 'requests per day (RPD)', null, null, null]);
});

test('detectQuotaExhaustion trips when every provider refused with 401/403/429', () => {
  const err = Object.assign(new Error('All providers failed: groq: ... Please try again in 2s, anthropic: ...'), {
    providerErrors: [{ provider: 'groq', status: 429 }, { provider: 'anthropic', status: 401 }],
  });
  const q = detectQuotaExhaustion(err);
  assert.equal(q.provider, 'groq+anthropic');
  assert.equal(q.quota, 'every provider refused (groq 429, anthropic 401)');
  assert.equal(q.retry_after, '2s');
});

test('detectQuotaExhaustion does not trip on a TPM 429, a 5xx, an unknown status or a parse error', () => {
  const tpm = 'Groq API HTTP error 429: Rate limit reached on tokens per minute (TPM). Please try again in 1.2s';
  assert.equal(detectQuotaExhaustion(new Error(tpm)), null);
  assert.equal(detectQuotaExhaustion(Object.assign(new Error('x'), { providerErrors: [{ provider: 'groq', status: 429 }, { provider: 'anthropic', status: 500 }] })), null);
  assert.equal(detectQuotaExhaustion(Object.assign(new Error('x'), { providerErrors: [{ provider: 'groq', status: null }] })), null);
  assert.equal(detectQuotaExhaustion(Object.assign(new Error('x'), { providerErrors: [] })), null);
  assert.equal(detectQuotaExhaustion(new Error('parse failed')), null);
  assert.equal(detectQuotaExhaustion(undefined), null);
});

// ADR-0032 shapes: primary=anthropic / fallback=groq, a fallback skipped without a call (llm_client.mjs).
const WORKSPACE_400 = 'anthropic: Anthropic API HTTP error 400: {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace"}}';

test('detectQuotaExhaustion never counts an Anthropic 400 (config error) as a quota, in either order', () => {
  const failed = (providerErrors, tail) => Object.assign(new Error(`All providers failed: ${WORKSPACE_400}, ${tail}`), { providerErrors });
  assert.equal(detectQuotaExhaustion(failed([{ provider: 'anthropic', status: 400 }, { provider: 'groq', status: 429 }],
    'groq: Groq API HTTP error 429: Rate limit reached on tokens per minute (TPM). Please try again in 1.2s')), null);
  assert.equal(detectQuotaExhaustion(failed([{ provider: 'anthropic', status: 400 }, { provider: 'groq', status: null, skipped: 'no_api_key' }],
    'groq: skipped (no API key configured)')), null);
  assert.equal(detectQuotaExhaustion(Object.assign(new Error('x'), {
    providerErrors: [{ provider: 'groq', status: 429 }, { provider: 'anthropic', status: 400 }],
  })), null);
});

test('detectQuotaExhaustion attributes a Groq TPD fallback behind an Anthropic 400 primary to groq', () => {
  const tpd = TPD_ERROR.slice(TPD_ERROR.indexOf('groq: '), TPD_ERROR.indexOf(', anthropic: '));
  const err = Object.assign(new Error(`All providers failed: ${WORKSPACE_400}, ${tpd}`), {
    providerErrors: [{ provider: 'anthropic', status: 400 }, { provider: 'groq', status: 429 }],
  });
  const q = detectQuotaExhaustion(err);
  assert.deepEqual([q.provider, q.quota, q.limit, q.retry_after], ['groq', 'tokens per day (TPD)', 200000, '13m47.28s']);
});

test('detectQuotaExhaustion ignores skipped providers: trips on the only provider called, never on none', () => {
  const q = detectQuotaExhaustion(Object.assign(new Error('All providers failed: groq: ... 401, anthropic: skipped (no API key configured)'), {
    providerErrors: [{ provider: 'groq', status: 401 }, { provider: 'anthropic', status: null, skipped: 'no_api_key' }],
  }));
  assert.equal(q.provider, 'groq');
  assert.equal(q.quota, 'every provider refused (groq 401)');
  assert.equal(detectQuotaExhaustion(Object.assign(new Error('x'), {
    providerErrors: [{ provider: 'groq', status: null, skipped: 'over_input_budget' }, { provider: 'anthropic', status: null, skipped: 'no_api_key' }],
  })), null);
});

const tpdSuite = (swallow = false) => ({
  ...echoSuite,
  async run(input, { llm }) {
    try {
      return { answer: await llm({ prompt: input.q, systemPrompt: 'sys' }) };
    } catch (err) {
      if (swallow) return { answer: 'fallback' };
      throw err;
    }
  },
});
const quotaAfter = (okCalls) => {
  let n = 0;
  return () => async ({ prompt }) => {
    if (n++ >= okCalls) throw new Error(TPD_ERROR);
    return prompt;
  };
};
const fiveCases = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, tags: [], input: { q: 'yes' }, expected: { answer: 'yes' } }));

test('runSuite opens the circuit on a quota error: no further call, the rest recorded as skipped', async () => {
  const llmFor = quotaAfter(1);
  let calls = 0;
  const results = await runSuite({ suite: tpdSuite(), cases: fiveCases, repeats: 2, llmFor: (k) => { const f = llmFor(k); return async (a) => { calls++; return f(a); }; } });
  assert.equal(results.length, 10);
  assert.equal(calls, 2, 'one success, one quota failure, then nothing');
  assert.equal(results[0].error, null);
  assert.equal(results[1].circuit_breaker.quota, 'tokens per day (TPD)');
  assert.ok(results.slice(2).every((r) => r.skipped && r.calls.length === 0 && /circuit breaker open \(groq tokens per day/.test(r.error)));

  const summary = summarize(results);
  assert.equal(summary.error_rate, 1);
  assert.deepEqual(summary.circuit_breaker, { provider: 'groq', quota: 'tokens per day (TPD)', limit: 200000, used: 198931, retry_after: '13m47.28s', skipped_runs: 8 });
  assert.equal(summary.latency_ms.p95, results[1].duration_ms >= results[0].duration_ms ? results[1].duration_ms : results[0].duration_ms);
  assert.deepEqual(checkThresholds(summary, { error_rate: { max: 0.05 } }).map((f) => f.metric), ['error_rate']);

  const report = formatReport({ suite: 'echo', summary, failures: [], results });
  assert.match(report, /## ⛔ Circuit breaker: provider quota exhausted/);
  assert.match(report, /limit 200000, used 198931\); retry after 13m47\.28s\. 8 run\(s\) skipped/);
});

test('runSuite trips the breaker even when the stage swallows the LLM error, and on the last job', async () => {
  const results = await runSuite({ suite: tpdSuite(true), cases: fiveCases.slice(0, 2), llmFor: quotaAfter(1) });
  assert.equal(results[1].error, TPD_ERROR);
  assert.equal(results.filter((r) => r.skipped).length, 0);
  assert.equal(summarize(results).error_rate, 1);
});

test('runSuite stops every worker once the circuit is open (concurrency > 1)', async () => {
  const results = await runSuite({ suite: tpdSuite(), cases: fiveCases, repeats: 2, concurrency: 2, llmFor: quotaAfter(0) });
  assert.equal(results.length, 10);
  assert.equal(results.filter((r) => r.circuit_breaker).length, 2);
  assert.equal(results.filter((r) => r.skipped).length, 8);
});

test('runSuite keeps going on errors that are not a quota (no circuit_breaker in the summary)', async () => {
  const results = await runSuite({ suite: tpdSuite(), cases: fiveCases, llmFor: () => async () => { throw new Error('Groq API HTTP error 500'); } });
  assert.equal(results.filter((r) => r.skipped).length, 0);
  const summary = summarize(results);
  assert.equal(summary.error_rate, 1);
  assert.equal('circuit_breaker' in summary, false);
  assert.doesNotMatch(formatReport({ suite: 'echo', summary, failures: [], results }), /Circuit breaker/);
});

test('formatReport shows an unknown retry-after and no usage when the provider gave none', () => {
  const summary = { ...summarize([]), circuit_breaker: { provider: 'groq+anthropic', quota: 'every provider refused', limit: null, used: null, retry_after: null, skipped_runs: 3 } };
  assert.match(formatReport({ suite: 's', summary, failures: [], results: [] }), /`groq\+anthropic` — every provider refused; retry after unknown\. 3 run\(s\) skipped/);
});

const histLine = (over) => ({ suite: 'validation', run_id: 'r', model: 'groq:m', summary: { n_runs: 10, error_rate: 0, tokens_est: { in: 20000, out: 5001 } }, ...over });

test('estimateRunTokens uses the newest error-free live run of the suite', () => {
  const history = [
    histLine({ run_id: 'old', summary: { n_runs: 1, error_rate: 0, tokens_est: { in: 1, out: 0 } } }),
    histLine({ run_id: 'good' }),
    histLine({ run_id: 'errored', summary: { n_runs: 10, error_rate: 0.1, tokens_est: { in: 1, out: 1 } } }),
    histLine({ run_id: 'replayed', model: 'replay:groq:m' }),
    histLine({ run_id: 'other', suite: 'review' }),
    null,
  ];
  assert.deepEqual(estimateRunTokens({ suite: { name: 'validation', tokensPerRunEst: 2000 }, nRuns: 4, history }), { tokens: 10004, per_run: 2501, source: 'history:good' });
});

test('estimateRunTokens falls back to the static estimate, then to unknown', () => {
  const noRun = [histLine({ summary: { n_runs: 0, error_rate: 0, tokens_est: { in: 0, out: 0 } } }), histLine({ run_id: undefined, model: undefined, summary: { n_runs: 1, error_rate: 0 } })];
  assert.deepEqual(estimateRunTokens({ suite: { name: 'validation', tokensPerRunEst: 2700 }, nRuns: 105, history: noRun }), { tokens: 283500, per_run: 2700, source: 'static' });
  assert.deepEqual(estimateRunTokens({ suite: { name: 'x' }, nRuns: 3 }), { tokens: null, per_run: null, source: 'unknown' });
  assert.deepEqual(estimateRunTokens({ suite: { name: 'x', tokensPerRunEst: 0 }, nRuns: 3 }).source, 'unknown');
  assert.equal(estimateRunTokens({ suite: { name: 'validation' }, nRuns: 2, history: [histLine({ run_id: undefined })] }).source, 'history:unknown');
});

test('checkTokenBudget: no budget, within budget, over budget, invalid budget, unknown estimate', () => {
  const est = { tokens: 283500, per_run: 2700, source: 'static' };
  assert.equal(checkTokenBudget(est, undefined), null);
  assert.equal(checkTokenBudget(est, '  '), null);
  assert.equal(checkTokenBudget(est, '283500'), null);
  assert.equal(checkTokenBudget(est, '150000'), 'estimated 283500 tokens (2700/run, static) exceeds EVAL_TOKEN_BUDGET=150000');
  assert.match(checkTokenBudget(est, '15k'), /EVAL_TOKEN_BUDGET must be a positive integer, got "15k"/);
  assert.match(checkTokenBudget(est, '0'), /must be a positive integer/);
  assert.match(checkTokenBudget({ tokens: null }, '1000'), /EVAL_TOKEN_BUDGET=1000 set but no token estimate/);
});

test('estimateRunTokens keeps the static estimate when the chars/4 history is lower (budget never undercounts)', () => {
  assert.deepEqual(estimateRunTokens({ suite: { name: 'validation', tokensPerRunEst: 2700 }, nRuns: 4, history: [histLine({ run_id: 'good' })] }), { tokens: 10800, per_run: 2700, source: 'static' });
  assert.equal(estimateRunTokens({ suite: { name: 'validation', tokensPerRunEst: 2501 }, nRuns: 1, history: [histLine({ run_id: 'good' })] }).source, 'static', 'a tie keeps the static estimate');
});

test('detectQuotaExhaustion reads millisecond and hour retry hints without mistaking ms for minutes', () => {
  const refused = (hint) => detectQuotaExhaustion(Object.assign(new Error(`groq: Groq API HTTP error 429: Please try again in ${hint}. , anthropic: 401`), {
    providerErrors: [{ provider: 'groq', status: 429 }, { provider: 'anthropic', status: 401 }],
  })).retry_after;
  assert.equal(refused('520ms'), '520ms');
  assert.equal(refused('1.5ms'), '1.5ms');
  assert.equal(refused('1h2m3s'), '1h2m3s');
  assert.equal(refused('7m'), '7m');
  assert.equal(refused('later'), null);
});

// ---------------------------------------------------------------------------
// Pinned live evals (ADR-0032 amendment): provider evidence and breaker on a disabled fallback
// ---------------------------------------------------------------------------

test('createRecordingLLM records the provider and model of a structured answer', async () => {
  const rec = createRecordingLLM(async () => ({ text: 'out', provider: 'groq', model: 'm' }), { now: fixedClock() });
  assert.deepEqual(await rec({}), { raw: 'out', latency_ms: 10, provider: 'groq', model: 'm' });
});

test('createRecordingLLM records no provider for a structured answer without one, and a null model when absent', async () => {
  const bare = createRecordingLLM(async () => ({ text: 'out' }), { now: fixedClock() });
  assert.deepEqual(await bare({}), { raw: 'out', latency_ms: 10 });
  const noModel = createRecordingLLM(async () => ({ text: 'out', provider: 'groq' }), { now: fixedClock() });
  assert.deepEqual(await noModel({}), { raw: 'out', latency_ms: 10, provider: 'groq', model: null });
  const nil = createRecordingLLM(async () => null, { now: fixedClock() });
  assert.deepEqual(await nil({}), { raw: null, latency_ms: 10 });
});

test('runSuite records calls[].provider and calls[].model; the suite still sees the raw text', async () => {
  const cases = [{ id: 'a', tags: [], input: { q: 'q' }, expected: { answer: 'yes' } }];
  const [r] = await runSuite({ suite: echoSuite, cases, llmFor: () => async () => ({ text: 'yes', provider: 'groq', model: 'm' }), now: fixedClock() });
  assert.equal(r.output.answer, 'yes');
  assert.equal(r.calls[0].provider, 'groq');
  assert.equal(r.calls[0].model, 'm');
  const [legacy] = await runSuite({ suite: echoSuite, cases, llmFor: () => async () => 'yes', now: fixedClock() });
  assert.ok(!('provider' in legacy.calls[0]));
});

test('createReplayLLM serves a recorded provider back, and a bare raw without one', async () => {
  const llmFor = createReplayLLM([{ case_id: 'a', repeat: 0, calls: [{ raw: 'one', provider: 'groq', model: 'm' }, { raw: 'two' }, { raw: 'three', provider: 'groq' }] }]);
  const llm = llmFor('a#0');
  assert.deepEqual(await llm(), { text: 'one', provider: 'groq', model: 'm' });
  assert.equal(await llm(), 'two');
  assert.deepEqual(await llm(), { text: 'three', provider: 'groq', model: null });
});

// Shape of a pinned live eval call (callLLM fallback: false) after a Groq TPD 429.
const pinnedError = (message, status) => Object.assign(new Error(message), {
  providerErrors: [{ provider: 'groq', status }, { provider: 'anthropic', status: null, skipped: 'disabled' }],
});

test('detectQuotaExhaustion trips on a Groq TPD 429 when the fallback is disabled (pinned eval)', () => {
  const q = detectQuotaExhaustion(pinnedError('All providers failed: groq: Groq API HTTP error 429: on tokens per day (TPD): Limit 200000, Used 199500. Please try again in 5m0s., anthropic: skipped (fallback disabled)', 429));
  assert.equal(q.provider, 'groq');
  assert.equal(q.quota, 'tokens per day (TPD)');
  assert.equal(q.limit, 200000);
});

test('detectQuotaExhaustion trips on a non-daily 429 from the only provider called (fallback disabled)', () => {
  const q = detectQuotaExhaustion(pinnedError('All providers failed: groq: HTTP 429 rate limited, anthropic: skipped (fallback disabled)', 429));
  assert.equal(q.provider, 'groq');
  assert.match(q.quota, /every provider refused \(groq 429\)/);
});

test('detectQuotaExhaustion does not trip on a 5xx or a skipped-only error when the fallback is disabled', () => {
  assert.equal(detectQuotaExhaustion(pinnedError('All providers failed: groq: 503, anthropic: skipped (fallback disabled)', 503)), null);
  const skippedOnly = Object.assign(new Error('All providers failed'), {
    providerErrors: [{ provider: 'groq', status: null, skipped: 'over_input_budget' }, { provider: 'anthropic', status: null, skipped: 'disabled' }],
  });
  assert.equal(detectQuotaExhaustion(skippedOnly), null);
});

test('runSuite trips the circuit breaker on a pinned TPD 429 and records the run as an error', async () => {
  const cases = ['a', 'b', 'c'].map((id) => ({ id, tags: [], input: { q: id }, expected: { answer: 'yes' } }));
  let calls = 0;
  const llmFor = () => async () => {
    calls++;
    throw pinnedError('All providers failed: groq: 429 tokens per day (TPD): Limit 200000, Used 200000, anthropic: skipped (fallback disabled)', 429);
  };
  const results = await runSuite({ suite: echoSuite, cases, llmFor, now: fixedClock() });
  assert.equal(calls, 1);
  assert.ok(results[0].error);
  assert.deepEqual(results.slice(1).map((r) => r.skipped), [true, true]);
  const summary = summarize(results);
  assert.equal(summary.error_rate, 1);
  assert.equal(summary.circuit_breaker.provider, 'groq');
});

// ---------------------------------------------------------------------------
// Swallowed LLM errors — the stage returns a fallback output, the harness still errors the run
// ---------------------------------------------------------------------------

const swallowingSuite = {
  ...echoSuite,
  async run(input, { llm }) {
    try {
      return { answer: await llm({ prompt: input.q, systemPrompt: 'sys' }) };
    } catch {
      return { answer: 'yes' }; // fallback output that would score as a correct answer
    }
  },
};
const yesCase = (id) => ({ id, tags: [], input: { q: 'yes' }, expected: { answer: 'yes' } });

test('runSuite errors a run whose stage swallowed a non-quota LLM error; the gate fails and the run is not published', async () => {
  const llmFor = (key) => async ({ prompt }) => {
    if (key === 'b#0') throw new Error('Groq API HTTP error 500');
    return prompt;
  };
  const results = await runSuite({ suite: swallowingSuite, cases: [yesCase('a'), yesCase('b')], llmFor, now: fixedClock() });
  assert.equal(results[0].error, null);
  const b = results[1];
  assert.equal(b.error, 'Groq API HTTP error 500');
  assert.deepEqual(b.output, { answer: 'yes' }, 'the fallback output is kept for diagnosis');
  assert.equal(b.label, null);
  assert.deepEqual(b.scores, { exact: 0, only_yes: 0 }, 'the fallback is not scored as a model answer');
  assert.equal('circuit_breaker' in b, false);
  assert.deepEqual(b.calls, [{ raw: null, error: 'Groq API HTTP error 500', latency_ms: null, tokens_in_est: b.calls[0].tokens_in_est, tokens_out_est: 0 }]);
  assert.ok(b.calls[0].tokens_in_est > 0);

  const summary = summarize(results);
  assert.equal(summary.error_rate, 0.5);
  assert.equal('circuit_breaker' in summary, false);
  assert.equal(summary.llm_calls, 1, 'a failed call is not an answered call');
  assert.equal(summary.tokens_est.in, results[0].calls[0].tokens_in_est);
  const failures = checkThresholds(summary, { error_rate: { max: 0.05 } });
  assert.deepEqual(failures.map((f) => f.metric), ['error_rate']);
  const { publishable, skipped } = partitionPublishable([{ meta: { run_id: 'r1', model: 'groq:m' }, summary, failures, results }]);
  assert.equal(publishable.length, 0);
  assert.match(skipped[0].reason, /error_rate 0\.5 above threshold/);
  assert.match(formatReport({ suite: 'echo', summary, failures, results }), /\| b \| 0 \| yes \|  \| Groq API HTTP error 500 \|/);
});

test('a replay reproduces a swallowed LLM error from the recorded failed call', async () => {
  const live = await runSuite({ suite: swallowingSuite, cases: [yesCase('a'), yesCase('b')], llmFor: (key) => async ({ prompt }) => {
    if (key === 'b#0') throw new Error('Anthropic API HTTP error 529');
    return prompt;
  } });
  const replayed = await runSuite({ suite: swallowingSuite, cases: [yesCase('a'), yesCase('b')], llmFor: createReplayLLM(live) });
  assert.deepEqual(replayed.map((r) => [r.error, r.scores, r.calls.map((c) => c.error ?? c.raw)]), live.map((r) => [r.error, r.scores, r.calls.map((c) => c.error ?? c.raw)]));
  assert.equal(summarize(replayed).error_rate, 0.5);
});

test('runSuite errors a run whose stage retried after a swallowed LLM error, and replays the calls in order', async () => {
  const retryingSuite = {
    ...echoSuite,
    async run(input, { llm }) {
      try {
        return { answer: await llm({ prompt: input.q }) };
      } catch {
        return { answer: await llm({ prompt: input.q }) };
      }
    },
  };
  let n = 0;
  const live = await runSuite({ suite: retryingSuite, cases: [yesCase('a')], llmFor: () => async ({ prompt }) => {
    if (n++ === 0) throw new Error('socket hang up');
    return prompt;
  } });
  assert.equal(live[0].error, 'socket hang up', 'the answer is not the model output the stage would have given on one call');
  assert.deepEqual(live[0].calls.map((c) => c.error ?? c.raw), ['socket hang up', 'yes']);
  assert.equal(summarize(live).llm_calls, 1);
  const replayed = await runSuite({ suite: retryingSuite, cases: [yesCase('a')], llmFor: createReplayLLM(live) });
  assert.equal(replayed[0].error, 'socket hang up');
  assert.deepEqual(replayed[0].calls.map((c) => c.error ?? c.raw), ['socket hang up', 'yes']);
});

test('createReplayLLM throws a recorded failed call in its place, then serves the next call', async () => {
  const llm = createReplayLLM([{ case_id: 'a', repeat: 0, calls: [{ raw: null, error: 'boom 500' }, { raw: 'ok' }], error: 'boom 500' }])('a#0');
  await assert.rejects(llm(), /^Error: boom 500$/);
  assert.equal(await llm(), 'ok');
  await assert.rejects(llm(), /^Error: boom 500$/);
});

test('a swallowed quota error still trips the breaker, live and on replay', async () => {
  const live = await runSuite({ suite: swallowingSuite, cases: [yesCase('a'), yesCase('b'), yesCase('c')], llmFor: quotaAfter(1) });
  assert.equal(live[1].error, TPD_ERROR);
  assert.equal(live[1].circuit_breaker.quota, 'tokens per day (TPD)');
  assert.deepEqual(live[1].calls.map((c) => c.error), [TPD_ERROR]);
  assert.equal(live[2].skipped, true);
  assert.equal(summarize(live).error_rate, 1);

  const replayed = await runSuite({ suite: swallowingSuite, cases: [yesCase('a'), yesCase('b'), yesCase('c')], llmFor: createReplayLLM(live) });
  assert.equal(replayed[1].error, TPD_ERROR);
  assert.equal(replayed[1].circuit_breaker.quota, 'tokens per day (TPD)');
  assert.equal(replayed[2].skipped, true);
});

test('runSuite leaves a run without an LLM error unchanged: no error, answered calls only, scorers see them', async () => {
  const seen = [];
  const suite = { ...swallowingSuite, scorers: { ...echoSuite.scorers, calls_seen: (e, o, { calls }) => { seen.push(calls.length); return null; } } };
  const results = await runSuite({ suite, cases: [yesCase('a')], llmFor: () => async ({ prompt }) => prompt, now: fixedClock() });
  assert.equal(results[0].error, null);
  assert.equal(results[0].label, 'yes');
  assert.deepEqual(results[0].scores, { exact: 1, only_yes: 1, calls_seen: null });
  assert.deepEqual(Object.keys(results[0].calls[0]).sort(), ['latency_ms', 'raw', 'tokens_in_est', 'tokens_out_est']);
  assert.deepEqual(seen, [1]);
  const summary = summarize(results);
  assert.equal(summary.error_rate, 0);
  assert.equal(summary.llm_calls, 1);
});

test('scorers see answered calls only: a failed call does not make the LLM count as consulted', async () => {
  const seen = [];
  const suite = { ...echoSuite, scorers: { calls_seen: (e, o, { calls }) => { seen.push(calls.length); return null; } } };
  await runSuite({ suite, cases: [yesCase('a')], llmFor: () => async () => { throw new Error('Groq API HTTP error 500'); } });
  assert.deepEqual(seen, [0]);
});

test('a swallowed LLM error with an empty message still errors the run, and replays as an error', async () => {
  const live = await runSuite({ suite: swallowingSuite, cases: [yesCase('a')], llmFor: () => async () => { throw new Error(''); } });
  assert.equal(live[0].error, 'LLM call failed');
  assert.deepEqual(live[0].scores, { exact: 0, only_yes: 0 });
  assert.equal(live[0].calls[0].error, 'LLM call failed');
  assert.equal(summarize(live).error_rate, 1);
  const replayed = await runSuite({ suite: swallowingSuite, cases: [yesCase('a')], llmFor: createReplayLLM(live) });
  assert.equal(replayed[0].error, 'LLM call failed');
  assert.equal(summarize(replayed).llm_calls, 0, 'the failed call is not served as an answer');
});

test('a quota error followed by a non-quota error in the same run keeps circuit_breaker and the quota message', async () => {
  const retryAll = {
    ...echoSuite,
    async run(input, { llm }) {
      for (let i = 0; i < 2; i++) {
        try { return { answer: await llm({ prompt: input.q }) }; } catch { /* swallowed, retried */ }
      }
      return { answer: 'yes' };
    },
  };
  let n = 0;
  const results = await runSuite({ suite: retryAll, cases: [yesCase('a'), yesCase('b')], llmFor: () => async () => {
    throw new Error(n++ === 0 ? TPD_ERROR : 'Groq API HTTP error 500');
  } });
  assert.equal(results[0].error, TPD_ERROR);
  assert.equal(results[0].circuit_breaker.quota, 'tokens per day (TPD)');
  assert.deepEqual(results[0].calls.map((c) => c.error), [TPD_ERROR, 'Groq API HTTP error 500']);
  assert.equal(results[1].skipped, true);
  const summary = summarize(results);
  assert.equal(summary.circuit_breaker.quota, 'tokens per day (TPD)');
  assert.match(formatReport({ suite: 'echo', summary, failures: checkThresholds(summary), results }), /## ⛔ Circuit breaker/);
});
