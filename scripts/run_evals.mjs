#!/usr/bin/env node

/**
 * Run an eval suite and report metrics.
 *
 *   node scripts/run_evals.mjs --suite validation [--repeats 3] [--concurrency 1]
 *                              [--tags edge,docs] [--limit 5] [--replay evals/results/<file>.json] [--scorecard]
 *   node scripts/run_evals.mjs --suite autofix --phase model                       (job with the API key)
 *   node scripts/run_evals.mjs --suite autofix --replay <model results> --grader-results <grader results>   (score job)
 *
 * A two-phase suite (`twoPhase`, ADR-0052) is measured in two steps: --phase model calls the provider and records what
 * the model answered (no threshold, no history), a job without secrets grades the patches (grade_autofix_eval.mjs),
 * and the replay with --grader-results scores both together and is the run that is published.
 *
 * Writes evals/results/<suite>-<runId>.json (full results, replayable; runId = EVAL_RUN_ID, else GITHUB_RUN_ID), appends one summary line to
 * EVAL_HISTORY_FILE (default evals/history.jsonl), prints a Markdown report (also to
 * GITHUB_STEP_SUMMARY when set). --scorecard also adds the run to a local preview of the eval dashboard
 * (EVAL_SITE_DIR, default evals/site; live full-dataset runs only). Exit 1 when a suite threshold fails.
 */

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SUITES } from './lib/eval_suites.mjs';
import {
  loadDataset, filterCases, runSuite, summarize, checkThresholds, formatReport, createReplayLLM,
  estimateRunTokens, checkTokenBudget,
} from './lib/eval_harness.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadLLMConfig } from './lib/config.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { buildEvalSite } from './build_eval_site.mjs';
import { attachVerdict, indexGraderResults } from './lib/autofix_eval_grading.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      suite: { type: 'string' },
      repeats: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      tags: { type: 'string', default: '' },
      limit: { type: 'string', default: '0' },
      replay: { type: 'string' },
      'out-dir': { type: 'string', default: 'evals/results' },
      scorecard: { type: 'boolean', default: false },
      phase: { type: 'string' },
      'grader-results': { type: 'string' },
    },
  });
  if (!values.suite || !SUITES[values.suite]) {
    throw new Error(`--suite is required, one of: ${Object.keys(SUITES).join(', ')}`);
  }
  const suite = SUITES[values.suite];
  if (values.phase !== undefined && values.phase !== 'model') throw new Error('--phase must be "model"');
  if (!suite.twoPhase && (values.phase || values['grader-results'])) throw new Error(`--phase and --grader-results are for two-phase suites; ${suite.name} is not one`);
  if (suite.twoPhase) {
    if (values.replay && values.phase) throw new Error('--phase model calls the provider; it cannot be combined with --replay');
    if (!values.replay && values.phase !== 'model') throw new Error(`${suite.name} is two-phase: a live run is --phase model (the patches are graded in another job, then scored with --replay <model results> --grader-results <grader results>)`);
    if (values.replay && !values['grader-results']) throw new Error(`${suite.name} is two-phase: scoring a recording needs --grader-results`);
    if (values.phase && values.scorecard) throw new Error('--scorecard records scored runs only; it cannot be combined with --phase model');
  }
  if (values['grader-results'] && !values.replay) throw new Error('--grader-results scores a recording: it needs --replay');
  if (values.scorecard && values.replay) throw new Error('--scorecard records live runs only; it cannot be combined with --replay');
  if (values.scorecard && (values.tags || values.limit !== '0')) {
    throw new Error('--scorecard records full-dataset runs only; it cannot be combined with --tags or --limit');
  }
  const toInt = (name, min) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`);
    return n;
  };
  const tags = values.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const limit = toInt('limit', 0);
  return {
    suite,
    phase: values.phase ?? null,
    graderResultsFile: values['grader-results'],
    repeats: values.repeats === undefined ? 1 : toInt('repeats', 1),
    repeatsExplicit: values.repeats !== undefined,
    concurrency: toInt('concurrency', 1),
    limit,
    tags,
    // A filtered run is exploratory: a class it leaves out cannot fail the gate.
    filtered: tags.length > 0 || limit > 0,
    replay: values.replay,
    outDir: values['out-dir'],
    scorecard: values.scorecard,
  };
}

// A replay re-scores the recording as it was run: its repeat count wins unless an explicit one disagrees.
export function resolveReplayRepeats(recordedMeta, { repeats, repeatsExplicit }) {
  const recordedRepeats = recordedMeta?.repeats ?? 1;
  if (repeatsExplicit && repeats !== recordedRepeats) {
    throw new Error(`--repeats ${repeats} does not match the recording (${recordedRepeats} repeats); omit --repeats to replay it as recorded`);
  }
  return recordedRepeats;
}

// callLLM args of one live eval call: the production stage's call (suite.llmCall), pinned to the primary.
export function liveCallArgs(suite, config, { prompt, systemPrompt }) {
  const { configKeys, options } = suite.llmCall;
  const fromConfig = Object.fromEntries(configKeys.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]));
  return { ...fromConfig, ...options, stage: suite.stage, prompt, systemPrompt, fallback: false };
}

// Pinned to the primary (ADR-0032 amendment): a fallback answer would be published as meta.model's.
// A primary failure is a run error; a quota one trips the circuit breaker.
export function createLiveLLM(suite, config) {
  return async ({ prompt, systemPrompt }) => {
    let answer = {};
    const text = await callLLM({ ...liveCallArgs(suite, config, { prompt, systemPrompt }), onAnswer: (a) => { answer = a; } });
    return { text, ...answer };
  };
}

// evals.yml workflow_dispatch inputs anthropic_model / anthropic_effort, for one run (never on schedule): applied as
// ANTHROPIC_MODEL / ANTHROPIC_EFFORT so loadLLMConfig validates them as production would. Returns the overrides set.
export function applyEvalOverrides(env = process.env) {
  const model = env.EVAL_ANTHROPIC_MODEL?.trim() || null;
  const effort = env.EVAL_ANTHROPIC_EFFORT?.trim().toLowerCase() || null;
  if (model) env.ANTHROPIC_MODEL = model;
  if (effort) env.ANTHROPIC_EFFORT = effort;
  return { model, effort };
}

// meta.model of a live run. An effort override is part of it (`+effort=<level>`): the history is per suite and
// meta.model (ADR-0032 amendment), so a run at another effort never lands in the baseline's history.
export function liveModelId(config, overrides = {}) {
  const effort = overrides.effort ? `+effort=${config.reasoningEffort ?? 'off'}` : '';
  return `${config.provider}:${config.model}${effort}`;
}

export async function buildLLM(suite, replayFile) {
  if (replayFile) {
    const recorded = JSON.parse(await fs.readFile(replayFile, 'utf8'));
    return { llmFor: createReplayLLM(recorded.results), model: `replay:${recorded.meta?.model ?? 'unknown'}`, temperature: recorded.meta?.temperature, recorded };
  }
  const overrides = applyEvalOverrides();
  const config = loadLLMConfig(suite.stage);
  if ((overrides.model || overrides.effort) && config.provider !== 'anthropic') {
    throw new Error(`EVAL_ANTHROPIC_MODEL / EVAL_ANTHROPIC_EFFORT set, but the ${suite.stage} stage runs on ${config.provider}: dispatch with provider anthropic`);
  }
  const live = createLiveLLM(suite, config);
  return { llmFor: () => live, model: liveModelId(config, overrides), temperature: config.temperature ?? null };
}

async function readHistory(file) {
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  return content.split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

// Single ::error:: (eval.error) for a run the circuit breaker cut short. Never a silent pass.
export function circuitBreakerMessage(cb, { suite, nRuns }) {
  const usage = cb.limit ? ` (limit ${cb.limit}, used ${cb.used ?? '?'})` : '';
  const retry = cb.retry_after ? `retry after ${cb.retry_after}` : 'retry after: not given by the provider';
  return `Eval ${suite} aborted by the circuit breaker: ${cb.provider} quota "${cb.quota}" exhausted${usage}; ${retry}. `
    + `${nRuns - cb.skipped_runs}/${nRuns} runs executed, ${cb.skipped_runs} skipped. Provider failure: the run is not published.`;
}

// The suite with the grader job's verdicts joined to each run's output (autofix_eval_grading.attachVerdict).
export function withGraderResults(suite, graderResults) {
  const index = indexGraderResults(graderResults);
  return { ...suite, run: async (input, ctx) => attachVerdict(await suite.run(input, ctx), index, { caseId: ctx.testCase.id, repeat: ctx.repeat }) };
}

// --phase model: what the model answered, for the grader job. Nothing is scored here (the verdicts are not in yet), so no
// threshold, no history line and no report: the scored run is the replay with --grader-results. A circuit-breaker run
// is still a failure of the job.
export async function recordModelPhase({ suite, opts, results, summary, meta, tracer, startMs }) {
  await fs.mkdir(opts.outDir, { recursive: true });
  const resultsFile = path.join(opts.outDir, `${suite.name}-${meta.run_id}.json`);
  await fs.writeFile(resultsFile, JSON.stringify({ meta: { ...meta, suite: suite.name, phase: 'model' }, summary, failures: [], results }, null, 2));
  const duration_ms = Date.now() - startMs;
  const line = `Eval ${suite.name} (model phase): ${results.length} runs recorded in ${resultsFile}, ${results.filter((r) => r.error).length} errored; the patches are graded and scored in the next jobs.`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (summary.circuit_breaker) {
    const error = circuitBreakerMessage(summary.circuit_breaker, { suite: suite.name, nRuns: results.length });
    process.stderr.write(`${error}\n`);
    obsLog({ stage: 'eval', event: 'eval.error', level: 'error', duration_ms, meta: { error, reason: 'provider_quota', ...summary.circuit_breaker, resultsFile } });
    tracer.endSpan('eval', { outcome: 'failed', meta: { reason: 'provider_quota' } });
    await tracer.finalize('failed');
    process.exitCode = 1;
    return;
  }
  obsLog({ stage: 'eval', event: 'eval.complete', duration_ms, meta: { suite: suite.name, phase: 'model', resultsFile } });
  tracer.endSpan('eval', { outcome: 'success', meta: { phase: 'model' } });
  await tracer.finalize('success');
}

// The recording of a --phase model run, replayed to be scored with the grader's verdicts: unlike a re-score, the run
// reports the model that answered (not `replay:<model>`), and only a model-phase recording is accepted.
export async function buildScoringLLM(replayFile) {
  const recorded = JSON.parse(await fs.readFile(replayFile, 'utf8'));
  if (recorded.meta?.phase !== 'model') throw new Error(`${replayFile} is not the results of a --phase model run (meta.phase)`);
  return { llmFor: createReplayLLM(recorded.results), model: recorded.meta.model ?? 'unknown', temperature: recorded.meta.temperature, recorded };
}

// A scoring replay is instant: the published latency must be the model phase's. Durations of the runs and latencies of
// their calls come back from the recording (a run whose calls do not line up with the recording keeps its own).
export function restoreRecordedTiming(results, recordedResults) {
  const byKey = new Map(recordedResults.map((r) => [`${r.case_id}#${r.repeat}`, r]));
  return results.map((r) => {
    const rec = byKey.get(`${r.case_id}#${r.repeat}`);
    if (!rec || typeof rec.duration_ms !== 'number') return r;
    const aligned = Array.isArray(rec.calls) && rec.calls.length === r.calls.length;
    return { ...r, duration_ms: rec.duration_ms, calls: aligned ? r.calls.map((c, i) => ({ ...c, latency_ms: rec.calls[i].latency_ms ?? c.latency_ms })) : r.calls };
  });
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const { suite: registered } = opts;
  const suite = opts.graderResultsFile
    ? withGraderResults(registered, JSON.parse(await fs.readFile(opts.graderResultsFile, 'utf8')))
    : registered;
  const workflowRunId = process.env.GITHUB_RUN_ID;
  const traceRunId = workflowRunId ?? `local-${Date.now()}`;
  // EVAL_RUN_ID keys the results (dashboard runs/<id>.json): one per suite when a workflow run evaluates several.
  const runId = process.env.EVAL_RUN_ID || traceRunId;
  const startMs = Date.now();
  const tracer = createTracer({ runId: traceRunId, traceDir: path.join(process.cwd(), 'observability', 'traces') });

  const historyFile = process.env.EVAL_HISTORY_FILE ?? 'evals/history.jsonl';
  // eval.start carries the token estimate, which needs the dataset: a failure before it still logs a start.
  let started = false;
  const logStart = (extra = {}) => {
    started = true;
    obsLog({ stage: 'eval', event: 'eval.start', meta: { suite: suite.name, repeats: opts.repeats, replay: Boolean(opts.replay), ...extra } });
  };
  tracer.startSpan('eval', { suite: suite.name });

  try {
    const datasetPath = path.resolve(REPO_ROOT, suite.dataset);
    const datasetSha256 = createHash('sha256').update(await fs.readFile(datasetPath)).digest('hex');
    const cases = filterCases(await loadDataset(datasetPath), opts);
    // A replay calls no provider; its repeat count comes from the recording, read below.
    const estimate = opts.replay
      ? { tokens: 0, per_run: 0, source: 'replay' }
      : estimateRunTokens({ suite, nRuns: cases.length * opts.repeats, history: await readHistory(historyFile) });
    logStart({ cases: cases.length, tokens_est: estimate.tokens, tokens_est_per_run: estimate.per_run, tokens_est_source: estimate.source });
    const refusal = opts.replay ? null : checkTokenBudget(estimate, process.env.EVAL_TOKEN_BUDGET);
    if (refusal) throw new Error(`Eval ${suite.name} refused before any LLM call: ${refusal}`);
    const { llmFor, model, temperature, recorded: replayed } = await (opts.graderResultsFile ? buildScoringLLM(opts.replay) : buildLLM(suite, opts.replay));
    if (replayed) opts.repeats = resolveReplayRepeats(replayed.meta, opts);

    const scored = await runSuite({
      suite, cases, llmFor, repeats: opts.repeats, concurrency: opts.concurrency,
      onResult: (r) => process.stderr.write(`${r.error ? '!' : Object.values(r.scores).every((v) => v == null || v === 1) ? '.' : 'x'}`),
    });
    process.stderr.write('\n');
    const results = opts.graderResultsFile ? restoreRecordedTiming(scored, replayed.results) : scored;

    if (replayed) {
      const ran = new Set(results.map((r) => `${r.case_id}#${r.repeat}`));
      const unused = replayed.results.filter((r) => !ran.has(`${r.case_id}#${r.repeat}`));
      if (unused.length) process.stderr.write(`Warning: ${unused.length} recorded run(s) not replayed (filtered out or no longer in the dataset)\n`);
    }

    const summary = summarize(results);
    if (opts.phase === 'model') {
      await recordModelPhase({ suite, opts, results, summary, meta: { run_id: runId, ...(workflowRunId ? { workflow_run_id: workflowRunId } : {}), ts: new Date().toISOString(), model, temperature, repeats: opts.repeats, dataset: suite.dataset, dataset_sha256: datasetSha256 }, tracer, startMs });
      return;
    }
    const thresholdResults = checkThresholds(summary, suite.thresholds);
    const failures = opts.filtered ? thresholdResults.filter((f) => f.value != null) : thresholdResults;
    for (const f of thresholdResults.filter((x) => !failures.includes(x))) {
      process.stderr.write(`Warning: threshold ${f.metric} skipped on a filtered run (${f.reason})\n`);
    }
    const meta = {
      run_id: runId, ...(workflowRunId ? { workflow_run_id: workflowRunId } : {}),
      ts: new Date().toISOString(), model, temperature, repeats: opts.repeats, dataset: suite.dataset, dataset_sha256: datasetSha256,
    };
    const report = formatReport({ suite: suite.name, summary, failures, results, meta });

    await fs.mkdir(opts.outDir, { recursive: true });
    const resultsFile = path.join(opts.outDir, `${suite.name}-${runId}.json`);
    const recorded = { meta: { ...meta, suite: suite.name }, summary, failures, results };
    await fs.writeFile(resultsFile, JSON.stringify(recorded, null, 2));
    if (opts.scorecard) {
      const siteDir = process.env.EVAL_SITE_DIR ?? 'evals/site';
      await buildEvalSite({ outDir: siteDir, previousDir: siteDir, resultFiles: [resultsFile], log: (m) => process.stderr.write(`${m}\n`) });
    }

    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.appendFile(historyFile, JSON.stringify({
      suite: suite.name, ...meta, passed: failures.length === 0, summary,
    }) + '\n');

    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report + '\n');

    const duration_ms = Date.now() - startMs;
    if (summary.circuit_breaker) {
      const error = circuitBreakerMessage(summary.circuit_breaker, { suite: suite.name, nRuns: results.length });
      process.stderr.write(`${error}\n`);
      obsLog({ stage: 'eval', event: 'eval.error', level: 'error', duration_ms, meta: { error, reason: 'provider_quota', ...summary.circuit_breaker, resultsFile } });
      tracer.endSpan('eval', { outcome: 'failed', meta: { reason: 'provider_quota' } });
      await tracer.finalize('failed');
      process.exitCode = 1;
      return;
    }
    obsLog({ stage: 'eval', event: 'eval.complete', duration_ms, meta: { suite: suite.name, passed: failures.length === 0, resultsFile } });
    tracer.endSpan('eval', { outcome: failures.length ? 'failed' : 'success', meta: { failures: failures.length } });
    await tracer.finalize(failures.length ? 'failed' : 'success');
    if (failures.length) process.exitCode = 1;
  } catch (err) {
    if (!started) logStart();
    obsLog({ stage: 'eval', event: 'eval.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('eval', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
