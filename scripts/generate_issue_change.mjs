#!/usr/bin/env node

import { buildDeterministicPrompt, loadConfigFromEnv, loadLLMConfig, loadLabelsConfig, validateStartup } from './lib/config.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { loadPrompt } from './lib/prompts.mjs';
import { parseJsonResponse, validateAiOutput, writeGeneratedFiles, GuardrailError } from './lib/output_writer.mjs';
import { log, error as logError } from './lib/logger.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { buildFileContext } from './lib/file_injector.mjs';
import { readPackageJsonDependencies } from './lib/dependency_manifest.mjs';
import { normalizeRepoPath } from './lib/autofix_guard.mjs';
import { findGuardrailViolations, guardrailErrorFor, guardrailRules } from './lib/static_verifier.mjs';
import { writeCheckpoint } from './lib/checkpoint.mjs';
import { appendMetric, estimateTokens } from './lib/metrics.mjs';
import { assertInputBudget } from './lib/token_budget.mjs';
import { retryWithBackoff, transientHttpError, isRetrySafeGitHubRequest } from './lib/retry.mjs';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

let tracer;

// 429/5xx are retried (ADR-0022); non-retry-safe POSTs (comments) are not replayed after a 5xx.
async function ghFetch(endpoint, options = {}) {
  const base = (process.env.GITHUB_API_URL || 'https://api.github.com').trim();
  const retrySafe = isRetrySafeGitHubRequest(options.method, endpoint);
  return retryWithBackoff(async () => {
    const res = await fetch(`${base}${endpoint}`, {
      ...options,
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const transientErr = transientHttpError(res, `GitHub API (${endpoint})`, { retrySafe });
    if (transientErr) throw transientErr;
    return res;
  });
}

// A GuardrailError (ADR-0021, ADR-0029, ADR-0019) is escalated like auto-fix does: nothing is
// written, no PR is opened, the issue gets `needs-human` and the reason, a `codegen_skip` metric
// records the rules, and the run exits 0 with `rejected=true`.
async function rejectPatch(rejection, context) {
  try {
    await escalateRejection(rejection, context);
  } catch (err) {
    // The escalation itself failed (GitHub API): still close the stage with a terminal event.
    const { stage, stageStartMs } = context;
    obsLog({ stage, event: `${stage}.error`, level: 'error', duration_ms: Date.now() - stageStartMs, meta: { error: err.message, rejection: rejection.message } });
    tracer.endSpan(stage, { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }
}

async function escalateRejection(rejection, { stage, stageStartMs, issueNumber }) {
  const rules = guardrailRules(rejection);
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
  const needsHuman = loadLabelsConfig('autofix').needs_human;
  const createRes = await ghFetch(`/repos/${owner}/${repo}/labels`, { method: 'POST', body: JSON.stringify(needsHuman) });
  if (!createRes.ok && createRes.status !== 422) throw new Error(`Label create failed for "${needsHuman.name}": ${createRes.status}`);
  const applyRes = await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { method: 'POST', body: JSON.stringify({ labels: [needsHuman.name] }) });
  if (!applyRes.ok) throw new Error(`Add label "${needsHuman.name}" failed: ${applyRes.status}`);
  const commentRes = await ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      body: `## \u{1F6E1}\u{FE0F} Code Generation: Patch Rejected\n\nThe generated patch was rejected by the output guardrails, so nothing was written and no pull request was opened. A human needs to decide (\`${needsHuman.name}\`).\n\n**Rules:** ${rules.join(', ')}\n\n**Reason:** ${String(rejection.message).slice(0, 2000)}`,
    }),
  });
  if (!commentRes.ok) throw new Error(`Rejection comment failed: ${commentRes.status}`);
  await appendMetric({
    type: 'codegen_skip',
    run_id: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}-codegen-skip` : `local-${Date.now()}`,
    issue_number: issueNumber,
    reason: 'guardrail_rejected',
    rules,
    ts: new Date().toISOString(),
  });
  obsLog({ stage, event: `${stage}.skipped`, level: 'warn', duration_ms: Date.now() - stageStartMs, meta: { reason: 'guardrail_rejected', rules, error: rejection.message } });
  tracer.endSpan(stage, { outcome: 'skipped', meta: { reason: 'guardrail_rejected', rules } });
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, 'rejected=true\n', 'utf8');
  log('Generated patch rejected by the guardrails', { rules: rules.join(', '), reason: rejection.message });
  await tracer.finalize('partial');
}

process.on('unhandledRejection', async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  await tracer?.finalize('failed');
  process.exit(1);
});

async function main() {
  const startMs = Date.now();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const traceDir = path.join(process.cwd(), 'observability', 'traces');
  tracer = createTracer({ runId, issueNumber: null, traceDir });

  validateStartup();
  const config = loadConfigFromEnv();

  obsLog({ stage: 'code_gen', event: 'code_gen.start', level: 'info', meta: { issueNumber: config.issueNumber, model: config.model } });
  tracer.startSpan('code_gen', { issueNumber: config.issueNumber, model: config.model });

  let fileContext, dependencies, prompt, systemPrompt;
  try {
    fileContext = await buildFileContext(config.issueTitle, config.issueBody, process.cwd());
    // Snapshot before the LLM call: the verified manifest is never one the patch wrote.
    dependencies = await readPackageJsonDependencies(process.cwd());
    prompt = buildDeterministicPrompt({ ...config, fileContents: fileContext.block });
    systemPrompt = loadPrompt('generation-system');
  } catch (err) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }

  const inputTokensEst = estimateTokens(systemPrompt + prompt);
  obsLog({ stage: 'code_gen', event: 'code_gen.llm_request', level: 'info', meta: { model: config.model, input_tokens_est: inputTokensEst } });
  log('Calling LLM with deterministic prompt template');

  let raw;
  try {
    // ADR-0028: an over-budget request can only end in 413, which would be retried until the job timeout.
    assertInputBudget('generation', inputTokensEst, loadLLMConfig('generation').maxInputTokens);
    raw = await callLLM({
      stage: 'generation',
      prompt,
      systemPrompt,
      apiKey: config.apiKey,
      model: config.model,
      apiUrl: config.apiUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      reasoningEffort: config.reasoningEffort,
    });
  } catch (err) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }

  obsLog({ stage: 'code_gen', event: 'code_gen.llm_response', level: 'info', meta: { output_tokens_est: estimateTokens(raw) } });

  let aiOutput;
  try {
    aiOutput = parseJsonResponse(raw);
  } catch (err) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: 'JSON parse failed', detail: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: 'JSON parse failed' } });
    await tracer.finalize('failed');
    throw new Error('AI response was not valid JSON', { cause: err });
  }
  if (!aiOutput || typeof aiOutput !== 'object' || Array.isArray(aiOutput)) {
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: 'AI response JSON must be an object' } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: 'invalid JSON shape' } });
    await tracer.finalize('failed');
    throw new Error('AI response JSON must be an object');
  }

  let summary, changes;
  try {
    ({ summary, changes } = validateAiOutput(aiOutput));
  } catch (err) {
    if (err instanceof GuardrailError) return rejectPatch(err, { stage: 'code_gen', stageStartMs: startMs, issueNumber: config.issueNumber });
    obsLog({ stage: 'code_gen', event: 'code_gen.error', level: 'error', duration_ms: Date.now() - startMs, meta: { error: err.message } });
    tracer.endSpan('code_gen', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }
  const codeGenMs = Date.now() - startMs;
  obsLog({ stage: 'code_gen', event: 'code_gen.complete', level: 'info', duration_ms: codeGenMs, meta: { changes_count: changes.length } });
  tracer.endSpan('code_gen', { outcome: 'success', meta: { changes_count: changes.length } });

  // PR prepare stage: write files to disk (the GitHub Action step creates the actual PR)
  const prPrepareStartMs = Date.now();
  obsLog({ stage: 'pr_prepare', event: 'pr_prepare.start', level: 'info', meta: { changes_count: changes.length } });
  tracer.startSpan('pr_prepare', { changes_count: changes.length });

  let outputPaths;
  try {
    const existing = new Map();
    for (const { targetPath } of changes) {
      const key = normalizeRepoPath(targetPath);
      try {
        existing.set(key, await fs.readFile(key, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        existing.set(key, null);
      }
    }
    const violations = findGuardrailViolations(changes, {
      existing,
      shownPaths: fileContext.shownPaths,
      hiddenPaths: fileContext.hiddenPaths,
      dependencies,
      fileExists: (p) => existsSync(p),
      mentionText: `${config.issueTitle}\n${config.issueBody}`,
    });
    if (violations.length) throw guardrailErrorFor(violations);
    outputPaths = await writeGeneratedFiles(changes);
  } catch (err) {
    if (err instanceof GuardrailError) return rejectPatch(err, { stage: 'pr_prepare', stageStartMs: prPrepareStartMs, issueNumber: config.issueNumber });
    obsLog({ stage: 'pr_prepare', event: 'pr_prepare.error', level: 'error', duration_ms: Date.now() - prPrepareStartMs, meta: { error: err.message } });
    tracer.endSpan('pr_prepare', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }

  obsLog({ stage: 'pr_prepare', event: 'pr_prepare.complete', level: 'info', duration_ms: Date.now() - prPrepareStartMs, meta: { paths: outputPaths } });
  tracer.endSpan('pr_prepare', { outcome: 'success', meta: { paths: outputPaths } });

  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `summary<<EOF\n${summary}\nEOF\ngenerated_paths<<EOF\n${outputPaths.join('\n')}\nEOF\n`,
      'utf8',
    );
  }

  log('Wrote generated changes', { paths: outputPaths.join(', ') });
  log('Exported workflow outputs: summary, generated_paths');

  const cpRunId = process.env.CHECKPOINT_RUN_ID ?? `issue-${process.env.ISSUE_NUMBER ?? 'unknown'}`;
  await writeCheckpoint(cpRunId, 'generate', { summary, outputPaths });
  log('Checkpoint written', { runId: cpRunId, step: 'generate' });

  await tracer.finalize('success');
}

main().catch(async (err) => {
  logError('Fatal error', { error: err.message, stack: err.stack });
  await tracer?.finalize('failed');
  process.exit(1);
});
