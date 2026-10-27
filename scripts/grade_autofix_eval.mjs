#!/usr/bin/env node

/**
 * Grader job of the `autofix` eval suite (EV-03, ADR-0052). No secret, no provider call: it reads the results file of
 * the model job as data and runs the hidden tests of the golden set against each patch, on a copy of its fixture.
 *
 *   node scripts/grade_autofix_eval.mjs --results evals/results/autofix-<runId>.json [--out evals/grader-results.json]
 *
 * Exits 0 once every run has a verdict, whatever the verdicts: scoring decides what they mean. Exits 1 only when it
 * cannot produce them (unreadable or malformed results file, golden set that does not load).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadAutofixCases } from './lib/autofix_dataset.mjs';
import { gradeModelResults } from './lib/autofix_eval_grading.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';

/** A results file is a few hundred kilobytes; a bound keeps a hostile or broken artifact from being read whole. */
export const MAX_RESULTS_FILE_BYTES = 64 * 1024 * 1024;

export function parseCliArgs(argv) {
  const { values } = parseArgs({ args: argv, options: { results: { type: 'string' }, out: { type: 'string', default: 'evals/grader-results.json' } } });
  if (!values.results) throw new Error('--results is required: the results file of the model job');
  return { results: values.results, out: values.out };
}

export async function readModelResults(file) {
  const { size } = await fs.stat(file);
  if (size > MAX_RESULTS_FILE_BYTES) throw new Error(`model results: ${file} is ${size} bytes, over the ${MAX_RESULTS_FILE_BYTES} bound`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`model results: ${file} is not valid JSON`, { cause: err });
  }
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const startMs = Date.now();
  const traceRunId = `${process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`}-eval-grader`;
  const tracer = createTracer({ runId: traceRunId, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  obsLog({ stage: 'eval_grader', event: 'eval_grader.start', meta: {} });
  tracer.startSpan('eval_grader', {});
  try {
    const modelResults = await readModelResults(opts.results);
    const graded = await gradeModelResults({ modelResults, cases: await loadAutofixCases() });
    await fs.mkdir(path.dirname(opts.out), { recursive: true });
    await fs.writeFile(opts.out, `${JSON.stringify(graded, null, 2)}\n`);
    const counts = { runs: graded.runs, graded: graded.graded, passed: graded.results.filter((r) => r.outcome === 'PASS').length, errored: graded.results.filter((r) => r.outcome === 'ERROR').length };
    obsLog({ stage: 'eval_grader', event: 'eval_grader.complete', duration_ms: Date.now() - startMs, meta: counts });
    tracer.endSpan('eval_grader', { outcome: 'success', meta: counts });
    await tracer.finalize('success');
    console.log(`Graded ${counts.graded} of ${counts.runs} runs (${counts.passed} passed, ${counts.errored} errored) -> ${opts.out}`);
  } catch (err) {
    obsLog({ stage: 'eval_grader', event: 'eval_grader.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('eval_grader', { outcome: 'failed', meta: { error: err.message } });
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
