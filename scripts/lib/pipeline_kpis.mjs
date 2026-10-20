// Overview indicators of the dashboard (ADR-0043): each one computed from the pipeline model and the
// journeys, with its definition (source, method, period, population, limits) shipped next to the value so
// the page can show how it was obtained. Pure. No default value stands in for missing data: an indicator
// without a population is null and the page says so.
import { sumCosts } from './llm_cost.mjs';
import { percentile } from './pipeline_health.mjs';
import { attemptOf, STATES } from './pipeline_journey.mjs';

export const TREND_DAYS = 14;
const DAY_MS = 86400000;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const ratio = (n, d) => (d ? n / d : null);

const RECORDS = 'Redacted run records on the `metrics` branch (ADR-0040)';
const TRACES = 'Trace indexes on the `metrics` branch (ADR-0041) joined to the run records';
const WINDOW = 'Retained window: the newest 6 months of records';

/** Definition of every overview indicator, by id (rendered on the overview's definitions panel). */
export const DEFINITIONS = Object.freeze({
  runs_failed: { label: 'Failed executions', source: RECORDS, method: 'Runs whose recorded outcome is `failed`, plus runs with a stage span closed as failed and no decision event explaining it', period: WINDOW, population: 'Every loaded run record', limits: 'A run that crashed before its tracer wrote a record is absent (ADR-0040). `partial` is a business decision, not a failure.' },
  runs_adverse: { label: 'Runs with an adverse decision', source: RECORDS, method: 'Runs whose step decided not to move the item forward: WITHHELD or REQUEST_CHANGES review, rejected validation, blocked generation, auto-fix without a push', period: WINDOW, population: 'Every loaded run record', limits: 'An adverse decision can be correct (a real defect); it measures friction, not errors.' },
  approve_rate: { label: 'Review approval rate', source: RECORDS + ', `review.verdict` events', method: 'APPROVE verdicts ÷ all recorded verdicts (skipped reviews excluded)', period: WINDOW, population: 'Review runs that recorded a verdict', limits: 'Each review run counts, so a PR reviewed several times weighs more. Not a merge rate.' },
  needs_attention: { label: 'Work items needing a person', source: TRACES, method: 'Work items whose last recorded state is failed, escalated (needs-human), approval withheld or rejected by validation', period: WINDOW, population: 'Work items with a trace index and at least one loaded run record', limits: 'The current label state on GitHub is not recorded: a person may already have acted. Merged PRs are only known live (Pipelines page).' },
  recovered: { label: 'Steps recovered automatically', source: TRACES, method: 'Steps whose final attempt moved the item forward after at least one failed or adverse attempt', period: WINDOW, population: 'Steps with at least one failed or adverse attempt', limits: 'Recovery within the retained window only.' },
  lead_time: { label: 'Lead time per work item', source: TRACES, method: 'First run start → last run end of the item; median and 90th percentile (nearest rank)', period: WINDOW, population: 'Work items with a lead time and at least one loaded run record', limits: 'Observed duration, not the item lifetime: time before the first run and after the last one (human merge) is not recorded. An item whose first runs predate the window keeps its full indexed lead time. Runner clocks differ (ADR-0041 §6).' },
  running_share: { label: 'Share of lead time spent running', source: TRACES, method: 'Σ time inside runs ÷ Σ lead time; the rest is waiting between runs', period: WINDOW, population: 'Work items with a lead time', limits: 'Approximate: runs are placed by their own runner clocks.' },
  review_runs_per_pr: { label: 'Review runs per PR', source: RECORDS, method: 'Review runs that recorded a verdict ÷ PRs with at least one verdict', period: WINDOW, population: 'PRs with a recorded verdict', limits: 'Counts duplicate triggers (push + pull_request on one head) as separate runs.' },
  rate_limit_wait: { label: 'Time waiting on rate limits', source: RECORDS + ', `retry.wait` events with status 429', method: 'Σ wait_ms of 429 retry waits', period: WINDOW, population: 'Every loaded run record', limits: 'Waits logged by the retry helper only; provider queueing is not visible.' },
  llm_cost: { label: 'LLM cost (estimate)', source: RECORDS + ', `llm_call` spans priced by `llm_cost.mjs`', method: 'List price × tokens (measured where the record has usage, chars/4 estimate otherwise); Groq free tier at $0; the change against the previous window only when neither side has an unpriced call', period: WINDOW, population: 'Every recorded LLM call', limits: 'List price, never a bill. Unpriced calls are counted apart, not as $0.' },
  executions: { label: 'Pipeline executions', source: RECORDS, method: 'Runs started in the window, by class: moved forward, adverse decision, failed, skip / no decision; the change is against the same number of days just before', period: 'The selected window (7, 14 or 30 days) ending on the latest recorded run', population: 'Runs with a start time', limits: 'A run in progress is not recorded yet, so there is no running count.' },
  run_duration: { label: 'Average run duration', source: RECORDS, method: 'Mean of run durations (start → end of the workflow job record) in the window; p95 by nearest rank', period: 'The selected window', population: 'Runs with both timestamps', limits: 'Job time only: queueing before the job and waiting between runs are not included (see lead time).' },
  providers: { label: 'LLM providers', source: RECORDS + ', `llm_call` spans', method: 'Calls and list-price cost per provider in the window; shares of the window total', period: 'The selected window', population: 'Recorded LLM calls', limits: 'Groq free-tier calls cost $0: their share of cost is 0 while their share of calls can be large.' },
  trend: { label: 'Runs per day', source: RECORDS, method: 'Runs per UTC day by class (failed, adverse decision, moved forward, skipped / no decision), last 14 days ending on the latest recorded run; the 7-day comparison sets the latest 7 days against the 7 before', period: '14 days ending on the latest recorded run (not the build time)', population: 'Runs with a start time', limits: 'Small daily counts: a rate on a few runs is noisy; n is shown next to every rate.' },
});

/**
 * Class of one run for the trend: failed, adverse (a decision that did not move the item forward),
 * progressed, or neutral (skips, no decision recorded).
 */
export function runClass(run) {
  const attempts = [...new Set(run.stages.map((s) => s.stage).filter(Boolean))].map((s) => attemptOf(run, s));
  if (run.outcome === 'failed' || attempts.some((a) => a.status === 'failed' && (!a.decision || a.decision.tone === 'bad'))) return 'failed';
  if (attempts.some((a) => a.tone === 'warn' || a.tone === 'bad')) return 'adverse';
  if (attempts.some((a) => a.tone === 'good')) return 'progressed';
  return 'neutral';
}

export const RUN_CLASSES = Object.freeze(['failed', 'adverse', 'progressed', 'neutral']);

function trend(runs) {
  const dated = runs.filter((r) => r.started_at != null);
  if (!dated.length) return { days: [], current: null, previous: null };
  const end = Date.parse(`${day(Math.max(...dated.map((r) => r.started_at)))}T00:00:00Z`);
  const days = Array.from({ length: TREND_DAYS }, (_, i) => ({ day: day(end - (TREND_DAYS - 1 - i) * DAY_MS), failed: 0, adverse: 0, progressed: 0, neutral: 0, total: 0 }));
  const byDay = new Map(days.map((d) => [d.day, d]));
  const span = (from, to) => {
    const sel = dated.filter((r) => r.started_at >= from && r.started_at < to);
    const classes = sel.map(runClass);
    const verdicts = sel.flatMap((r) => r.events.filter((e) => e.event === 'review.verdict').map((e) => e.meta.verdict));
    return {
      runs: sel.length,
      failed: classes.filter((c) => c === 'failed').length,
      adverse: classes.filter((c) => c === 'adverse').length,
      verdicts: verdicts.length,
      approve: verdicts.filter((v) => v === 'APPROVE').length,
    };
  };
  for (const r of dated) {
    const d = byDay.get(day(r.started_at));
    if (!d) continue;
    d[runClass(r)] += 1;
    d.total += 1;
  }
  return { days, end: day(end), current: span(end - 6 * DAY_MS, end + DAY_MS), previous: span(end - 13 * DAY_MS, end - 6 * DAY_MS) };
}

/** The overview indicators of a model and its journeys (pipeline_journey.mjs). */
export function computeOverview({ model, journeys: all = [] } = {}) {
  const runs = model?.runs ?? [];
  // Work items of the retained window only: a trace index older than the loaded months has no loaded run.
  const journeys = all.filter((j) => (j.runs ?? 0) - (j.missing_runs ?? 0) > 0);
  const classes = runs.map(runClass);
  const verdicts = runs.flatMap((r) => r.events.filter((e) => e.event === 'review.verdict').map((e) => ({ verdict: e.meta.verdict, pr: Number.isSafeInteger(e.meta.prNumber) ? e.meta.prNumber : r.pr_number })));
  const prs = new Set(verdicts.map((v) => v.pr).filter(Boolean));
  const byState = Object.fromEntries(Object.keys(STATES).map((k) => [k, 0]));
  for (const j of journeys) byState[j.state] += 1;
  const steps = journeys.flatMap((j) => j.steps);
  const troubled = steps.filter((s) => s.failures || s.adverse);
  const leads = journeys.map((j) => j.lead_time_ms).filter((v) => typeof v === 'number');
  const timed = journeys.filter((j) => typeof j.lead_time_ms === 'number' && j.lead_time_ms > 0 && typeof j.running_ms === 'number');
  const leadSum = timed.reduce((t, j) => t + j.lead_time_ms, 0);
  const waits = runs.flatMap((r) => r.events.filter((e) => e.event === 'retry.wait' && e.meta.status === 429));
  const dated = runs.map((r) => r.started_at).filter((t) => t != null);
  return {
    window: {
      runs: runs.length, items: journeys.length, months: model?.months ?? [],
      from: dated.length ? Math.min(...dated) : null, to: dated.length ? Math.max(...dated) : null,
    },
    runs: Object.fromEntries(RUN_CLASSES.map((c) => [c, classes.filter((x) => x === c).length])),
    reviews: {
      verdicts: verdicts.length,
      approve: verdicts.filter((v) => v.verdict === 'APPROVE').length,
      withheld: verdicts.filter((v) => v.verdict === 'WITHHELD').length,
      request_changes: verdicts.filter((v) => v.verdict === 'REQUEST_CHANGES').length,
      approve_rate: ratio(verdicts.filter((v) => v.verdict === 'APPROVE').length, verdicts.length),
      prs: prs.size,
      runs_per_pr: ratio(verdicts.length, prs.size),
    },
    items: { by_state: byState, needs_attention: journeys.filter((j) => j.attention).length },
    recovery: { troubled: troubled.length, recovered: troubled.filter((s) => s.recovered).length },
    lead_time: { n: leads.length, p50: percentile(leads, 50), p90: percentile(leads, 90) },
    running_share: { n: timed.length, value: leadSum ? timed.reduce((t, j) => t + Math.min(j.running_ms, j.lead_time_ms), 0) / leadSum : null },
    rate_limit_wait: { waits: waits.length, ms: waits.reduce((t, e) => t + (Number.isFinite(e.meta.wait_ms) ? e.meta.wait_ms : 0), 0) },
    cost: sumCosts(runs.flatMap((r) => r.llm)),
    trend: trend(runs),
  };
}

// ---------------------------------------------------------------------------
// Time windows of the overview (7 / 14 / 30 days ending on the latest recorded run, never the build time)
// ---------------------------------------------------------------------------

export const WINDOWS = Object.freeze([7, 14, 30]);

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

// Indicators of the runs started in [from, to).
function slice(runs, from, to) {
  const sel = runs.filter((r) => r.started_at != null && r.started_at >= from && r.started_at < to);
  const classes = sel.map(runClass);
  const verdicts = sel.flatMap((r) => r.events.filter((e) => e.event === 'review.verdict').map((e) => e.meta.verdict));
  const durations = sel.map((r) => r.duration_ms).filter((v) => typeof v === 'number');
  const approve = verdicts.filter((v) => v === 'APPROVE').length;
  return {
    runs: sel.length,
    ...Object.fromEntries(RUN_CLASSES.map((c) => [c, classes.filter((x) => x === c).length])),
    verdicts: verdicts.length,
    approve,
    withheld: verdicts.filter((v) => v === 'WITHHELD').length,
    request_changes: verdicts.filter((v) => v === 'REQUEST_CHANGES').length,
    approve_rate: ratio(approve, verdicts.length),
    duration: { n: durations.length, mean: mean(durations), p95: percentile(durations, 95) },
    cost: sumCosts(sel.flatMap((r) => r.llm)),
    selected: sel,
  };
}

/** LLM cost and calls per provider, most expensive first (then most calls); shares of the total. */
export function providerBreakdown(runs) {
  const by = new Map();
  for (const c of runs.flatMap((r) => r.llm)) {
    const k = c.provider ?? 'unknown';
    by.set(k, [...(by.get(k) ?? []), c]);
  }
  const rows = [...by.entries()].map(([provider, calls]) => ({ provider, ...sumCosts(calls) }));
  const usd = rows.reduce((t, r) => t + r.usd, 0);
  const calls = rows.reduce((t, r) => t + r.calls, 0);
  return rows.map((r) => ({ ...r, usd_share: usd ? r.usd / usd : null, call_share: calls ? r.calls / calls : null }))
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls || a.provider.localeCompare(b.provider));
}

/**
 * The overview of one window: `days` days ending on the latest recorded run's UTC day, the same length
 * before it as the comparison (`previous`, whose `runs` is 0 when nothing was recorded then — no delta is
 * shown), a per-day series, the providers and the work items active in the window.
 */
export function computeWindow({ model, journeys = [], days = 7 } = {}) {
  const runs = (model?.runs ?? []).filter((r) => r.started_at != null);
  if (!runs.length) return { days, empty: true, current: null, previous: null, series: [], providers: [], items: [] };
  const end = Date.parse(`${day(Math.max(...runs.map((r) => r.started_at)))}T00:00:00Z`) + DAY_MS;
  const from = end - days * DAY_MS;
  const current = slice(runs, from, end);
  const previous = slice(runs, from - days * DAY_MS, from);
  const series = Array.from({ length: days }, (_, i) => {
    const s = slice(current.selected, from + i * DAY_MS, from + (i + 1) * DAY_MS);
    return { day: day(from + i * DAY_MS), total: s.runs, failed: s.failed, adverse: s.adverse, progressed: s.progressed, neutral: s.neutral, approve_rate: s.approve_rate, verdicts: s.verdicts, avg_ms: s.duration.mean, p95_ms: s.duration.p95, usd: s.cost.calls && !s.cost.unpriced ? s.cost.usd : null };
  });
  const strip = ({ selected, ...rest }) => rest;
  return {
    days, empty: false, from, to: end - 1,
    current: strip(current), previous: strip(previous),
    series,
    providers: providerBreakdown(current.selected),
    items: journeys.filter((j) => j.last_activity != null && j.last_activity >= from),
  };
}

/** Every overview window, keyed by its length in days. */
export function computeWindows({ model, journeys = [] } = {}) {
  return Object.fromEntries(WINDOWS.map((d) => [d, computeWindow({ model, journeys, days: d })]));
}
