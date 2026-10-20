import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHealth, modelUsage, percentile, evalProvider, GROQ_TPD, TOKEN_DAYS, EVAL_CRONS, TOKEN_SERIES } from '../lib/pipeline_health.mjs';
import { buildPipelineModel } from '../lib/pipeline_model.mjs';
import { makeRecord, asFiles, indexesOf } from './fixtures/pipeline/records.mjs';

const T0 = Date.parse('2026-10-14T10:00:00Z'); // a Wednesday: review cron day
const model = (records, runsJsonl = '') => buildPipelineModel({ records: asFiles(records), traces: indexesOf(records), runsJsonl });
const verdict = (v, extra = {}) => ({ event: 'review.verdict', meta: { prNumber: 7, verdict: v, evidence_state: 'available', unreviewed_code_files: 0, ...extra } });

test('percentile is nearest-rank; empty → null', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([null, NaN], 50), null);
});

test('evalProvider infers the provider of a scorecard model', () => {
  assert.equal(evalProvider('claude-opus-5-5'), 'anthropic');
  assert.equal(evalProvider('openai/gpt-oss-120b'), 'groq');
  assert.equal(evalProvider(undefined), 'groq');
});

test('funnel: issue items through validation, PR and approval; merge is not recorded', () => {
  const issue = { kind: 'issue', number: 12, source: 'branch' };
  const records = [
    makeRecord({ runId: '1', workflow: 'Issue Validation Agent', stage: 'issue_validation', prNumber: null, issueNumber: 12, item: issue, start: T0, events: [{ event: 'issue_validation.pass', meta: { issueNumber: 12 } }] }),
    makeRecord({ runId: '2', workflow: 'Code Generation', stage: 'code_gen', prNumber: null, issueNumber: 12, item: issue, start: T0 + 60000, events: [{ event: 'workflow.pr_operation', meta: { operation: 'created' } }] }),
    makeRecord({ runId: '3', prNumber: 30, item: issue, start: T0 + 120000, events: [verdict('APPROVE', { prNumber: 30 })] }),
    makeRecord({ runId: '4', workflow: 'Issue Validation Agent', stage: 'issue_validation', prNumber: null, issueNumber: 13, item: { kind: 'issue', number: 13, source: 'issue_event' }, start: T0, events: [{ event: 'issue_validation.pass' }] }),
    makeRecord({ runId: '5', prNumber: 40, start: T0, events: [verdict('APPROVE', { prNumber: 40 })] }),
    makeRecord({ runId: '6', prNumber: 41, start: T0, events: [verdict('REQUEST_CHANGES', { prNumber: 41 })] }),
  ];
  const { funnel } = computeHealth({ model: model(records) });
  assert.deepEqual(funnel.stages.map((s) => s.count), [2, 1, 1, null]);
  assert.equal(funnel.issue_items, 2);
  assert.deepEqual(funnel.pr_items, { total: 2, approved: 1 });
});

test('reviews: WITHHELD rate, every cause, the #220 backstop, cut diffs and cycles per PR', () => {
  const cut = { event: 'review.prompt_truncated', level: 'warn', meta: { diff_truncated: true } };
  const records = [
    makeRecord({ runId: '10', start: T0, events: [cut, verdict('WITHHELD', { withheld_from: 'APPROVE', unreviewed_code_files: 2 })] }),
    makeRecord({ runId: '11', start: T0 + 1, events: [cut, verdict('WITHHELD', { withheld_from: 'REQUEST_CHANGES', unreviewed_code_files: 1 })] }),
    makeRecord({ runId: '12', start: T0 + 2, events: [cut, verdict('WITHHELD', { unreviewed_code_files: 3 })] }),
    makeRecord({ runId: '13', start: T0 + 3, events: [verdict('WITHHELD', { evidence_state: 'missing' })] }),
    makeRecord({ runId: '14', start: T0 + 4, events: [verdict('WITHHELD', { evidence_state: 'stale' })] }),
    makeRecord({ runId: '15', start: T0 + 5, events: [verdict('WITHHELD')] }),
    makeRecord({ runId: '16', start: T0 + 6, prNumber: 8, events: [cut, verdict('APPROVE', { prNumber: 8 })] }),
    makeRecord({ runId: '17', start: T0 + 7, prNumber: 8, events: [verdict('BOGUS', { prNumber: 'x' })] }),
  ];
  const { reviews } = computeHealth({ model: model(records) });
  assert.deepEqual(reviews.verdicts, { APPROVE: 1, REQUEST_CHANGES: 0, WITHHELD: 6, other: 1 });
  assert.equal(reviews.total, 8);
  assert.equal(reviews.withheld_rate, 6 / 8);
  assert.deepEqual(Object.fromEntries(reviews.causes.map((c) => [c.key, c.count])), { approve_cut: 1, rc_unseen: 1, cut_unknown: 1, evidence_missing: 1, evidence_stale: 1, other: 1 });
  assert.equal(reviews.rc_to_withheld, 1);
  assert.deepEqual(reviews.diff_cut, { reviews: 4, withheld: 3 });
  assert.deepEqual(reviews.cycles_per_pr, [{ pr: 8, cycles: 2 }, { pr: 7, cycles: 6 }]);
  assert.deepEqual(reviews.cycles_distribution, [{ cycles: 2, prs: 1 }, { cycles: 6, prs: 1 }]);
  assert.equal(computeHealth({ model: model([]) }).reviews.withheld_rate, null);
});

test('reviews: a present withheld_from: null on a cut diff is an evidence cause, not a pre-key record', () => {
  const records = [
    makeRecord({ runId: '18', start: T0, events: [verdict('WITHHELD', { evidence_state: 'missing', unreviewed_code_files: 3, withheld_from: null })] }),
    makeRecord({ runId: '19', start: T0 + 1, events: [verdict('WITHHELD', { evidence_state: 'stale', unreviewed_code_files: 1, withheld_from: null })] }),
    makeRecord({ runId: '20', start: T0 + 2, events: [verdict('WITHHELD', { evidence_state: 'available', unreviewed_code_files: 2, withheld_from: null })] }),
  ];
  const causes = Object.fromEntries(computeHealth({ model: model(records) }).reviews.causes.map((c) => [c.key, c.count]));
  assert.deepEqual(causes, { approve_cut: 0, rc_unseen: 0, cut_unknown: 0, evidence_missing: 1, evidence_stale: 1, other: 1 });
});

test('auto-fix outcomes by kind and guardrail rule; legacy lines count only without a record', () => {
  const af = (runId, events) => makeRecord({ runId, workflow: 'Auto-Fix PR', stage: 'autofix', start: T0, events });
  const records = [
    af('20', [{ event: 'autofix.push', meta: { paths: ['a'] } }]),
    af('21', [{ event: 'autofix.skipped', meta: { reason: 'no_changes' } }]),
    af('22', [{ event: 'autofix.skipped', meta: { reason: 'guardrail_rejected', rules: ['unshown_file', 'shrink'] } }]),
    af('23', [{ event: 'autofix.skipped', meta: { reason: 'guardrail_rejected' } }]),
    af('24', [{ event: 'autofix.max_attempts_reached' }, { event: 'autofix.error', level: 'error' }]),
    af('25', [{ event: 'autofix.skipped', meta: { reason: 'approved' } }, { event: 'autofix.skipped', meta: { reason: 'self_modification' } }]),
  ];
  const jsonl = [
    { type: 'autofix_skip', run_id: '21-1-autofix-skip', reason: 'no_changes' }, // has a record: not counted twice
    { type: 'autofix_skip', run_id: '90-1-autofix-skip', reason: 'guardrail_rejected', rules: ['unshown_file'] },
    { type: 'autofix_skip', run_id: '91-1-autofix-skip', reason: 'no_changes' },
    { type: 'autofix_skip', run_id: 5, reason: 'weird' },
    { type: 'pr', run_id: '92-1' },
  ].map((l) => JSON.stringify(l)).join('\n');
  const { autofix } = computeHealth({ model: model(records, jsonl) });
  assert.deepEqual({ ...autofix, rules: undefined }, { push: 1, no_op: 2, guardrail_rejected: 3, max_attempts: 1, approved_skip: 1, error: 1, other_skip: 2, rules: undefined, legacy_counted: 3 });
  assert.deepEqual(autofix.rules, [{ rule: 'unshown_file', count: 2 }, { rule: 'shrink', count: 1 }, { rule: 'unspecified', count: 1 }]);
});

test('LLM health: calls, fallbacks, failures, rate-limit waits; circuit-breaker trips are not recorded', () => {
  const records = [makeRecord({ runId: '30', start: T0, events: [
    { event: 'llm_fallback', level: 'warn' }, { event: 'llm_call_failed', level: 'warn' }, { event: 'llm_fallback_disabled' },
    { event: 'retry.wait', meta: { status: 429 } }, { event: 'retry.wait', meta: { status: 502 } },
  ] })];
  const h = computeHealth({ model: model(records) });
  assert.deepEqual(h.llm, { calls: 1, failed: 1, fallbacks: 1, fallback_disabled: 1, rate_limit_waits: 1 });
  assert.deepEqual(h.circuit_breaker, { trips: null });
});

test('latency per stage and critical path per work item', () => {
  const records = [
    makeRecord({ runId: '40', start: T0, durationMs: 2010 }),
    makeRecord({ runId: '41', start: T0 + 600000, durationMs: 4010 }),
    makeRecord({ runId: '42', start: T0, durationMs: 1010, workflow: 'Auto-Fix PR', stage: 'autofix' }),
  ];
  const h = computeHealth({ model: model(records) });
  assert.deepEqual(h.latency, [{ stage: 'autofix', n: 1, p50: 1000, p95: 1000 }, { stage: 'review', n: 2, p50: 2000, p95: 4000 }]);
  const [cp] = h.critical_path;
  assert.equal(cp.runs, 3);
  assert.equal(cp.lead_time_ms, 604010);
  assert.equal(cp.running_ms, 2010 + 4010);
  assert.equal(cp.waiting_ms, 604010 - 6020);
  assert.equal(cp.item.kind, 'pr');
});

test('Groq tokens per day: per workflow and series, eval runs from the scorecard, cron days marked', () => {
  const records = [
    makeRecord({ runId: '50', start: T0, tokensIn: 6000, tokensOut: 200 }),
    makeRecord({ runId: '51', start: T0, workflow: 'Auto-Fix PR', stage: 'autofix', tokensIn: 3000, tokensOut: 1000 }),
    makeRecord({ runId: '52', start: T0 - 86400000, workflow: 'Code Generation', stage: 'code_gen', tokensIn: 500, tokensOut: 500 }),
    makeRecord({ runId: '53', start: T0, provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 99999 }),
    makeRecord({ runId: '54', start: T0 - 40 * 86400000, tokensIn: 7 }),
  ];
  const scorecard = { version: 1, suites: {
    review: { runs: [{ run_id: 'e1', ts: '2026-10-14T07:00:00Z', model: 'openai/gpt-oss-120b', tokens_est: { in: 150000, out: 20000 } }, { run_id: 'e2', ts: '2026-10-14T08:00:00Z', model: 'claude-x', tokens_est: { in: 5 } }, { run_id: 'e3', ts: 'bad', model: 'm', tokens_est: { in: 1 } }] },
    validation: { runs: null },
  } };
  const { tokens } = computeHealth({ model: model(records), scorecard });
  assert.equal(tokens.limit, GROQ_TPD);
  assert.equal(tokens.days.length, TOKEN_DAYS);
  const today = tokens.days.at(-1);
  assert.equal(today.day, '2026-10-14');
  assert.equal(today.total, 6200 + 4000 + 170000);
  assert.deepEqual(today.series, { 'PR Review': 6200, 'Auto-Fix PR': 4000, Evals: 170000, Other: 0 });
  assert.deepEqual(today.workflows, { 'PR Review': 6200, 'Auto-Fix PR': 4000, 'Evals (review)': 170000 });
  assert.deepEqual(today.crons, ['review']);
  assert.deepEqual(tokens.days.at(-2).series.Other, 1000, 'Code Generation folds into Other');
  assert.deepEqual(tokens.days.at(-3).crons, ['validation']);
  assert.deepEqual(tokens.workflows, ['Auto-Fix PR', 'Code Generation', 'Evals (review)', 'PR Review']);
  assert.deepEqual(TOKEN_SERIES, ['PR Review', 'Auto-Fix PR', 'Evals', 'Other']);
  assert.equal(EVAL_CRONS.length, 2);
  assert.deepEqual(computeHealth({ model: model([]) }).tokens, { days: [], workflows: [], limit: GROQ_TPD });
});

test('modelUsage joins pipeline LLM calls and eval runs per provider:model', () => {
  const records = [
    makeRecord({ runId: '60', start: T0 }),
    makeRecord({ runId: '61', start: T0, llmStatus: 'error' }),
    makeRecord({ runId: '62', start: T0, provider: 'anthropic', model: 'claude-opus-5-5' }),
  ];
  const scorecard = { suites: { review: { runs: [{ run_id: 'e1', model: 'openai/gpt-oss-120b', passed: true, ts: 't' }, { run_id: 'e2', model: 'qwen/q', passed: false }, { model: 'x' }] }, bad: null } };
  const usage = modelUsage(model(records).runs, scorecard);
  assert.deepEqual(usage.map((m) => m.key), ['anthropic:claude-opus-5-5', 'groq:openai/gpt-oss-120b', 'groq:qwen/q']);
  const groq = usage[1];
  assert.deepEqual([groq.calls, groq.failed, groq.tokens, groq.runs.sort(), groq.evals], [2, 1, 2200, ['60-1', '61-1'], [{ suite: 'review', run_id: 'e1', ts: 't', passed: true }]]);
  assert.deepEqual(usage[2].evals, [{ suite: 'review', run_id: 'e2', ts: null, passed: false }]);
  assert.deepEqual(modelUsage([], null), []);
  assert.deepEqual(computeHealth().window, { months: [], runs: 0, traces: 0 });
});

// LLM cost of the window (llm_cost.mjs): per stage, workflow, day, top runs and work items.
test('costs: total, per stage with a per-run mean, per workflow, per day, top runs and work items', () => {
  const issue = { kind: 'issue', number: 50, source: 'branch' };
  const opus = { provider: 'anthropic', model: 'claude-opus-5-5' };
  const records = [
    makeRecord({ runId: '20', workflow: 'Code Generation', stage: 'code_gen', prNumber: null, issueNumber: 50, item: issue, start: T0, ...opus, tokensIn: 100_000, tokensOut: 10_000, usage: { cacheRead: 0 } }),
    makeRecord({ runId: '21', item: issue, start: T0 + 60000, ...opus, tokensIn: 50_000, tokensOut: 1000, usage: { cacheRead: 40_000 } }),
    makeRecord({ runId: '22', item: issue, start: T0 + 86400000, ...opus, tokensIn: 50_000, tokensOut: 1000 }),
    makeRecord({ runId: '23', prNumber: 60, start: T0, tokensIn: 5000, tokensOut: 500 }),
  ];
  const { costs } = computeHealth({ model: model(records) });
  const usd = { 20: (100_000 * 4 + 10_000 * 20) / 1e6, 21: (10_000 * 4 + 40_000 * 0.2 + 1000 * 20) / 1e6, 22: (50_000 * 4 + 1000 * 20) / 1e6 };
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  close(costs.total.usd, usd[20] + usd[21] + usd[22]);
  assert.deepEqual([costs.total.calls, costs.total.measured, costs.total.estimated, costs.total.free, costs.runs], [4, 2, 1, 1, 4]);
  assert.deepEqual(costs.by_stage.map((g) => [g.key, g.runs, g.calls]), [['code_gen', 1, 1], ['review', 3, 3]]);
  close(costs.by_stage[1].per_run_usd, (usd[21] + usd[22]) / 3);
  assert.deepEqual(costs.by_workflow.map((g) => g.key), ['Code Generation', 'PR Review']);
  assert.deepEqual(costs.by_day.map((g) => [g.key, g.calls]), [['2026-10-14', 3], ['2026-10-15', 1]]);
  assert.deepEqual(costs.top_runs.map((r) => r.run_id), ['20-1', '22-1', '21-1', '23-1']);
  assert.equal(costs.items, 2);
  assert.equal(costs.top_items[0].item.number, 50);
  close(costs.top_items[0].usd, usd[20] + usd[21] + usd[22]);
  close(costs.items_usd, costs.total.usd);
});

test('costs: a call without a stage outside a single-stage run is unattributed; no call → empty totals', () => {
  const rec = makeRecord({ runId: '30', provider: 'anthropic', model: 'claude-opus-5-5' });
  rec.spans.push({ ...rec.spans[0], stage: 'review_evidence' });
  const llm = rec.otlp.resourceSpans[0].scopeSpans[0].spans.find((s) => s.name === 'llm_call');
  llm.attributes = llm.attributes.filter((a) => a.key !== 'adl.stage');
  const { costs } = computeHealth({ model: model([rec]) });
  assert.deepEqual(costs.by_stage.map((g) => g.key), ['unattributed']);
  const empty = computeHealth({ model: model([]) }).costs;
  assert.deepEqual([empty.total.calls, empty.runs, empty.items, empty.by_stage.length, empty.top_runs.length], [0, 0, 0, 0, 0]);
});

test('modelUsage: list-price cost and unpriced calls per model', () => {
  const runs = model([
    makeRecord({ runId: '40', provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 1000 }),
    makeRecord({ runId: '41', provider: 'anthropic', model: 'claude-unknown' }),
  ]).runs;
  const byKey = Object.fromEntries(modelUsage(runs, null).map((m) => [m.key, m]));
  assert.ok(Math.abs(byKey['anthropic:claude-opus-5-5'].usd - 0.024) < 1e-9);
  assert.deepEqual([byKey['anthropic:claude-unknown'].usd, byKey['anthropic:claude-unknown'].unpriced], [0, 1]);
});
