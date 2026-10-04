#!/usr/bin/env node

/**
 * Run an eval suite and report metrics.
 *
 *   node scripts/run_evals.mjs --suite validation [--repeats 3] [--concurrency 1]
 *                              [--tags edge,docs] [--limit 5] [--replay evals/results/<file>.json] [--scorecard]
 *
 * Writes evals/results/<suite>-<runId>.json (full results, replayable), appends one summary line to
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
} from './lib/eval_harness.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadLLMConfig } from './lib/config.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { buildEvalSite } from './build_eval_site.mjs';

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
    },
  });
  if (!values.suite || !SUITES[values.suite]) {
    throw new Error(`--suite is required, one of: ${Object.keys(SUITES).join(', ')}`);
  }
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
    suite: SUITES[values.suite],
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

async function buildLLM(suite, replayFile) {
  if (replayFile) {
    const recorded = JSON.parse(await fs.readFile(replayFile, 'utf8'));
    return { llmFor: createReplayLLM(recorded.results), model: `replay:${recorded.meta?.model ?? 'unknown'}`, recorded };
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
    const datasetPath = path.resolve(REPO_ROOT, suite.dataset);
    const datasetSha256 = createHash('sha256').update(await fs.readFile(datasetPath)).digest('hex');
    const cases = filterCases(await loadDataset(datasetPath), opts);
    const { llmFor, model, recorded: replayed } = await buildLLM(suite, opts.replay);
    if (replayed) opts.repeats = resolveReplayRepeats(replayed.meta, opts);

    const results = await runSuite({
      suite, cases, llmFor, repeats: opts.repeats, concurrency: opts.concurrency,
      onResult: (r) => process.stderr.write(`${r.error ? '!' : Object.values(r.scores).every((v) => v == null || v === 1) ? '.' : 'x'}`),
    });
    process.stderr.write('\n');

    if (replayed) {
      const ran = new Set(results.map((r) => `${r.case_id}#${r.repeat}`));
      const unused = replayed.results.filter((r) => !ran.has(`${r.case_id}#${r.repeat}`));
      if (unused.length) process.stderr.write(`Warning: ${unused.length} recorded run(s) not replayed (filtered out or no longer in the dataset)\n`);
    }

    const summary = summarize(results);
    const thresholdResults = checkThresholds(summary, suite.thresholds);
    const failures = opts.filtered ? thresholdResults.filter((f) => f.value != null) : thresholdResults;
    for (const f of thresholdResults.filter((x) => !failures.includes(x))) {
      process.stderr.write(`Warning: threshold ${f.metric} skipped on a filtered run (${f.reason})\n`);
    }
    const meta = { run_id: runId, ts: new Date().toISOString(), model, repeats: opts.repeats, dataset: suite.dataset, dataset_sha256: datasetSha256 };
    const report = formatReport({ suite: suite.name, summary, failures, results, meta });

    await fs.mkdir(opts.outDir, { recursive: true });
    const resultsFile = path.join(opts.outDir, `${suite.name}-${runId}.json`);
    const recorded = { meta: { ...meta, suite: suite.name }, summary, failures, results };
    await fs.writeFile(resultsFile, JSON.stringify(recorded, null, 2));
    if (opts.scorecard) {
      const siteDir = process.env.EVAL_SITE_DIR ?? 'evals/site';
      await buildEvalSite({ outDir: siteDir, previousDir: siteDir, resultFiles: [resultsFile], log: (m) => process.stderr.write(`${m}\n`) });
    }

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
