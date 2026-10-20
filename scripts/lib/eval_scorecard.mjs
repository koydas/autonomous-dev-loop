/**
 * Eval scorecard — the committed record of live eval runs.
 *
 * evals/scorecard.json is the source of truth (last MAX_RUNS live runs per suite, newest first).
 * evals/SCORECARD.md and the README block between SCORECARD_START / SCORECARD_END are generated
 * from it. Replay runs are rejected: they re-score old responses and say nothing about the model.
 */

import fs from 'node:fs/promises';

export const MAX_RUNS = 10;
export const SCORECARD_START = '<!-- eval-scorecard:start -->';
export const SCORECARD_END = '<!-- eval-scorecard:end -->';

export function emptyScorecard() {
  return { version: 1, suites: {} };
}

export async function readScorecard(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.suites !== 'object' || parsed.suites === null) {
      throw new Error(`${file}: unsupported scorecard format`);
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return emptyScorecard();
    throw err;
  }
}

// Keep only what the scorecard displays: scorer means, not the full per-run results.
export function toScorecardRun({ meta, summary, failures, results }) {
  if (!meta?.suite || !meta?.run_id || !summary) throw new Error('Results file is missing meta.suite, meta.run_id or summary');
  if (String(meta.model ?? '').startsWith('replay:')) throw new Error(`Run ${meta.run_id} is a replay; only live runs go on the scorecard`);
  return {
    run_id: meta.run_id,
    ts: meta.ts ?? new Date().toISOString(),
    model: meta.model ?? 'unknown',
    repeats: meta.repeats ?? 1,
    dataset: meta.dataset ?? null,
    dataset_sha256: meta.dataset_sha256 ?? null,
    n_cases: summary.n_cases,
    n_runs: summary.n_runs,
    passed: (failures ?? []).length === 0,
    failures: (failures ?? []).map((f) => f.metric),
    scores: Object.fromEntries(Object.entries(summary.scores ?? {}).map(([k, v]) => [k, v.mean])),
    per_class: summary.per_class ?? {},
    error_rate: summary.error_rate,
    consistency: summary.consistency ?? null,
    latency_p95_ms: summary.latency_ms?.p95 ?? null,
    tokens_est: summary.tokens_est ?? null,
    cost_est: runCost({ meta, summary }),
    coverage: reviewCoverage(results),
    // n_cases / n_runs count every case run; scores, per_class and error_rate leave the known-gap cases out (ADR-0031 §7).
    ...(summary.known_gap ? {
      known_gap: {
        n_cases: summary.known_gap.n_cases,
        n_runs: summary.known_gap.n_runs,
        error_rate: summary.known_gap.error_rate,
        scores: Object.fromEntries(Object.entries(summary.known_gap.scores ?? {}).map(([k, v]) => [k, v.mean])),
      },
    } : {}),
  };
}

// USD per million tokens, list price (2026-10): the one price table (eval report and dashboard cost line).
// Groq runs on the free tier: no cost line. Any other model without an entry is reported as unpriced, never
// as free. Eval runs are priced on the harness's chars/4 estimate: input ignores the prompt cache (system
// prompt cached: over), output excludes thinking tokens (under, more so at higher effort). Read it as an
// order of magnitude, never as the bill. Pipeline calls with provider-measured usage (llm_cost.mjs) are not.
// maxPromptTokens: the price holds up to that prompt size per call (Haiku 5.5: ≤ 100K); above it, unpriced.
// cacheRead / cacheWrite: prompt-cache reads and 5-minute cache writes (1.25 × in), priced only on
// provider-measured usage (llm_cost.mjs). Haiku 5.5's cache read is assumed at 0.1 × in.
export const PRICES_USD_PER_MTOK = {
  'anthropic:claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.20, cacheWrite: 5 },
  'anthropic:claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.20, cacheWrite: 2.5 },
  'anthropic:claude-haiku-5-5': { in: 0.10, out: 0.50, cacheRead: 0.01, cacheWrite: 0.125, maxPromptTokens: 100_000 },
};
export const COST_SOURCE = 'chars/4 estimate, thinking tokens excluded';

// meta.model without the `+effort=<level>` tag an eval effort override adds (scripts/run_evals.mjs).
export const baseModel = (model) => String(model ?? '').replace(/\+effort=[a-z]+$/, '');

export function runCost({ meta, summary }) {
  const model = baseModel(meta?.model);
  const price = PRICES_USD_PER_MTOK[model];
  const tokens = summary?.tokens_est;
  if (!tokens || model.startsWith('groq:')) return null;
  const calls = summary.llm_calls ?? 0;
  if (!price) return { usd: null, per_call_usd: null, unpriced: model, source: COST_SOURCE };
  if (price.maxPromptTokens && calls && tokens.in / calls > price.maxPromptTokens) {
    return { usd: null, per_call_usd: null, unpriced: model, over_prompt_limit: price.maxPromptTokens, source: COST_SOURCE };
  }
  const usd = (tokens.in * price.in + tokens.out * price.out) / 1e6;
  return { usd: Number(usd.toFixed(4)), per_call_usd: calls ? Number((usd / calls).toFixed(4)) : null, source: COST_SOURCE };
}

// Review coverage (ADR-0038), over the runs that produced an output: share whose diff was cut to the input
// budget, share with code files cut (unreviewed_code_files), share whose verdict was WITHHELD for it.
// null for a suite whose output has no diff_truncated (validation); code_cut null for results recorded
// before ADR-0038.
export function reviewCoverage(results) {
  const outputs = (results ?? []).map((r) => r?.output).filter((o) => o && 'diff_truncated' in o);
  if (!outputs.length) return null;
  const share = (list, pred) => (list.length ? Number((list.filter(pred).length / list.length).toFixed(4)) : null);
  const withFiles = outputs.filter((o) => Array.isArray(o.unreviewed_code_files));
  return {
    n: outputs.length,
    diff_truncated: share(outputs, (o) => o.diff_truncated === true),
    code_cut: share(withFiles, (o) => o.unreviewed_code_files.length > 0),
    withheld: share(outputs, (o) => o.verdict === 'WITHHELD'),
  };
}

// Calls answered by another provider:model than meta.model (`replay:` prefix and `+effort=` tag ignored). A call without a
// recorded provider (results before ADR-0032's eval pinning) is no evidence either way.
function foreignModels(results) {
  const pinned = baseModel(String(results.meta?.model ?? '').replace(/^replay:/, ''));
  const answered = (results.results ?? []).flatMap((r) => r?.calls ?? []).filter((c) => c?.provider);
  return [...new Set(answered.map((c) => `${c.provider}:${c.model}`))].filter((m) => m !== pinned);
}

// A run that missed the error_rate threshold measured the provider (429, 401, outage),
// not the model: it is left off the scorecard so it cannot evict real history.
// A run whose calls were not all answered by meta.model mixed models (ADR-0032): never published.
export function partitionPublishable(resultsList) {
  const publishable = [];
  const skipped = [];
  for (const results of resultsList) {
    const foreign = foreignModels(results);
    if ((results.failures ?? []).some((f) => f.metric === 'error_rate')) {
      skipped.push({ run_id: results.meta?.run_id ?? null, reason: `error_rate ${results.summary?.error_rate} above threshold` });
    } else if (foreign.length) {
      skipped.push({ run_id: results.meta?.run_id ?? null, reason: `calls answered by ${foreign.join(', ')}, not meta.model ${results.meta?.model ?? 'unset'}` });
    } else {
      publishable.push(results);
    }
  }
  return { publishable, skipped };
}

// History is per suite and model (ADR-0032 amendment): a run whose meta.model differs from the suite's
// latest published run is not appended, so Δ, trend and the ADR-0031 gates never compare two models.
// The first run of a suite sets its model. Checked in order, against the history as it grows.
export function partitionByPublishedModel(scorecard, resultsList) {
  const published = Object.fromEntries(Object.entries(scorecard?.suites ?? {}).map(([suite, s]) => [suite, s.runs?.[0]?.model]));
  const publishable = [];
  const skipped = [];
  for (const results of resultsList) {
    const { suite, model, run_id: runId } = results.meta ?? {};
    const current = published[suite];
    if (current && model !== current) {
      skipped.push({ run_id: runId ?? null, kind: 'model_mismatch', reason: `model ${model ?? 'unset'} is not the ${suite} history's model ${current}; results artifact only` });
    } else {
      published[suite] ??= model;
      publishable.push(results);
    }
  }
  return { publishable, skipped };
}

// Why a run cannot start a new series (#209): replay, recorded threshold failure, any provider error, or a
// model that is not proven single. Stricter than partitionPublishable: every answered call must name its
// provider:model, so results without that evidence never reset history.
function rebaselineRefusals(results) {
  const { model } = results.meta ?? {};
  const reasons = [];
  if (!model) reasons.push('meta.model unset');
  else if (String(model).startsWith('replay:')) reasons.push('replay run');
  const failed = (results.failures ?? []).map((f) => f.metric);
  if (failed.length) reasons.push(`failed thresholds: ${failed.join(', ')}`);
  const runs = results.results ?? [];
  const errored = runs.filter((r) => r?.error || r?.skipped).length;
  if (results.summary?.error_rate !== 0 || errored || results.summary?.circuit_breaker) {
    reasons.push(`provider errors (error_rate ${results.summary?.error_rate ?? 'unset'}, ${errored} errored or skipped run(s))`);
  }
  const answered = runs.flatMap((r) => r?.calls ?? []).filter((c) => !c?.error);
  const foreign = foreignModels(results);
  if (foreign.length) reasons.push(`mixed models: calls answered by ${foreign.join(', ')}`);
  if (!answered.length) reasons.push('no answered call');
  else if (answered.some((c) => !c?.provider)) reasons.push('calls without a recorded provider: single model not proven');
  return reasons;
}

/**
 * Re-baseline (#209, ADR-0032 amendment 2026-10-19): an eligible run whose meta.model differs from the
 * suite's published model replaces that suite's history with a one-run series; other suites are untouched.
 * gate(results) → extra refusal reasons (the suite's unchanged ADR-0031 thresholds, full dataset), from the caller.
 * Returns { scorecard, rebaselined: [{ suite, run_id, old_model, new_model, displaced_run_ids }],
 * noops: [{ suite, run_id, reason }], refused: [{ suite, run_id, model, current, reasons }] }.
 * A same-model run, a suite without a published series and a suite without a run in the batch are no-ops.
 * One re-baseline per suite per batch: a later run on yet another model is refused.
 */
export function rebaselineScorecard(scorecard, resultsList, { gate = () => [] } = {}) {
  const suites = { ...(scorecard?.suites ?? {}) };
  const rebaselined = [];
  const noops = [];
  const refused = [];
  const done = new Map();
  for (const results of resultsList) {
    const { suite, model, run_id: runId = null } = results.meta ?? {};
    const current = suites[suite]?.runs?.[0]?.model;
    if (!current) {
      noops.push({ suite: suite ?? null, run_id: runId, reason: `no published ${suite ?? '(unset suite)'} series to replace` });
    } else if (model === current) {
      noops.push({ suite, run_id: runId, reason: `same model ${model} as the published series` });
    } else if (done.has(suite)) {
      refused.push({ suite, run_id: runId, model, current, reasons: [`${suite} already re-baselined by run ${done.get(suite)} in this build`] });
    } else {
      const reasons = [...rebaselineRefusals(results), ...gate(results)];
      if (reasons.length) {
        refused.push({ suite, run_id: runId, model, current, reasons });
      } else {
        rebaselined.push({ suite, run_id: runId, old_model: current, new_model: model, displaced_run_ids: suites[suite].runs.map((r) => r.run_id) });
        suites[suite] = { runs: [toScorecardRun(results)] };
        done.set(suite, runId);
      }
    }
  }
  const ran = new Set(resultsList.map((r) => r.meta?.suite));
  for (const suite of Object.keys(scorecard?.suites ?? {})) {
    if (!ran.has(suite)) noops.push({ suite, run_id: null, reason: `no ${suite} run in this build` });
  }
  return { scorecard: { ...scorecard, suites }, rebaselined, noops, refused };
}

// Returns a new scorecard; a run_id already present is replaced, not duplicated.
export function addRun(scorecard, suite, run) {
  const previous = scorecard.suites[suite]?.runs ?? [];
  const runs = [run, ...previous.filter((r) => r.run_id !== run.run_id)]
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, MAX_RUNS);
  return { ...scorecard, suites: { ...scorecard.suites, [suite]: { runs } } };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmt = (v) => (v == null ? '—' : String(v));
const day = (ts) => ts.slice(0, 10);
const gate = (run) => (run.passed ? '✅ pass' : `❌ fail (${run.failures.join(', ')})`);

export function formatDelta(current, previous) {
  if (current == null || previous == null) return '';
  const d = Number((current - previous).toFixed(4));
  if (d === 0) return ' (=)';
  return d > 0 ? ` (▲ ${d})` : ` (▼ ${Math.abs(d)})`;
}

export const formatCost = (c) => {
  if (!c) return '—';
  if (c.over_prompt_limit) return `unpriced (\`${c.unpriced}\` list price holds up to ${c.over_prompt_limit} prompt tokens per call)`;
  if (c.unpriced) return `unpriced (\`${c.unpriced}\` not in PRICES_USD_PER_MTOK)`;
  return c.per_call_usd == null ? `$${c.usd}` : `$${c.usd} ($${c.per_call_usd} per call)`;
};
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
export const formatCoverage = (c) => (c ? `${pct(c.diff_truncated)} / ${pct(c.code_cut)} / ${pct(c.withheld)} (n=${c.n})` : '—');

function headline(run) {
  return Object.entries(run.scores).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ');
}

// Compact block for README.md: one row per suite, latest run.
export function formatReadmeBlock(scorecard) {
  const suites = Object.entries(scorecard.suites).filter(([, s]) => s.runs.length);
  if (suites.length === 0) {
    return '_No live eval run recorded yet — see [evals/SCORECARD.md](evals/SCORECARD.md) for how to record one._';
  }
  const lines = ['| Suite | Last run | Model | Scores | Error rate | Gate |', '|---|---|---|---|---|---|'];
  for (const [name, { runs: [run] }] of suites) {
    lines.push(`| \`${name}\` | ${day(run.ts)} | \`${run.model}\` | ${headline(run)} | ${fmt(run.error_rate)} | ${gate(run)} |`);
  }
  lines.push('', 'Details, per-class metrics and history: [evals/SCORECARD.md](evals/SCORECARD.md).');
  return lines.join('\n');
}

export function formatScorecard(scorecard) {
  const lines = [
    '# Eval scorecard',
    '',
    '> Generated by `scripts/update_scorecard.mjs` from `evals/scorecard.json` — do not edit by hand.',
    '> Live runs only (replays and runs that failed on error_rate are left out). Δ is against the previous recorded run of the same suite on the same dataset.',
    '',
  ];
  const suites = Object.entries(scorecard.suites).filter(([, s]) => s.runs.length);
  if (suites.length === 0) {
    lines.push('_No live eval run recorded yet._', '');
  }
  for (const [name, { runs }] of suites) {
    const [run, last] = runs;
    // Δ only compares runs on the same dataset content: a label fix is not a model change.
    const prev = last && (last.dataset_sha256 ?? null) === (run.dataset_sha256 ?? null) ? last : null;
    const datasetTag = run.dataset_sha256 ? ` · dataset \`${run.dataset_sha256.slice(0, 12)}\`` : '';
    lines.push(`## \`${name}\``, '');
    lines.push(`Last run **${day(run.ts)}** · model \`${run.model}\` · run \`${run.run_id}\` · ${run.n_cases} cases × ${run.repeats} repeats${datasetTag} · ${gate(run)}`, '');
    if (last && !prev) lines.push('> Δ not shown: the dataset changed since the previous run.', '');
    lines.push('| Metric | Value |', '|---|---|');
    for (const [k, v] of Object.entries(run.scores)) lines.push(`| ${k} | ${fmt(v)}${formatDelta(v, prev?.scores?.[k])} |`);
    for (const [cls, m] of Object.entries(run.per_class)) {
      const p = prev?.per_class?.[cls];
      lines.push(`| \`${cls}\` precision / recall / F1 | ${fmt(m.precision)} / ${fmt(m.recall)}${formatDelta(m.recall, p?.recall)} / ${fmt(m.f1)} (support ${m.support}) |`);
    }
    lines.push(`| error_rate | ${fmt(run.error_rate)}${formatDelta(run.error_rate, prev?.error_rate)} |`);
    lines.push(`| consistency | ${fmt(run.consistency)} |`);
    lines.push(`| latency p95 (ms) | ${fmt(run.latency_p95_ms)} |`);
    if (run.tokens_est) lines.push(`| tokens in / out (est.) | ${run.tokens_est.in} / ${run.tokens_est.out} |`);
    if (run.cost_est) lines.push(`| cost (${run.cost_est.source}) | ${formatCost(run.cost_est)} |`);
    if (run.coverage) lines.push(`| diff cut / code cut / withheld | ${formatCoverage(run.coverage)} |`);
    lines.push('');

    const scoreNames = [...new Set(runs.flatMap((r) => Object.keys(r.scores)))];
    lines.push('### History', '');
    lines.push(`| Date | Model | Run | ${scoreNames.join(' | ')} | error_rate | consistency | Gate |`);
    lines.push(`|---|---|---|${scoreNames.map(() => '---|').join('')}---|---|---|`);
    for (const r of runs) {
      lines.push(`| ${day(r.ts)} | \`${r.model}\` | \`${r.run_id}\` | ${scoreNames.map((s) => fmt(r.scores[s])).join(' | ')} | ${fmt(r.error_rate)} | ${fmt(r.consistency)} | ${r.passed ? '✅' : '❌'} |`);
    }
    lines.push('');
  }

  lines.push('## Record a run', '');
  lines.push('**Actions → Evals → Run workflow** on the default branch records the run and opens (or updates) a `chore(evals): scorecard update` PR with this file, `evals/scorecard.json` and the README block; merge it to publish (`publish` input, on by default; runs that failed on error_rate are skipped).', '');
  lines.push('Locally:', '');
  lines.push('```bash');
  lines.push('npm run eval -- --suite validation --repeats 3 --scorecard        # live run + record');
  lines.push('node scripts/update_scorecard.mjs evals/results/<suite>-<runId>.json  # record a downloaded CI artifact');
  lines.push('```', '');
  lines.push('Then commit `evals/scorecard.json`, `evals/SCORECARD.md` and `README.md`.', '');
  return lines.join('\n');
}

export function replaceReadmeBlock(readme, block) {
  const start = readme.indexOf(SCORECARD_START);
  const end = readme.indexOf(SCORECARD_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README is missing the ${SCORECARD_START} … ${SCORECARD_END} markers`);
  }
  return `${readme.slice(0, start + SCORECARD_START.length)}\n${block}\n${readme.slice(end)}`;
}

// I/O: record result files and regenerate every view. Paths are injected for tests.
export async function recordRuns(resultsList, { scorecardFile, markdownFile, readmeFile }) {
  let scorecard = await readScorecard(scorecardFile);
  for (const results of resultsList) {
    scorecard = addRun(scorecard, results.meta.suite, toScorecardRun(results));
  }
  await fs.writeFile(scorecardFile, JSON.stringify(scorecard, null, 2) + '\n');
  await fs.writeFile(markdownFile, formatScorecard(scorecard));
  const readme = await fs.readFile(readmeFile, 'utf8');
  await fs.writeFile(readmeFile, replaceReadmeBlock(readme, formatReadmeBlock(scorecard)));
  return scorecard;
}
