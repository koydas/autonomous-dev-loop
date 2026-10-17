#!/usr/bin/env node
/**
 * "Commit metrics" step of validate-issue, code-generation, pr-review and auto-fix-pr (ADR-0013, ADR-0040).
 * One commit on the `metrics` branch with:
 *   - this run's metrics/runs.jsonl lines (METRICS_FILE, outside the checkout: ADR-0021);
 *   - the redacted run record metrics/runs/<YYYY-MM>/<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>.json, from
 *     observability/traces/<GITHUB_RUN_ID>.json (RUN_RECORD_TRACE overrides the path).
 * Workflow-level side effects the scripts cannot see are journaled first: RUN_RECORD_PR_OPERATION /
 * RUN_RECORD_PR_URL / RUN_RECORD_PR_NUMBER (create-pull-request outputs), RUN_RECORD_PUSH_OUTCOME.
 * Best effort, like the step it replaces: a failure is a ::warning::, exit 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { redactTrace, commitRunRecord } from './lib/run_record.mjs';

const env = process.env;
const warn = (msg) => console.log(`::warning::${msg}`);

function readRegularFile(p) {
  try {
    // Never follow a symlink planted in the checkout (ADR-0021, ADR-0023).
    if (!fs.lstatSync(p).isFile()) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

async function request(method, apiPath, body, { raw = false } = {}) {
  const base = (env.GITHUB_API_URL || 'https://api.github.com').trim();
  try {
    const res = await fetch(`${base}${apiPath}`, {
      method,
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: `Bearer ${env.GH_TOKEN || env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    if (!raw) try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: err.message };
  }
}

function journalWorkflowEffects(traceDir, runId) {
  createTracer({ runId, traceDir });
  const prNumber = Number.parseInt(env.RUN_RECORD_PR_NUMBER ?? '', 10) || null;
  if (env.RUN_RECORD_PR_OPERATION) {
    obsLog({ stage: 'workflow', event: 'workflow.pr_operation', level: 'info', meta: { prNumber, operation: env.RUN_RECORD_PR_OPERATION, url: env.RUN_RECORD_PR_URL || null } });
  }
  if (env.RUN_RECORD_PUSH_OUTCOME) {
    obsLog({ stage: 'workflow', event: 'workflow.push', level: env.RUN_RECORD_PUSH_OUTCOME === 'failure' ? 'warn' : 'info', meta: { prNumber, outcome: env.RUN_RECORD_PUSH_OUTCOME } });
  }
}

async function main() {
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  if (!repository || !runId) {
    warn('commit_run_record: GITHUB_REPOSITORY and GITHUB_RUN_ID are required; nothing committed');
    return;
  }
  const newLines = (env.METRICS_FILE && readRegularFile(env.METRICS_FILE)) || '';
  const traceDir = path.join(process.cwd(), 'observability', 'traces');
  const tracePath = env.RUN_RECORD_TRACE || path.join(traceDir, `${runId}.json`);

  // A run that wrote no trace (no-op exit before its tracer) gets no record.
  let record = null;
  if (readRegularFile(tracePath) != null) {
    if (!env.RUN_RECORD_TRACE) journalWorkflowEffects(traceDir, runId);
    try {
      record = redactTrace(JSON.parse(readRegularFile(tracePath)), { env });
    } catch (err) {
      warn(`commit_run_record: unreadable trace ${path.basename(tracePath)} (${err.name}); committing metrics only`);
    }
  }

  const result = await commitRunRecord({
    request,
    repository,
    message: env.RUN_RECORD_MESSAGE || `metrics: run ${runId} [skip ci]`,
    newLines,
    record,
  });
  if (result.indexStatus === 'unreadable') warn('commit_run_record: the trace index is unreadable; left untouched');
  if (result.committed) console.log(`Committed ${result.sha}${result.recordPath ? ` (${result.recordPath})` : ''}${result.indexPath ? ` [trace index ${result.indexPath}]` : ''}`);
  else if (result.skipped) console.log(`Nothing committed: ${result.reason}`);
  else warn(`Failed to commit metrics after 3 attempts; data may be lost (${result.reason})`);
}

main().catch((err) => warn(`commit_run_record: ${err.message}; data may be lost`));
