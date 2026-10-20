import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClass, computeOverview, DEFINITIONS, RUN_CLASSES, TREND_DAYS } from '../lib/pipeline_kpis.mjs';
import { workItemJourney } from '../lib/pipeline_journey.mjs';

const DAY = 86400000;
const T = Date.parse('2026-10-20T12:00:00Z');
const run = (id, { stage = 'review', outcome = 'success', runOutcome = 'success', t = T, events = [], llm = [], pr = 9 } = {}) => ({
  run_id: id, workflow: 'PR Review', started_at: t, duration_ms: 1000, outcome: runOutcome, pr_number: pr, llm,
  stages: stage ? [{ stage, outcome, duration_ms: 900 }] : [], events: events.map((e) => ({ stage, level: 'info', ts: t, meta: {}, ...e })),
  events_overflow: { count: 0 }, spans_overflow: { count: 0, events: 0 },
});
const verdict = (v) => [{ event: 'review.verdict', meta: { verdict: v, prNumber: 9 } }];

test('run classes: failed, adverse, progressed, neutral', () => {
  assert.equal(runClass(run('1', { runOutcome: 'failed' })), 'failed');
  assert.equal(runClass(run('1', { outcome: 'failed' })), 'failed', 'failed span without a decision');
  assert.equal(runClass(run('1', { stage: 'issue_validation', outcome: 'failed', events: [{ event: 'issue_validation.fail' }] })), 'adverse', 'the rejection explains the failed span');
  assert.equal(runClass(run('1', { events: verdict('WITHHELD') })), 'adverse');
  assert.equal(runClass(run('1', { events: verdict('APPROVE') })), 'progressed');
  assert.equal(runClass(run('1', { outcome: 'skipped', events: [{ event: 'review.skipped' }] })), 'neutral');
  assert.equal(runClass(run('1', { stage: null })), 'neutral', 'no stage: nothing to judge');
  assert.deepEqual(RUN_CLASSES, ['failed', 'adverse', 'progressed', 'neutral']);
});

test('an empty model yields nulls and zero counts, never a healthy-looking default', () => {
  const o = computeOverview({ model: { runs: [], months: [] }, journeys: [] });
  assert.equal(o.reviews.approve_rate, null);
  assert.equal(o.reviews.runs_per_pr, null);
  assert.equal(o.lead_time.p50, null);
  assert.equal(o.running_share.value, null);
  assert.equal(o.window.from, null);
  assert.deepEqual(o.trend, { days: [], current: null, previous: null });
  assert.equal(o.cost.calls, 0);
  assert.deepEqual(computeOverview().window.runs, 0);
});

test('overview indicators from runs and journeys', () => {
  const runs = [
    run('1', { t: T, events: verdict('APPROVE') }),
    run('2', { t: T - DAY, events: verdict('WITHHELD') }),
    run('3', { t: T - 2 * DAY, runOutcome: 'failed', outcome: 'failed' }),
    run('4', { t: T - 9 * DAY, events: [...verdict('REQUEST_CHANGES'), { event: 'retry.wait', meta: { status: 429, wait_ms: 1500 } }, { event: 'retry.wait', meta: { status: 500, wait_ms: 99 } }, { event: 'retry.wait', meta: { status: 429 } }], llm: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 1000 }] }),
    run('5', { t: null, stage: null }),
  ];
  const traces = [
    { trace_id: 'a', item: { kind: 'pr', number: 9 }, runs: runs.slice(0, 2).map((r) => ({ run: r })), lead_time_ms: 4000, running_ms: 1000, waiting_ms: 3000 },
    { trace_id: 'b', item: { kind: 'pr', number: 10 }, runs: [{ run: runs[2] }], lead_time_ms: 1000, running_ms: 5000, waiting_ms: 0 },
    { trace_id: 'c', item: { kind: 'pr', number: 11 }, runs: [], lead_time_ms: null, running_ms: 0, waiting_ms: null },
  ];
  const o = computeOverview({ model: { runs, months: ['2026-10'] }, journeys: traces.map(workItemJourney) });
  assert.deepEqual(o.runs, { failed: 1, adverse: 2, progressed: 1, neutral: 1 });
  assert.deepEqual([o.reviews.verdicts, o.reviews.approve, o.reviews.withheld, o.reviews.request_changes, o.reviews.prs], [3, 1, 1, 1, 1]);
  assert.equal(o.reviews.approve_rate, 1 / 3);
  assert.equal(o.reviews.runs_per_pr, 3);
  assert.equal(o.items.by_state.approved, 1);
  assert.equal(o.items.by_state.failed, 1);
  assert.equal(o.items.by_state.no_data, 0, 'a trace without any loaded run is outside the retained window');
  assert.equal(o.items.needs_attention, 1);
  assert.deepEqual(o.recovery, { troubled: 2, recovered: 1 });
  assert.deepEqual(o.lead_time, { n: 2, p50: 1000, p90: 4000 });
  // Running is capped at the lead time: (1000 + 1000) / 5000.
  assert.equal(o.running_share.value, 0.4);
  assert.deepEqual(o.rate_limit_wait, { waits: 2, ms: 1500 });
  assert.equal(o.cost.calls, 1);
  assert.equal(o.window.from, T - 9 * DAY);
  // Trend: TREND_DAYS days ending on the latest run's day; the undated run is left out.
  assert.equal(o.trend.days.length, TREND_DAYS);
  assert.equal(o.trend.end, '2026-10-20');
  assert.equal(o.trend.days.at(-1).progressed, 1);
  assert.equal(o.trend.days.reduce((n, d) => n + d.total, 0), 4);
  assert.deepEqual(o.trend.current, { runs: 3, failed: 1, adverse: 1, verdicts: 2, approve: 1 });
  assert.deepEqual(o.trend.previous, { runs: 1, failed: 0, adverse: 1, verdicts: 1, approve: 0 });
});

test('every indicator has a source, method, period, population and known limits', () => {
  for (const [id, d] of Object.entries(DEFINITIONS)) {
    for (const k of ['label', 'source', 'method', 'period', 'population', 'limits']) assert.ok(typeof d[k] === 'string' && d[k].length > 5, `${id}.${k}`);
  }
  assert.match(DEFINITIONS.llm_cost.limits, /never a bill/);
  assert.match(DEFINITIONS.needs_attention.limits, /not recorded/);
  assert.match(DEFINITIONS.lead_time.limits, /not the item lifetime/);
});

test('windows: the latest N days against the N before, per-day series, providers, active items', async () => {
  const { computeWindow, computeWindows, providerBreakdown, WINDOWS } = await import('../lib/pipeline_kpis.mjs');
  const runs = [
    run('1', { t: T, events: verdict('APPROVE'), llm: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 1000 }] }),
    run('2', { t: T - 2 * DAY, events: verdict('WITHHELD'), llm: [{ provider: 'groq', model: 'm', tokens_in: 1, tokens_out: 1 }] }),
    run('3', { t: T - 8 * DAY, runOutcome: 'failed', outcome: 'failed' }),
    { ...run('4', { t: T - 9 * DAY, events: verdict('APPROVE') }), duration_ms: 3000 },
    run('5', { t: null }),
  ];
  const model = { runs };
  const journeys = [{ last_activity: T }, { last_activity: T - 10 * DAY }, { last_activity: null }];
  const w = computeWindow({ model, journeys, days: 7 });
  assert.equal(w.days, 7);
  assert.equal(w.series.length, 7);
  assert.equal(w.series.at(-1).day, '2026-10-20');
  assert.deepEqual([w.current.runs, w.current.progressed, w.current.adverse, w.current.verdicts, w.current.approve], [2, 1, 1, 2, 1]);
  assert.equal(w.current.approve_rate, 0.5);
  assert.deepEqual([w.previous.runs, w.previous.failed, w.previous.approve_rate], [2, 1, 1]);
  assert.deepEqual(w.current.duration, { n: 2, mean: 1000, p95: 1000 });
  assert.equal(w.previous.duration.mean, 2000);
  assert.equal(w.series.at(-1).usd, 0.024 + 0, 'the day with the Opus call');
  assert.equal(w.series.at(-2).usd, null, 'a day without any call has no cost, not $0');
  assert.equal(w.series.at(-3).usd, 0, 'a Groq-only day costs $0');
  assert.equal(w.series.at(-2).approve_rate, null);
  assert.deepEqual(w.providers.map((p) => [p.provider, p.calls, p.usd_share, p.call_share]), [['anthropic', 1, 1, 0.5], ['groq', 1, 0, 0.5]]);
  assert.equal(w.items.length, 1);
  assert.ok(!('selected' in w.current), 'no run list in the published window');
  assert.deepEqual(Object.keys(computeWindows({ model, journeys })).map(Number), WINDOWS);
  assert.deepEqual(computeWindow({ model: { runs: [run('x', { t: null })] } }), { days: 7, empty: true, current: null, previous: null, series: [], providers: [], items: [] });
  assert.equal(computeWindow().empty, true);
  // Providers: no call → empty; unknown provider kept; no priced call → shares null.
  assert.deepEqual(providerBreakdown([]), []);
  const unpriced = providerBreakdown([run('u', { llm: [{ model: 'x' }] })]);
  assert.deepEqual([unpriced[0].provider, unpriced[0].usd_share, unpriced[0].call_share], ['unknown', null, 1]);
  for (const id of ['executions', 'run_duration', 'providers']) assert.ok(DEFINITIONS[id].limits);
});

test('journey aggregates cover the retained window only: an index older than the loaded months is left out (PR #242 review)', () => {
  const recent = { trace_id: 'r', item: { kind: 'pr', number: 1 }, runs: [{ run: run('1', { events: verdict('APPROVE') }) }], lead_time_ms: 1000, running_ms: 500, waiting_ms: 500 };
  // A trace index from before the window: its runs are listed but none is loaded; its indexed times stay on the index.
  const old = { trace_id: 'o', item: { kind: 'pr', number: 2 }, runs: [{ run: null, run_id: '9-1' }, { run: null, run_id: '10-1' }], lead_time_ms: 99e6, running_ms: 1e6, waiting_ms: 98e6 };
  const o = computeOverview({ model: { runs: recent.runs.map((r) => r.run) }, journeys: [recent, old].map(workItemJourney) });
  assert.deepEqual(o.lead_time, { n: 1, p50: 1000, p90: 1000 });
  assert.equal(o.running_share.value, 0.5);
  assert.equal(o.items.by_state.no_data, 0);
  assert.equal(o.items.by_state.approved, 1);
  assert.match(DEFINITIONS.lead_time.population, /at least one loaded run record/);
});

test('errored validations count as failed runs; unpriced days are gaps in the cost series (PR #242 review)', async () => {
  const { computeWindow } = await import('../lib/pipeline_kpis.mjs');
  assert.equal(runClass(run('e', { stage: 'issue_validation', outcome: 'failed', events: [{ event: 'issue_validation.fail', level: 'error', meta: { error: 'boom' } }] })), 'failed');
  const runs = [
    run('a', { t: T, llm: [{ provider: 'anthropic', model: 'claude-unknown', tokens_in: 1, tokens_out: 1 }] }),
    run('b', { t: T - DAY, llm: [{ provider: 'anthropic', model: 'claude-unknown', tokens_in: 1, tokens_out: 1 }, { provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 1000 }] }),
    run('c', { t: T - 2 * DAY, llm: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 1000 }] }),
  ];
  const w = computeWindow({ model: { runs }, days: 7 });
  assert.equal(w.series.at(-1).usd, null, 'all-unpriced day: not $0');
  assert.equal(w.series.at(-2).usd, null, 'mixed day: a lower bound is not plotted');
  assert.equal(w.series.at(-3).usd, 0.024);
});

test('provider cost shares are not shown when any call is unpriced (PR #242 review)', async () => {
  const { providerBreakdown } = await import('../lib/pipeline_kpis.mjs');
  const rows = providerBreakdown([run('m', { llm: [{ provider: 'anthropic', model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 1000 }, { provider: 'other', model: 'x', tokens_in: 1, tokens_out: 1 }] })]);
  assert.deepEqual(rows.map((r) => [r.provider, r.usd_share, r.call_share]), [['anthropic', null, 0.5], ['other', null, 0.5]]);
});
