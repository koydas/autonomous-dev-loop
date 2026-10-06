#!/usr/bin/env node

/**
 * Live eval of a PR's prompts (ADR-0030, workflow pr-evals.yml) — plan and apply.
 *
 *   node scripts/plan_pr_evals.mjs plan --pr <n> --head <git ref> --expect-sha <sha> --event <name>
 *        --actor <login> --permission <perm> --ref <github.ref> --default-branch <name> [--repeats 1|3] --out plan.json
 *   node scripts/plan_pr_evals.mjs apply --plan plan.json
 *
 * plan  (job without secrets, default-branch checkout with the PR head fetched): checks the trigger, keeps
 *       the PR's prompts/** changes and reads their contents as git blobs. Refuses a PR touching scripts/ or
 *       config/. Always writes plan.json; writes status / suites / repeats to GITHUB_OUTPUT. Exit 0 when
 *       the plan is refused or empty (the comment job reports it), 1 on an error.
 * apply (eval job, default-branch checkout): validates plan.json and writes the PR's prompts over prompts/.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  parseRepeats, checkTrigger, collectPrChanges, planPrEvals, readPromptContents, applyPlan,
} from './lib/pr_evals.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseCliArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'apply') {
    const { values } = parseArgs({ args: rest, options: { plan: { type: 'string' } } });
    if (!values.plan) throw new Error('apply: --plan is required');
    return { mode, plan: values.plan };
  }
  if (mode !== 'plan') throw new Error('Usage: plan_pr_evals.mjs plan|apply …');
  const { values } = parseArgs({
    args: rest,
    options: {
      pr: { type: 'string' },
      head: { type: 'string' },
      'expect-sha': { type: 'string', default: '' },
      event: { type: 'string' },
      actor: { type: 'string', default: '' },
      permission: { type: 'string', default: '' },
      ref: { type: 'string', default: '' },
      'default-branch': { type: 'string' },
      repeats: { type: 'string', default: '1' },
      out: { type: 'string' },
    },
  });
  for (const name of ['pr', 'head', 'event', 'default-branch', 'out']) if (!values[name]) throw new Error(`plan: --${name} is required`);
  const pr = Number(values.pr);
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`plan: --pr must be a PR number (got "${values.pr}")`);
  return {
    mode,
    pr,
    head: values.head,
    expectSha: values['expect-sha'],
    event: values.event,
    actor: values.actor,
    permission: values.permission,
    ref: values.ref,
    defaultBranch: values['default-branch'],
    repeats: parseRepeats(values.repeats),
    out: values.out,
  };
}

export function makePlan(opts, { cwd = process.cwd(), exec } = {}) {
  const { headSha, changes } = collectPrChanges({ head: opts.head, cwd, exec });
  const triggerRefusal = checkTrigger({
    eventName: opts.event, actor: opts.actor, permission: opts.permission, ref: opts.ref,
    defaultBranch: opts.defaultBranch, expectedSha: opts.expectSha, headSha,
  });
  const plan = planPrEvals({ changes, triggerRefusal, pr: opts.pr, headSha, actor: opts.actor, repeats: opts.repeats });
  return plan.status === 'run' ? readPromptContents(plan, { cwd, exec }) : plan;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const startMs = Date.now();
  const tracer = createTracer({ runId, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  obsLog({ stage: 'pr_evals', event: 'pr_evals.start', meta: { mode: opts.mode, pr: opts.pr } });
  tracer.startSpan('pr_evals', { mode: opts.mode });

  try {
    let meta;
    if (opts.mode === 'plan') {
      const plan = makePlan(opts);
      await fs.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
      await fs.writeFile(opts.out, JSON.stringify(plan, null, 2));
      if (process.env.GITHUB_OUTPUT) {
        await fs.appendFile(process.env.GITHUB_OUTPUT, `status=${plan.status}\nsuites=${plan.suites.join(' ')}\nrepeats=${plan.repeats}\n`);
      }
      process.stderr.write(`Plan: ${plan.status}${plan.reason ? ` — ${plan.reason}` : ''}; suites: ${plan.suites.join(', ') || 'none'}\n`);
      meta = { mode: 'plan', status: plan.status, suites: plan.suites, prompts: plan.prompts.map((p) => p.path) };
    } else {
      const plan = JSON.parse(await fs.readFile(opts.plan, 'utf8'));
      const applied = applyPlan(plan, { root: REPO_ROOT });
      for (const line of applied) process.stderr.write(`Applied ${line}\n`);
      meta = { mode: 'apply', applied };
    }
    const duration_ms = Date.now() - startMs;
    obsLog({ stage: 'pr_evals', event: 'pr_evals.complete', duration_ms, meta });
    tracer.endSpan('pr_evals', { outcome: 'success', meta });
    await tracer.finalize('success');
  } catch (err) {
    obsLog({ stage: 'pr_evals', event: 'pr_evals.error', level: 'error', duration_ms: Date.now() - startMs, meta: { mode: opts.mode, error: err.message } });
    tracer.endSpan('pr_evals', { outcome: 'failed', meta: { error: err.message } });
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
