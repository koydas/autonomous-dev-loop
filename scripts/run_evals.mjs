#!/usr/bin/env node

/**
 * Run an eval suite and report metrics.
 *
 *   node scripts/run_evals.mjs --suite validation [--repeats 3] [--concurrency 1]
 *                              [--tags edge,docs] [--limit 5] [--replay evals/results/<file>.json] [--scorecard]
 *
 * Writes evals/results/<suite>-<runId>.json (full results, replayable), appends one summary line to
 * EVAL_HISTORY_FILE (default evals/history.jsonl), prints a Markdown report (also to
 * GITHUB_STEP_SUMMARY when set). --scorecard also records the run on evals/scorecard.json, SCORECARD.md
 * and the README (live runs only). Exit 1 when a suite threshold fails.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SUITES } from './lib/eval_suites.mjs';
import {
  loadDataset, filterCases, runSuite, summarize, checkThresholds, formatReport, createReplayLLM,
} from './lib/eval_harness.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadLLMConfig } from './lib/config.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { recordRuns } from './lib/eval_scorecard.mjs';
import { SCORECARD_PATHS } from './update_scorecard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      suite: { type: 'string' },
      repeats: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '1' },
      tags: { type: 'string', default: '' },
      limit: { type: 'string', default: '0' },
      replay: { type: 'string' },
      'out-dir': { type: 'string', default: 'evals/results' },
      scorecard: { type: 'boolean', default: false },
    },
  });
  if (!values.suite || !SUITES[values.suite]) {
    throw new Error(`--suite is required, one of: ${Object.keys(SUITES).join(', ')}`);
  }
  if (values.scorecard && values.replay) throw new Error('--scorecard records live runs only; it cannot be combined with --replay');
  const toInt = (name, min) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`);
    return n;
  };
  return {
    suite: SUITES[values.suite],
    repeats: toInt('repeats', 1),
    concurrency: toInt('concurrency', 1),
    limit: toInt('limit', 0),
    tags: values.tags.split(',').map((t) => t.trim()).filter(Boolean),
    replay: values.replay,
    outDir: values['out-dir'],
    scorecard: values.scorecard,
  };
}

async function buildLLM(suite, replayFile) {
  if (replayFile) {
    const recorded = JSON.parse(await fs.readFile(replayFile, 'utf8'));
    return { llmFor: createReplayLLM(recorded.results), model: `replay:${recorded.meta?.model ?? 'unknown'}` };
  }
  const config = loadLLMConfig(suite.stage);
  const live = ({ prompt, systemPrompt }) => callLLM({ ...config, prompt, systemPrompt });
  return { llmFor: () => live, model: `${config.provider}:${config.model}` };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const { suite } = opts;
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const startMs = Date.now();
  const tracer = createTracer({ runId, traceDir: path.join(process.cwd(), 'observability', 'traces') });

  obsLog({ stage: 'eval', event: 'eval.start', meta: { suite: suite.name, repeats: opts.repeats, replay: Boolean(opts.replay) } });
  tracer.startSpan('eval', { suite: suite.name });

  try {
    const cases = filterCases(await loadDataset(path.resolve(REPO_ROOT, suite.dataset)), opts);
    const { llmFor, model } = await buildLLM(suite, opts.replay);

    const results = await runSuite({
      suite, cases, llmFor, repeats: opts.repeats, concurrency: opts.concurrency,
      onResult: (r) => process.stderr.write(`${r.error ? '!' : Object.values(r.scores).every((v) => v == null || v === 1) ? '.' : 'x'}`),
    });
    process.stderr.write('\n');

    const summary = summarize(results);
    const failures = checkThresholds(summary, suite.thresholds);
    const meta = { run_id: runId, ts: new Date().toISOString(), model, repeats: opts.repeats, dataset: suite.dataset };
    const report = formatReport({ suite: suite.name, summary, failures, results, meta });

    await fs.mkdir(opts.outDir, { recursive: true });
    const resultsFile = path.join(opts.outDir, `${suite.name}-${runId}.json`);
    const recorded = { meta: { ...meta, suite: suite.name }, summary, failures, results };
    await fs.writeFile(resultsFile, JSON.stringify(recorded, null, 2));
    if (opts.scorecard) await recordRuns([recorded], SCORECARD_PATHS);

    const historyFile = process.env.EVAL_HISTORY_FILE ?? 'evals/history.jsonl';
    await fs.mkdir(path.dirname(historyFile), { recursive: true });
    await fs.appendFile(historyFile, JSON.stringify({
      suite: suite.name, ...meta, passed: failures.length === 0, summary,
    }) + '\n');

    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report + '\n');

    const duration_ms = Date.now() - startMs;
    obsLog({ stage: 'eval', event: 'eval.complete', duration_ms, meta: { suite: suite.name, passed: failures.length === 0, resultsFile } });
    tracer.endSpan('eval', { outcome: failures.length ? 'failed' : 'success', meta: { failures: failures.length } });
    await tracer.finalize(failures.length ? 'failed' : 'success');
    if (failures.length) process.exitCode = 1;
  } catch (err) {
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
