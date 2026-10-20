// Health of the pipeline (ADR-0027 amendment): aggregates of the pipeline model (pipeline_model.mjs)
// and of the eval scorecard the dashboard already holds. Pure. Token counts are provider-measured where
// the record has them (ADR-0041 amendment), chars/4 estimates otherwise; the Groq quota chart counts both.
import { sumCosts, addCosts } from './llm_cost.mjs';

export const GROQ_TPD = 200000;
export const TOKEN_DAYS = 30;
// The weekly eval crons of evals.yml (workflow_gates.test.mjs keeps them in sync): marked on the token chart.
export const EVAL_CRONS = Object.freeze([
  Object.freeze({ cron: '23 6 * * 1', suite: 'validation', weekday: 1 }),
  Object.freeze({ cron: '23 6 * * 3', suite: 'review', weekday: 3 }),
]);
// Fixed series of the token chart, in palette order; any other workflow folds into "Other".
export const TOKEN_SERIES = Object.freeze(['PR Review', 'Auto-Fix PR', 'Evals', 'Other']);

const DAY_MS = 86400000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inc = (obj, key, by = 1) => { obj[key] = (obj[key] ?? 0) + by; };
const day = (t) => new Date(t).toISOString().slice(0, 10);

/** Nearest-rank percentile of numbers (null when empty). */
export function percentile(values, p) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/** Provider of an eval scorecard run, which records the model only: Anthropic models are `claude-*`. */
export function evalProvider(model) {
  return /^claude/i.test(String(model ?? '')) ? 'anthropic' : 'groq';
}

const eventsOf = (run, name) => run.events.filter((e) => e.event === name);

// Work items (by trace id) → the furthest stage reached. "Merged" is not journaled by any workflow.
function funnel(runs) {
  const items = new Map();
  for (const run of runs) {
    if (!run.trace_id) continue;
    const it = items.get(run.trace_id) ?? { kind: run.item?.kind ?? null, validated: false, pr: false, approved: false };
    if (eventsOf(run, 'issue_validation.pass').length) it.validated = true;
    if (run.pr_number || eventsOf(run, 'workflow.pr_operation').some((e) => ['created', 'updated'].includes(e.meta.operation))) it.pr = true;
    if (eventsOf(run, 'review.verdict').some((e) => e.meta.verdict === 'APPROVE')) it.approved = true;
    items.set(run.trace_id, it);
  }
  const issues = [...items.values()].filter((i) => i.kind === 'issue');
  const prs = [...items.values()].filter((i) => i.kind === 'pr');
  const validated = issues.filter((i) => i.validated);
  const opened = validated.filter((i) => i.pr);
  return {
    stages: [
      { stage: 'Issues validated', count: validated.length },
      { stage: 'PR opened', count: opened.length },
      { stage: 'Approved', count: opened.filter((i) => i.approved).length },
      { stage: 'Merged', count: null },
    ],
    issue_items: issues.length,
    pr_items: { total: prs.length, approved: prs.filter((i) => i.approved).length },
  };
}

const WITHHELD_CAUSES = Object.freeze({
  approve_cut: 'Approval withheld: code cut from the reviewed diff (ADR-0038)',
  rc_unseen: 'REQUEST_CHANGES withheld: every finding cites only unseen code (#220)',
  cut_unknown: 'Code cut from the diff, pre-backstop verdict not recorded (record before withheld_from)',
  evidence_missing: 'CI evidence missing (ADR-0026)',
  evidence_stale: 'CI evidence stale (ADR-0026)',
  other: 'Evidence unverified / other',
});

function withheldCause(meta) {
  if (meta.withheld_from === 'APPROVE') return 'approve_cut';
  if (meta.withheld_from === 'REQUEST_CHANGES') return 'rc_unseen';
  // Only a record written before the key existed is ambiguous; a present null means no backstop was involved.
  if (!Object.hasOwn(meta, 'withheld_from') && typeof meta.unreviewed_code_files === 'number' && meta.unreviewed_code_files > 0) return 'cut_unknown';
  if (meta.evidence_state === 'missing') return 'evidence_missing';
  if (meta.evidence_state === 'stale') return 'evidence_stale';
  return 'other';
}

function reviews(runs) {
  const verdicts = { APPROVE: 0, REQUEST_CHANGES: 0, WITHHELD: 0, other: 0 };
  const causes = Object.fromEntries(Object.keys(WITHHELD_CAUSES).map((k) => [k, 0]));
  const cycles = new Map();
  let diffCut = 0;
  let diffCutWithheld = 0;
  for (const run of runs) {
    const cut = eventsOf(run, 'review.prompt_truncated').some((e) => e.meta.diff_truncated === true);
    for (const e of eventsOf(run, 'review.verdict')) {
      const v = Object.hasOwn(verdicts, e.meta.verdict) && e.meta.verdict !== 'other' ? e.meta.verdict : 'other';
      verdicts[v] += 1;
      if (v === 'WITHHELD') causes[withheldCause(e.meta)] += 1;
      if (cut) { diffCut += 1; if (v === 'WITHHELD') diffCutWithheld += 1; }
      const pr = Number.isInteger(e.meta.prNumber) && e.meta.prNumber > 0 ? e.meta.prNumber : run.pr_number;
      if (pr) cycles.set(pr, (cycles.get(pr) ?? 0) + 1);
    }
  }
  const total = Object.values(verdicts).reduce((a, b) => a + b, 0);
  const distribution = {};
  for (const n of cycles.values()) inc(distribution, n);
  return {
    verdicts,
    total,
    withheld_rate: total ? verdicts.WITHHELD / total : null,
    causes: Object.entries(WITHHELD_CAUSES).map(([key, label]) => ({ key, label, count: causes[key] })),
    rc_to_withheld: causes.rc_unseen,
    diff_cut: { reviews: diffCut, withheld: diffCutWithheld },
    cycles_per_pr: [...cycles.entries()].sort((a, b) => b[0] - a[0]).map(([pr, n]) => ({ pr, cycles: n })),
    cycles_distribution: Object.entries(distribution).map(([c, prs]) => ({ cycles: Number(c), prs })).sort((a, b) => a.cycles - b.cycles),
  };
}

// Auto-fix outcomes per attempt; legacy runs.jsonl `autofix_skip` lines count when their run has no record.
function autofix(runs, legacy, runsById) {
  const out = { push: 0, no_op: 0, guardrail_rejected: 0, max_attempts: 0, approved_skip: 0, error: 0, other_skip: 0 };
  const rules = {};
  const addRules = (list) => { for (const r of Array.isArray(list) && list.length ? list : ['unspecified']) inc(rules, String(r)); };
  for (const run of runs) {
    for (const e of run.events) {
      if (e.event === 'autofix.push') out.push += 1;
      else if (e.event === 'autofix.max_attempts_reached') out.max_attempts += 1;
      else if (e.event === 'autofix.error') out.error += 1;
      else if (e.event === 'autofix.skipped') {
        if (e.meta.reason === 'no_changes') out.no_op += 1;
        else if (e.meta.reason === 'guardrail_rejected') { out.guardrail_rejected += 1; addRules(e.meta.rules); }
        else if (e.meta.reason === 'approved') out.approved_skip += 1;
        else out.other_skip += 1;
      }
    }
  }
  let legacyCounted = 0;
  for (const line of legacy) {
    if (line.type !== 'autofix_skip') continue;
    const base = typeof line.run_id === 'string' ? line.run_id.replace(/-autofix-skip$/, '') : '';
    if (runsById.has(base)) continue;
    legacyCounted += 1;
    if (line.reason === 'no_changes') out.no_op += 1;
    else if (line.reason === 'guardrail_rejected') { out.guardrail_rejected += 1; addRules(line.rules); }
    else out.other_skip += 1;
  }
  return { ...out, rules: Object.entries(rules).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([rule, count]) => ({ rule, count })), legacy_counted: legacyCounted };
}

function llm(runs) {
  let calls = 0;
  let failed = 0;
  let fallbacks = 0;
  let fallbackDisabled = 0;
  let rateLimitWaits = 0;
  for (const run of runs) {
    calls += run.llm.length;
    for (const e of run.events) {
      if (e.event === 'llm_call_failed') failed += 1;
      else if (e.event === 'llm_fallback') fallbacks += 1;
      else if (e.event === 'llm_fallback_disabled') fallbackDisabled += 1;
      else if (e.event === 'retry.wait' && e.meta.status === 429) rateLimitWaits += 1;
    }
  }
  return { calls, failed, fallbacks, fallback_disabled: fallbackDisabled, rate_limit_waits: rateLimitWaits };
}

function latency(runs) {
  const byStage = new Map();
  for (const run of runs) {
    for (const s of run.stages) {
      if (!s.stage || s.duration_ms == null) continue;
      if (!byStage.has(s.stage)) byStage.set(s.stage, []);
      byStage.get(s.stage).push(s.duration_ms);
    }
  }
  return [...byStage.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([stage, v]) => ({ stage, n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) }));
}

function criticalPath(traces) {
  return traces.filter((t) => t.lead_time_ms != null).map((t) => ({
    trace_id: t.trace_id, item: t.item, runs: t.runs.length,
    lead_time_ms: t.lead_time_ms, running_ms: Math.min(t.running_ms, t.lead_time_ms), waiting_ms: t.waiting_ms,
  }));
}

const seriesOf = (workflow) => (TOKEN_SERIES.includes(workflow) && workflow !== 'Other' && workflow !== 'Evals' ? workflow : 'Other');

/**
 * Groq tokens (estimated) per UTC day over the TOKEN_DAYS days ending on the latest day with data:
 * per workflow (table) and per TOKEN_SERIES (chart), eval runs from the scorecard as "Evals", and the
 * days the weekly eval crons fire.
 */
function groqTokens(runs, scorecard) {
  const points = [];
  for (const run of runs) {
    for (const c of run.llm) {
      const ts = c.ts ?? run.started_at;
      if (c.provider !== 'groq' || ts == null) continue;
      points.push({ ts, workflow: run.workflow ?? 'unknown', series: seriesOf(run.workflow), tokens: (c.tokens_in ?? 0) + (c.tokens_out ?? 0) });
    }
  }
  for (const [suite, s] of Object.entries(isObj(scorecard?.suites) ? scorecard.suites : {})) {
    for (const r of Array.isArray(s?.runs) ? s.runs : []) {
      const ts = Date.parse(r?.ts);
      const tokens = (Number(r?.tokens_est?.in) || 0) + (Number(r?.tokens_est?.out) || 0);
      if (!Number.isFinite(ts) || !tokens || evalProvider(r.model) !== 'groq') continue;
      points.push({ ts, workflow: `Evals (${suite})`, series: 'Evals', tokens });
    }
  }
  if (!points.length) return { days: [], workflows: [], limit: GROQ_TPD };
  const lastDay = Date.parse(`${day(Math.max(...points.map((p) => p.ts)))}T00:00:00Z`);
  const days = Array.from({ length: TOKEN_DAYS }, (_, i) => {
    const t = lastDay - (TOKEN_DAYS - 1 - i) * DAY_MS;
    const weekday = new Date(t).getUTCDay();
    return { day: day(t), total: 0, series: Object.fromEntries(TOKEN_SERIES.map((s) => [s, 0])), workflows: {}, crons: EVAL_CRONS.filter((c) => c.weekday === weekday).map((c) => c.suite) };
  });
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const p of points) {
    const d = byDay.get(day(p.ts));
    if (!d) continue;
    d.total += p.tokens;
    d.series[p.series] += p.tokens;
    inc(d.workflows, p.workflow, p.tokens);
  }
  const workflows = [...new Set(days.flatMap((d) => Object.keys(d.workflows)))].sort();
  return { days, workflows, limit: GROQ_TPD };
}

export const COST_TOP = 10;
const STEP_ORDER = ['issue_validation', 'code_gen', 'pr_prepare', 'review', 'autofix'];

/**
 * LLM cost of the window (llm_cost.mjs, list price): the total, per pipeline stage (with the runs that
 * spent it, for a per-run mean), per workflow, per UTC day (last TOKEN_DAYS days with a call), and the
 * COST_TOP most expensive runs and work items. A call without a stage counts under `unattributed`.
 */
function costs(runs, traces) {
  const groups = { stage: new Map(), workflow: new Map(), day: new Map() };
  const add = (map, key, calls, runId) => {
    const g = map.get(key) ?? { ids: new Set(), sum: sumCosts([]) };
    g.sum = addCosts(g.sum, sumCosts(calls));
    g.ids.add(runId);
    map.set(key, g);
  };
  for (const run of runs) {
    if (!run.llm.length) continue;
    const byStage = new Map();
    for (const c of run.llm) {
      const stage = c.pipeline_stage ?? (run.stages.length === 1 && run.stages[0].stage ? run.stages[0].stage : 'unattributed');
      byStage.set(stage, [...(byStage.get(stage) ?? []), c]);
      const ts = c.ts ?? run.started_at;
      if (ts != null) add(groups.day, day(ts), [c], run.run_id);
    }
    for (const [stage, calls] of byStage) add(groups.stage, stage, calls, run.run_id);
    add(groups.workflow, run.workflow ?? 'unknown', run.llm, run.run_id);
  }
  const rows = (map) => [...map.entries()].map(([key, { ids, sum }]) => ({ key, ...sum, runs: ids.size, per_run_usd: sum.usd / ids.size }));
  const rank = (k) => (STEP_ORDER.includes(k) ? STEP_ORDER.indexOf(k) : STEP_ORDER.length);
  const priced = runs.filter((r) => r.llm.length);
  const items = traces.map((t) => {
    const loaded = t.runs.map((r) => r.run).filter(Boolean);
    return { trace_id: t.trace_id, item: t.item, runs: loaded.length, ...sumCosts(loaded.flatMap((r) => r.llm)) };
  }).filter((t) => t.calls);
  const byUsd = (a, b) => b.usd - a.usd || b.calls - a.calls;
  return {
    total: sumCosts(runs.flatMap((r) => r.llm)),
    runs: priced.length,
    items: items.length,
    items_usd: items.reduce((t, it) => t + it.usd, 0),
    by_stage: rows(groups.stage).sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)),
    by_workflow: rows(groups.workflow).sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key)),
    by_day: rows(groups.day).sort((a, b) => a.key.localeCompare(b.key)).slice(-TOKEN_DAYS),
    top_runs: priced.map((r) => ({ run_id: r.run_id, workflow: r.workflow, item: r.item, started_at: r.started_at, ...r.cost })).sort(byUsd).slice(0, COST_TOP),
    top_items: items.sort(byUsd).slice(0, COST_TOP),
  };
}

/** Every provider:model seen in the pipeline's LLM calls or in the eval scorecard, for the cross-link page. */
export function modelUsage(runs, scorecard) {
  const models = new Map();
  const get = (provider, model) => {
    const key = `${provider ?? 'unknown'}:${model ?? 'unknown'}`;
    if (!models.has(key)) models.set(key, { key, provider: provider ?? null, model: model ?? null, calls: 0, failed: 0, fallback: 0, tokens: 0, usd: 0, unpriced: 0, cost: sumCosts([]), runs: [], evals: [] });
    return models.get(key);
  };
  for (const run of runs) {
    const seen = new Set();
    for (const c of run.llm) {
      const m = get(c.provider, c.model);
      m.calls += 1;
      if (c.failed) m.failed += 1;
      if (c.fallback) m.fallback += 1;
      m.tokens += (c.tokens_in ?? 0) + (c.tokens_out ?? 0);
      m.cost = addCosts(m.cost, sumCosts([c]));
      m.usd = m.cost.usd;
      m.unpriced = m.cost.unpriced;
      if (!seen.has(m.key) && m.runs.length < 20) { m.runs.push(run.run_id); seen.add(m.key); }
    }
  }
  for (const [suite, s] of Object.entries(isObj(scorecard?.suites) ? scorecard.suites : {})) {
    for (const r of Array.isArray(s?.runs) ? s.runs : []) {
      if (typeof r?.run_id !== 'string' || typeof r.model !== 'string') continue;
      get(evalProvider(r.model), r.model).evals.push({ suite, run_id: r.run_id, ts: r.ts ?? null, passed: r.passed === true });
    }
  }
  return [...models.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The Health page data. Circuit-breaker trips are not in either store: a tripped eval run fails
 * error_rate and is never published (partitionPublishable), and eval traces stay artifacts — the
 * page shows the gap and the rate-limit waits the pipeline did journal.
 */
export function computeHealth({ model, scorecard = null } = {}) {
  const runs = model?.runs ?? [];
  return {
    window: { months: model?.months ?? [], runs: runs.length, traces: model?.traces?.length ?? 0 },
    funnel: funnel(runs),
    reviews: reviews(runs),
    autofix: autofix(runs, model?.legacy ?? [], model?.runsById ?? new Map()),
    llm: llm(runs),
    circuit_breaker: { trips: null },
    latency: latency(runs),
    critical_path: criticalPath(model?.traces ?? []),
    tokens: groqTokens(runs, scorecard),
    costs: costs(runs, model?.traces ?? []),
  };
}
