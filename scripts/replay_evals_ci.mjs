#!/usr/bin/env node

/**
 * Replay the last published live eval run of each suite against the checked-out code (PR gate).
 *
 *   node scripts/replay_evals_ci.mjs --site-url https://<owner>.github.io/<repo> [--suite review]
 *   node scripts/replay_evals_ci.mjs --site-dir <local copy of the site> [--suite review]
 *
 * No LLM call and no secret: recorded responses are served again (ADR-0027 amendment). Prints a
 * Markdown report (also appended to GITHUB_STEP_SUMMARY when set) and GitHub annotations.
 * Exit 1 when a threshold the published run meets fails in the replay (both under the PR's thresholds),
 * or when the PR's own code cannot run the replay (a malformed dataset, a suite module that throws on
 * import or outside a case). An unreachable site, a suite without a published run, a malformed
 * published file or a changed dataset only warns (exit 0).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SUITES } from './lib/eval_suites.mjs';
import { runReplayCi, siteGetter, dirGetter } from './lib/eval_replay_ci.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'site-url': { type: 'string' },
      'site-dir': { type: 'string' },
      suite: { type: 'string', multiple: true },
    },
  });
  if (!values['site-url'] === !values['site-dir']) throw new Error('Pass exactly one of --site-url or --site-dir');
  const names = values.suite ?? Object.keys(SUITES);
  for (const n of names) if (!SUITES[n]) throw new Error(`Unknown suite "${n}", one of: ${Object.keys(SUITES).join(', ')}`);
  return { siteUrl: values['site-url'], siteDir: values['site-dir'], suites: names.map((n) => SUITES[n]) };
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const startMs = Date.now();
  const tracer = createTracer({ runId, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  obsLog({ stage: 'eval_replay', event: 'eval_replay.start', meta: { suites: opts.suites.map((s) => s.name), source: opts.siteUrl ?? opts.siteDir } });
  tracer.startSpan('eval_replay', { suites: opts.suites.map((s) => s.name) });

  try {
    const get = opts.siteUrl ? siteGetter(opts.siteUrl) : dirGetter(opts.siteDir);
    const { status, markdown, annotations, reports } = await runReplayCi({ get, suites: opts.suites, siteUrl: opts.siteUrl });

    console.log(markdown);
    for (const a of annotations) console.log(a);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');

    const duration_ms = Date.now() - startMs;
    obsLog({
      stage: 'eval_replay', event: 'eval_replay.complete', duration_ms,
      meta: { status, suites: Object.fromEntries(reports.map((r) => [r.suite, r.status])) },
    });
    tracer.endSpan('eval_replay', { outcome: status === 'fail' ? 'failed' : 'success', meta: { status } });
    await tracer.finalize(status === 'fail' ? 'failed' : 'success');
    if (status === 'fail') process.exitCode = 1;
  } catch (err) {
    obsLog({ stage: 'eval_replay', event: 'eval_replay.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('eval_replay', { outcome: 'failed', meta: { error: err.message } });
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
