#!/usr/bin/env node
/**
 * reset-auto-fix.yml (workflow_dispatch): removes the auto-fix-attempt-N labels of a PR and, with
 * RETRIGGER=true, removes then re-applies changes-requested so a fresh `labeled` event starts a new
 * auto-fix cycle. Instrumented like the other stages (ADR-0018, ADR-0040) so the run joins the trace
 * of the PR's work item (ADR-0041): the PR is read once for its head ref and closing references.
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, RETRIGGER, GITHUB_API_URL (optional), GITHUB_RUN_ID.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNestedYaml } from './lib/yaml.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { prWorkItemHint } from './lib/trace_context.mjs';

const STAGE = 'autofix_reset';

/** Attempt labels and the changes-requested label from config/labels.yaml. */
export function resetLabels(labelsYaml) {
  const labels = parseNestedYaml(labelsYaml);
  return {
    attemptLabels: [labels.autofix.attempt1.name, labels.autofix.attempt2.name, labels.autofix.attempt3.name],
    changesLabel: labels.review.changes.name,
  };
}

/**
 * The reset itself. `request(method, path, body?)` resolves `{ status, ok, json? }`; any non-404
 * failure throws. Returns `{ removed: [labels], retriggered: boolean }`.
 */
export async function resetAutoFix({ request, prNumber, retrigger, attemptLabels, changesLabel }) {
  const call = async (method, apiPath, body) => {
    const res = await request(method, apiPath, body);
    if (!res.ok && res.status !== 404) throw new Error(`GitHub API ${method} ${apiPath} → ${res.status}`);
    return res;
  };
  const pr = await call('GET', `/pulls/${prNumber}`);
  if (pr.ok) obsLog({ stage: STAGE, event: 'trace.work_item', level: 'info', meta: prWorkItemHint(pr.json) });

  const removed = [];
  for (const label of attemptLabels) {
    const res = await call('DELETE', `/issues/${prNumber}/labels/${encodeURIComponent(label)}`);
    if (res.status !== 404) removed.push(label);
  }
  obsLog({ stage: STAGE, event: 'autofix_reset.labels_removed', level: 'info', meta: { prNumber, removed_labels: removed } });

  let retriggered = false;
  if (retrigger) {
    await call('DELETE', `/issues/${prNumber}/labels/${encodeURIComponent(changesLabel)}`);
    const applied = await call('POST', `/issues/${prNumber}/labels`, { labels: [changesLabel] });
    retriggered = applied.ok;
    if (retriggered) obsLog({ stage: STAGE, event: 'autofix_reset.retriggered', level: 'info', meta: { prNumber, label: changesLabel } });
  }
  return { removed, retriggered };
}

async function loadOptions(env = process.env) {
  const prNumber = Number.parseInt(env.PR_NUMBER ?? '', 10);
  const repository = env.GITHUB_REPOSITORY;
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !repository || !env.GITHUB_TOKEN) {
    throw new Error('PR_NUMBER (positive integer), GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  }
  const base = `${(env.GITHUB_API_URL || 'https://api.github.com').trim()}/repos/${repository}`;
  const request = async (method, apiPath, body) => {
    const res = await fetch(`${base}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body (DELETE) */ }
    return { status: res.status, ok: res.ok, json };
  };
  const retrigger = env.RETRIGGER === 'true';
  const { attemptLabels, changesLabel } = resetLabels(readFileSync('config/labels.yaml', 'utf8'));
  return { prNumber, retrigger, request, attemptLabels, changesLabel };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const startMs = Date.now();
  const tracer = createTracer({ runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`, traceDir: path.join(process.cwd(), 'observability', 'traces') });
  let prNumber = null;
  try {
    const opts = await loadOptions();
    prNumber = opts.prNumber;
    obsLog({ stage: STAGE, event: 'autofix_reset.start', level: 'info', meta: { prNumber } });
    tracer.startSpan(STAGE, { prNumber });
    const { removed, retriggered } = await resetAutoFix(opts);
    console.log(`Removed ${removed.length} auto-fix-attempt label(s) from PR #${prNumber}.`);
    console.log(opts.retrigger
      ? (retriggered ? `Re-applied "${opts.changesLabel}" — new auto-fix cycle will start.` : `Could not re-apply "${opts.changesLabel}".`)
      : 'Retrigger skipped. Apply "changes-requested" manually to start a new cycle.');
    obsLog({ stage: STAGE, event: 'autofix_reset.complete', level: 'info', duration_ms: Date.now() - startMs, meta: { prNumber, retrigger: opts.retrigger } });
    tracer.endSpan(STAGE, { outcome: 'success', meta: { prNumber } });
    await tracer.finalize('success');
  } catch (err) {
    obsLog({ stage: STAGE, event: 'autofix_reset.error', level: 'error', duration_ms: Date.now() - startMs, meta: { prNumber, error: err.message } });
    tracer.endSpan(STAGE, { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}
