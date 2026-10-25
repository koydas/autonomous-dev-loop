#!/usr/bin/env node
/**
 * conflicts-fix, fan-out (ADR-0059 §A): one workflow run per conflicting PR. A run record is keyed by its run id and
 * belongs to one work item (ADR-0041), so the sweep that detects the conflicts does not fix them itself: it dispatches
 * the caller workflow once per fixable PR (`pr_number`, `sweep: true`, which keeps the attempt cap and the breaker),
 * and each of those runs records its own fix. Dispatching with a workflow token is allowed to start a run.
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PRS (the JSON matrix of detect_conflicts.mjs), CALLER_WORKFLOW_FILE,
 *   DEFAULT_BRANCH, GITHUB_API_URL (optional), GITHUB_RUN_ID.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { createRequest } from './lib/conflicts_github.mjs';

const STAGE = 'conflicts_detect';
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const REF = /^[A-Za-z0-9._/@+-]+$/;

/** The PR numbers of the matrix JSON, validated: a positive integer each, no duplicate. */
export function parseMatrix(raw) {
  let list;
  try { list = JSON.parse(raw || '[]'); } catch { throw new Error('PRS is not valid JSON'); }
  if (!Array.isArray(list)) throw new Error('PRS must be a JSON array');
  const numbers = list.map((p) => p?.number);
  if (!numbers.every((n) => Number.isInteger(n) && n > 0)) throw new Error('PRS entries need a positive integer number');
  return [...new Set(numbers)];
}

/**
 * Dispatches the caller workflow for each PR; returns `{ dispatched: number[], failed: { number, status }[] }`.
 * A failure on one PR does not stop the others (the next sweep dispatches it again).
 */
export async function dispatchFixes({ request, workflowFile, ref, numbers }) {
  if (!WORKFLOW_FILE.test(workflowFile ?? '')) throw new Error('CALLER_WORKFLOW_FILE must be a workflow file name');
  if (!REF.test(ref ?? '')) throw new Error('DEFAULT_BRANCH must be a branch name');
  const dispatched = [];
  const failed = [];
  for (const number of numbers) {
    const res = await request('POST', `/actions/workflows/${workflowFile}/dispatches`, { ref, inputs: { pr_number: String(number), sweep: 'true' } });
    if (res.ok) {
      dispatched.push(number);
      obsLog({ stage: STAGE, event: 'conflicts_detect.dispatched', level: 'info', meta: { prNumber: number } });
    } else {
      failed.push({ number, status: res.status });
    }
  }
  return { dispatched, failed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const startMs = Date.now();
  const env = process.env;
  const tracer = createTracer({ runId: env.GITHUB_RUN_ID ?? `local-${Date.now()}`, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  try {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    const numbers = parseMatrix(env.PRS);
    const request = createRequest({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY, apiBase: env.GITHUB_API_URL || undefined });
    const { dispatched, failed } = await dispatchFixes({ request, workflowFile: env.CALLER_WORKFLOW_FILE, ref: env.DEFAULT_BRANCH, numbers });
    console.log(`Dispatched ${dispatched.length} fix run(s)${failed.length ? `, ${failed.length} refused (${failed.map((f) => `#${f.number}: ${f.status}`).join(', ')})` : ''}.`);
    obsLog({ stage: STAGE, event: 'conflicts_detect.dispatch_complete', level: failed.length ? 'warn' : 'info', duration_ms: Date.now() - startMs, meta: { dispatched: dispatched.length, failed: failed.length } });
    await tracer.finalize(failed.length ? 'partial' : 'success');
    if (failed.length) process.exit(1);
  } catch (err) {
    obsLog({ stage: STAGE, event: 'conflicts_detect.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    await tracer.finalize('failed');
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
