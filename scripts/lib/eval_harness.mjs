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
// Runner
// ---------------------------------------------------------------------------

async function runOne(suite, testCase, repeat, llmFor, now) {
  const calls = [];
  const recording = createRecordingLLM(llmFor(`${testCase.id}#${repeat}`), { now });
  const llm = async (args) => {
    const { raw, latency_ms } = await recording(args);
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
  };
}

// Sequential by default: Groq free-tier TPM (8K) rejects parallel bursts with 413/429.
export async function runSuite({ suite, cases, llmFor, repeats = 1, concurrency = 1, now = Date.now, onResult }) {
  const jobs = [];
  for (const c of cases) for (let r = 0; r < repeats; r++) jobs.push([c, r]);

  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await runOne(suite, jobs[i][0], jobs[i][1], llmFor, now);
      onResult?.(results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
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

  const latencies = results.map((r) => r.duration_ms);
  const calls = results.flatMap((r) => r.calls);
  const confusion = computeConfusion(results);

  return {
    n_cases: new Set(results.map((r) => r.case_id)).size,
    n_runs: results.length,
    error_rate: round(results.length ? results.filter((r) => r.error).length / results.length : 0),
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
  };
}

// thresholds: { "<dot.path into summary>": { min?, max? } }, e.g. { "scores.verdict_match.mean": { min: 0.8 } }
export function checkThresholds(summary, thresholds = {}) {
  const failures = [];
  for (const [metricPath, { min, max }] of Object.entries(thresholds)) {
    const value = metricPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), summary);
    if (value == null) {
      failures.push({ metric: metricPath, value: null, reason: 'metric not available' });
    } else if (min != null && value < min) {
      failures.push({ metric: metricPath, value, reason: `${value} < min ${min}` });
    } else if (max != null && value > max) {
      failures.push({ metric: metricPath, value, reason: `${value} > max ${max}` });
    }
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
