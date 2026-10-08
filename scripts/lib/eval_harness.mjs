/**
 * Eval harness — runs a suite over a dataset and turns outcomes into metrics.
 *
 * A suite is a plain object (see eval_suites.mjs):
 *   { name, stage, dataset, run(input, { llm }), scorers, label?, expectedLabel?, thresholds? }
 *
 * A scorer is (expected, output, { error, calls }) → number in [0,1] | boolean | null (not applicable).
 *
 * The LLM is injected as `llm({ prompt, systemPrompt }) → string`. The harness wraps
 * it to record every call (latency, estimated tokens, raw response), which makes a
 * run replayable: re-scoring a recorded run costs no LLM call (createReplayLLM).
 */

import fs from 'node:fs/promises';
import { estimateTokens } from './metrics.mjs';

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export function parseDataset(content, source = 'dataset') {
  const cases = [];
  const ids = new Set();
  content.split('\n').forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('//')) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      throw new Error(`${source}:${i + 1}: invalid JSON`, { cause: err });
    }
    if (typeof entry.id !== 'string' || !entry.id) throw new Error(`${source}:${i + 1}: missing string "id"`);
    if (ids.has(entry.id)) throw new Error(`${source}:${i + 1}: duplicate id "${entry.id}"`);
    if (entry.input == null) throw new Error(`${source}:${i + 1}: missing "input"`);
    if (entry.expected == null) throw new Error(`${source}:${i + 1}: missing "expected"`);
    ids.add(entry.id);
    cases.push({ tags: [], ...entry });
  });
  if (cases.length === 0) throw new Error(`${source}: no cases`);
  return cases;
}

export async function loadDataset(file) {
  return parseDataset(await fs.readFile(file, 'utf8'), file);
}

export function filterCases(cases, { tags = [], limit } = {}) {
  const tagged = tags.length ? cases.filter((c) => tags.some((t) => c.tags.includes(t))) : cases;
  return limit > 0 ? tagged.slice(0, limit) : tagged;
}

// ---------------------------------------------------------------------------
// LLM wrappers
// ---------------------------------------------------------------------------

export function createRecordingLLM(llm, { now = Date.now } = {}) {
  return async (args) => {
    const startedAt = now();
    const raw = await llm(args);
    return { raw, latency_ms: now() - startedAt };
  };
}

// recorded: results[] of a previous run. Calls are served per (case_id, repeat) in order.
// Once a run's calls are exhausted, its recorded error (e.g. a provider 429) is rethrown.
export function createReplayLLM(recorded) {
  const queues = new Map();
  for (const r of recorded) {
    queues.set(`${r.case_id}#${r.repeat}`, { raws: (r.calls ?? []).map((c) => c.raw), error: r.error ?? null });
  }
  return (key) => async () => {
    const entry = queues.get(key);
    if (!entry || entry.raws.length === 0) throw new Error(entry?.error ?? `Replay: no recorded call left for ${key}`);
    return entry.raws.shift();
  };
}

// ---------------------------------------------------------------------------
// Circuit breaker — provider quota
// ---------------------------------------------------------------------------

// Groq daily quotas (TPD / RPD) do not roll within a run: every further call fails the same way and
// spends the budget the production pipeline shares. Matched on the provider's message.
const DAILY_QUOTA = /\b(tokens|requests) per day \((TPD|RPD)\)/i;

// err: what the LLM threw. Returns { provider, quota, limit, used, retry_after, message } when no
// further call of this run can succeed (a daily quota, or every provider refused with 401/403/429),
// else null. err.providerErrors (llm_client.mjs) carries per-provider statuses; a bare message
// (replay) is matched on its text only.
export function detectQuotaExhaustion(err) {
  const message = String(err?.message ?? err ?? '');
  const daily = message.match(DAILY_QUOTA);
  const retryAfter = message.match(/try again in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i)?.[1] || null;
  if (daily) {
    return {
      provider: /groq/i.test(message) ? 'groq' : 'unknown',
      quota: `${daily[1].toLowerCase()} per day (${daily[2].toUpperCase()})`,
      limit: Number(message.match(/Limit (\d+)/)?.[1] ?? NaN) || null,
      used: Number(message.match(/Used (\d+)/)?.[1] ?? NaN) || null,
      retry_after: retryAfter,
      message,
    };
  }
  const providers = Array.isArray(err?.providerErrors) ? err.providerErrors : [];
  if (providers.length && providers.every((p) => [401, 403, 429].includes(p.status))) {
    return {
      provider: providers.map((p) => p.provider).join('+'),
      quota: `every provider refused (${providers.map((p) => `${p.provider} ${p.status}`).join(', ')})`,
      limit: null,
      used: null,
      retry_after: retryAfter,
      message,
    };
  }
  return null;
}

// Expected LLM tokens of a live run: runs × tokens per run, from the newest recorded run of the suite
// without errors (history entries, oldest first, as appended to EVAL_HISTORY_FILE), else from the
// suite's static tokensPerRunEst. history tokens_est are chars/4: they undercount real usage.
export function estimateRunTokens({ suite, nRuns, history = [] }) {
  const last = [...history].reverse().find((h) => h?.suite === suite.name && h.summary?.n_runs > 0
    && h.summary.error_rate === 0 && h.summary.tokens_est && !String(h.model ?? '').startsWith('replay:'));
  if (last) {
    const perRun = Math.ceil((last.summary.tokens_est.in + last.summary.tokens_est.out) / last.summary.n_runs);
    return { tokens: perRun * nRuns, per_run: perRun, source: `history:${last.run_id ?? 'unknown'}` };
  }
  if (Number.isFinite(suite.tokensPerRunEst) && suite.tokensPerRunEst > 0) {
    return { tokens: suite.tokensPerRunEst * nRuns, per_run: suite.tokensPerRunEst, source: 'static' };
  }
  return { tokens: null, per_run: null, source: 'unknown' };
}

// budget: raw EVAL_TOKEN_BUDGET (unset/empty = no budget). Returns null when the run may start, else
// the refusal reason. An unknown estimate under a budget is refused: the budget cannot be verified.
export function checkTokenBudget(estimate, budget) {
  if (budget == null || String(budget).trim() === '') return null;
  const max = Number(budget);
  if (!Number.isInteger(max) || max <= 0) return `EVAL_TOKEN_BUDGET must be a positive integer, got "${budget}"`;
  if (estimate.tokens == null) return `EVAL_TOKEN_BUDGET=${max} set but no token estimate for this suite`;
  if (estimate.tokens > max) return `estimated ${estimate.tokens} tokens (${estimate.per_run}/run, ${estimate.source}) exceeds EVAL_TOKEN_BUDGET=${max}`;
  return null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runOne(suite, testCase, repeat, llmFor, now, onQuota = () => {}) {
  const calls = [];
  let quota = null;
  const recording = createRecordingLLM(llmFor(`${testCase.id}#${repeat}`), { now });
  const llm = async (args) => {
    let recorded;
    try {
      recorded = await recording(args);
    } catch (err) {
      quota = detectQuotaExhaustion(err);
      if (quota) onQuota(quota);
      throw err;
    }
    const { raw, latency_ms } = recorded;
    calls.push({
      raw,
      latency_ms,
      tokens_in_est: estimateTokens(`${args.systemPrompt ?? ''}${args.prompt ?? ''}`),
      tokens_out_est: estimateTokens(raw),
    });
    return raw;
  };

  const startedAt = now();
  let output = null;
  let error = null;
  try {
    output = await suite.run(testCase.input, { llm });
  } catch (err) {
    error = err.message;
  }
  // A stage that swallows the LLM error (fallback output) still ran without the model.
  if (quota && !error) error = quota.message;

  const scores = {};
  for (const [name, scorer] of Object.entries(suite.scorers)) {
    // A run that errored scores 0 on every scorer that applies; null = not applicable.
    const value = scorer(testCase.expected, output, { error, calls });
    scores[name] = value == null ? null : error ? 0 : Number(value);
  }

  return {
    case_id: testCase.id,
    tags: testCase.tags,
    repeat,
    duration_ms: now() - startedAt,
    error,
    output,
    label: !error && suite.label ? suite.label(output) : null,
    expected_label: suite.expectedLabel ? suite.expectedLabel(testCase.expected) : null,
    scores,
    calls,
    ...(quota ? { circuit_breaker: quota } : {}),
  };
}

const skippedRun = (testCase, repeat, quota) => ({
  case_id: testCase.id,
  tags: testCase.tags,
  repeat,
  duration_ms: 0,
  error: `Skipped: circuit breaker open (${quota.provider} ${quota.quota})`,
  output: null,
  label: null,
  expected_label: null,
  scores: {},
  calls: [],
  skipped: true,
});

// Sequential by default: Groq free-tier TPM (8K) rejects parallel bursts with 413/429.
// Circuit breaker: once a call fails on an exhausted quota (detectQuotaExhaustion), no further job
// starts; the rest are recorded as skipped runs (skipped: true, no call) and summarize() marks the run.
export async function runSuite({ suite, cases, llmFor, repeats = 1, concurrency = 1, now = Date.now, onResult }) {
  const jobs = [];
  for (const c of cases) for (let r = 0; r < repeats; r++) jobs.push([c, r]);

  const results = new Array(jobs.length);
  let next = 0;
  let tripped = null;
  const worker = async () => {
    while (next < jobs.length && !tripped) {
      const i = next++;
      results[i] = await runOne(suite, jobs[i][0], jobs[i][1], llmFor, now, (q) => { tripped ??= q; });
      onResult?.(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
  for (let i = next; i < jobs.length; i++) results[i] = skippedRun(jobs[i][0], jobs[i][1], tripped);
  return results;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

function round(v, digits = 4) {
  return v == null ? null : Number(v.toFixed(digits));
}

export function computeConfusion(results) {
  const matrix = {};
  for (const r of results) {
    if (r.expected_label == null) continue;
    const predicted = r.error ? '__error__' : r.label ?? '__none__';
    matrix[r.expected_label] ??= {};
    matrix[r.expected_label][predicted] = (matrix[r.expected_label][predicted] ?? 0) + 1;
  }
  return matrix;
}

// Per-class precision/recall/F1. Errored runs count as misses for their expected class.
export function perClassMetrics(confusion) {
  const classes = Object.keys(confusion);
  const out = {};
  for (const cls of classes) {
    const tp = confusion[cls]?.[cls] ?? 0;
    const fn = Object.entries(confusion[cls] ?? {}).reduce((s, [p, n]) => (p === cls ? s : s + n), 0);
    const fp = classes.reduce((s, other) => (other === cls ? s : s + (confusion[other]?.[cls] ?? 0)), 0);
    const precision = tp + fp ? tp / (tp + fp) : null;
    const recall = tp + fn ? tp / (tp + fn) : null;
    const f1 = precision != null && recall != null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
    out[cls] = { precision: round(precision), recall: round(recall), f1: round(f1), support: tp + fn };
  }
  return out;
}

// Fraction of cases whose repeats all produced the same label (pass^k-style stability).
export function computeConsistency(results) {
  const byCase = new Map();
  for (const r of results) {
    if (!byCase.has(r.case_id)) byCase.set(r.case_id, []);
    byCase.get(r.case_id).push(r.error ? '__error__' : r.label);
  }
  const multi = [...byCase.values()].filter((labels) => labels.length > 1);
  if (multi.length === 0) return null;
  return round(multi.filter((labels) => labels.every((l) => l === labels[0])).length / multi.length);
}

export function summarize(results) {
  const scoreNames = [...new Set(results.flatMap((r) => Object.keys(r.scores)))];
  const scores = {};
  for (const name of scoreNames) {
    const applicable = results.map((r) => r.scores[name]).filter((v) => v != null);
    scores[name] = { mean: round(mean(applicable)), n: applicable.length };
  }

  // A run cut short by the circuit breaker measured the provider, not the stage: error_rate 1 by
  // definition, so the error_rate gate fails and the dashboard skips it (partitionPublishable).
  const breaker = results.find((r) => r.circuit_breaker)?.circuit_breaker ?? null;
  const latencies = results.filter((r) => !r.skipped).map((r) => r.duration_ms);
  const calls = results.flatMap((r) => r.calls);
  const confusion = computeConfusion(results);

  return {
    n_cases: new Set(results.map((r) => r.case_id)).size,
    n_runs: results.length,
    error_rate: breaker ? 1 : round(results.length ? results.filter((r) => r.error).length / results.length : 0),
    scores,
    consistency: computeConsistency(results),
    confusion,
    per_class: perClassMetrics(confusion),
    latency_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    llm_calls: calls.length,
    tokens_est: {
      in: calls.reduce((s, c) => s + c.tokens_in_est, 0),
      out: calls.reduce((s, c) => s + c.tokens_out_est, 0),
    },
    ...(breaker ? {
      circuit_breaker: {
        provider: breaker.provider, quota: breaker.quota, limit: breaker.limit, used: breaker.used,
        retry_after: breaker.retry_after, skipped_runs: results.filter((r) => r.skipped).length,
      },
    } : {}),
  };
}

// thresholds: { "<dot.path into summary>": { min?, max?, optional? } }, e.g. { "scores.verdict_match.mean": { min: 0.8 } }
// optional: a metric the run did not measure (e.g. consistency with --repeats 1) is skipped instead of failing.
export function checkThresholds(summary, thresholds = {}) {
  const failures = [];
  for (const [metricPath, { min, max, optional = false }] of Object.entries(thresholds)) {
    const value = metricPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), summary);
    if (value == null && optional) continue;
    if (value == null) {
      failures.push({ metric: metricPath, value: null, reason: 'metric not available' });
    } else if (min != null && value < min) {
      failures.push({ metric: metricPath, value, reason: `${value} < min ${min}` });
    } else if (max != null && value > max) {
      failures.push({ metric: metricPath, value, reason: `${value} > max ${max}` });
    }
  }
  // A breaker-cut run fails on error_rate even for a suite without that gate: partitionPublishable keys on it.
  if (summary.circuit_breaker && !failures.some((f) => f.metric === 'error_rate')) {
    failures.push({ metric: 'error_rate', value: 1, reason: 'circuit breaker: provider quota exhausted' });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatReport({ suite, summary, failures, results, meta = {} }) {
  const lines = [`# Eval report — \`${suite}\``, ''];
  if (Object.keys(meta).length) {
    lines.push(Object.entries(meta).map(([k, v]) => `**${k}**: \`${v}\``).join(' · '), '');
  }
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| cases / runs | ${summary.n_cases} / ${summary.n_runs} |`);
  lines.push(`| error_rate | ${summary.error_rate} |`);
  for (const [name, { mean: m, n }] of Object.entries(summary.scores)) lines.push(`| scores.${name} | ${m} (n=${n}) |`);
  if (summary.consistency != null) lines.push(`| consistency | ${summary.consistency} |`);
  for (const [cls, m] of Object.entries(summary.per_class)) {
    lines.push(`| ${cls} P / R / F1 | ${m.precision} / ${m.recall} / ${m.f1} (support ${m.support}) |`);
  }
  lines.push(`| latency p50 / p95 (ms) | ${summary.latency_ms.p50} / ${summary.latency_ms.p95} |`);
  lines.push(`| llm calls · tokens in/out (est.) | ${summary.llm_calls} · ${summary.tokens_est.in} / ${summary.tokens_est.out} |`);
  lines.push('');

  const cb = summary.circuit_breaker;
  if (cb) {
    lines.push('## ⛔ Circuit breaker: provider quota exhausted', '', `\`${cb.provider}\` — ${cb.quota}${cb.limit ? ` (limit ${cb.limit}, used ${cb.used ?? '?'})` : ''}; retry after ${cb.retry_after ?? 'unknown'}. ${cb.skipped_runs} run(s) skipped. Provider failure, not a model result: error_rate is 1 and the run is not published.`, '');
  }
  lines.push(failures.length ? '## ❌ Threshold failures' : '## ✅ All thresholds met', '');
  for (const f of failures) lines.push(`- \`${f.metric}\`: ${f.reason}`);
  if (failures.length) lines.push('');

  const failing = results.filter((r) => r.error || Object.values(r.scores).some((v) => v != null && v < 1));
  if (failing.length) {
    lines.push('## Failing cases', '', '| case | repeat | expected | got | error |', '|---|---|---|---|---|');
    for (const r of failing) {
      lines.push(`| ${r.case_id} | ${r.repeat} | ${r.expected_label ?? ''} | ${r.label ?? ''} | ${r.error ?? ''} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
