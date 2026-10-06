#!/usr/bin/env node

/**
 * Live eval of a PR's prompts (ADR-0030, workflow pr-evals.yml) — comparison report.
 *
 *   node scripts/report_pr_evals.mjs --plan plan.json --results-dir <dir> --out report.md
 *        [--site-url https://<owner>.github.io/<repo> | --site-dir <local copy>] [--run-url <url>]
 *
 * Runs in the comment job (no LLM secret). Compares each suite's results file (<suite>-<runId>.json,
 * written by run_evals.mjs in the eval job) with the last run published on the eval dashboard, and writes
 * the Markdown comment to --out (also to GITHUB_STEP_SUMMARY). A missing plan or results file is
 * reported, not fatal. Never publishes anything.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SUITES } from './lib/eval_suites.mjs';
import { siteGetter, dirGetter, loadPublishedRuns } from './lib/eval_replay_ci.mjs';
import { buildPrEvalReport } from './lib/pr_evals.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: 'string' },
      'results-dir': { type: 'string' },
      out: { type: 'string' },
      'site-url': { type: 'string' },
      'site-dir': { type: 'string' },
      'run-url': { type: 'string' },
    },
  });
  for (const name of ['plan', 'results-dir', 'out']) if (!values[name]) throw new Error(`--${name} is required`);
  if (!values['site-url'] === !values['site-dir']) throw new Error('Pass exactly one of --site-url or --site-dir');
  return { plan: values.plan, resultsDir: values['results-dir'], out: values.out, siteUrl: values['site-url'], siteDir: values['site-dir'], runUrl: values['run-url'] };
}

export async function readPlan(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Newest <suite>-*.json per suite anywhere under dir (artifact layout varies); a missing dir is empty.
export async function readResults(dir, suiteNames) {
  let entries;
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const out = {};
  for (const name of suiteNames) {
    const files = entries.filter((f) => path.basename(f).startsWith(`${name}-`) && f.endsWith('.json')).sort();
    if (files.length) out[name] = JSON.parse(await fs.readFile(path.join(dir, files.at(-1)), 'utf8'));
  }
  return out;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const startMs = Date.now();
  const tracer = createTracer({ runId, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  obsLog({ stage: 'pr_evals_report', event: 'pr_evals_report.start', meta: { source: opts.siteUrl ?? opts.siteDir } });
  tracer.startSpan('pr_evals_report', {});

  try {
    const plan = await readPlan(opts.plan);
    const resultsBySuite = plan?.status === 'run' ? await readResults(opts.resultsDir, plan.suites) : {};
    const get = opts.siteUrl ? siteGetter(opts.siteUrl) : dirGetter(opts.siteDir);
    const { status, markdown } = await buildPrEvalReport({
      plan, suites: SUITES, resultsBySuite, siteUrl: opts.siteUrl, runUrl: opts.runUrl,
      loadPublished: (names) => loadPublishedRuns(get, names),
    });
    await fs.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
    await fs.writeFile(opts.out, markdown + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');

    const duration_ms = Date.now() - startMs;
    obsLog({ stage: 'pr_evals_report', event: 'pr_evals_report.complete', duration_ms, meta: { status, suites: Object.keys(resultsBySuite) } });
    tracer.endSpan('pr_evals_report', { outcome: 'success', meta: { status } });
    await tracer.finalize('success');
  } catch (err) {
    obsLog({ stage: 'pr_evals_report', event: 'pr_evals_report.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('pr_evals_report', { outcome: 'failed', meta: { error: err.message } });
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
