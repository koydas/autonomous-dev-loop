#!/usr/bin/env node

import { validateIssue, VALIDATION_SYSTEM_PROMPT, formatGitHubComment } from './lib/issue_validator.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { requireEnv, loadLLMConfig } from './lib/config.mjs';
import { log, error as logError } from './lib/logger.mjs';
import { log as obsLog, createTracer } from './lib/observability.mjs';
import { writeCheckpoint } from './lib/checkpoint.mjs';
import { appendMetric, estimateTokens } from './lib/metrics.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

let tracer;

process.on('unhandledRejection', async (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  await tracer?.finalize('failed');
  process.exit(1);
});

async function main() {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';
  const { apiKey, model, apiUrl, temperature, maxTokens } = loadLLMConfig('validation');

  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const traceDir = path.join(process.cwd(), 'observability', 'traces');
  tracer = createTracer({ runId, issueNumber: Number(issueNumber), traceDir });

  obsLog({ stage: 'issue_validation', event: 'issue_validation.start', level: 'info', meta: { issueNumber, issueTitle, model } });
  tracer.startSpan('issue_validation', { issueNumber, issueTitle, model });

  log('Validating issue', { issueNumber, issueTitle, model });

  const boundCallGroq = ({ prompt }) =>
    callLLM({ prompt, systemPrompt: VALIDATION_SYSTEM_PROMPT, apiKey, model, apiUrl, temperature, maxTokens });

  let result;
  try {
    result = await validateIssue({ issueTitle, issueBody, callGroq: boundCallGroq });
  } catch (err) {
    const duration_ms = Date.now() - startMs;
    obsLog({ stage: 'issue_validation', event: 'issue_validation.fail', level: 'error', duration_ms, meta: { error: err.message, issueNumber } });
    tracer.endSpan('issue_validation', { outcome: 'failed', meta: { error: err.message } });
    await tracer.finalize('failed');
    throw err;
  }

  const comment = formatGitHubComment(result, issueTitle);
  const duration_ms = Date.now() - startMs;

  if (result.valid) {
    obsLog({ stage: 'issue_validation', event: 'issue_validation.pass', level: 'info', duration_ms, meta: { score: result.score, issueNumber, warnings_count: (result.warnings ?? []).length } });
    tracer.endSpan('issue_validation', { outcome: 'success', meta: { score: result.score, valid: true } });
  } else {
    obsLog({ stage: 'issue_validation', event: 'issue_validation.fail', level: 'warn', duration_ms, meta: { score: result.score, issueNumber, blockers_count: (result.blockers ?? []).length } });
    tracer.endSpan('issue_validation', { outcome: 'failed', meta: { score: result.score, valid: false } });
  }

  log('Validation result', { valid: result.valid, score: result.score, blockers: result.blockers });

  if (process.env.GITHUB_OUTPUT) {
    const output = [
      `valid=${result.valid}`,
      `score=${result.score}`,
      `comment<<EOF`,
      comment,
      `EOF`,
      '',
    ].join('\n');
    await fs.appendFile(process.env.GITHUB_OUTPUT, output, 'utf8');
    log('Exported workflow outputs: valid, score, comment');
  }

  const cpRunId = process.env.CHECKPOINT_RUN_ID ?? `issue-${issueNumber}`;
  await writeCheckpoint(cpRunId, 'validate', { valid: result.valid, score: result.score });
  log('Checkpoint written', { runId: cpRunId, step: 'validate' });

  await appendMetric({
    type: 'issue',
    run_id: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}` : `local-${Date.now()}`,
    issue_number: Number(issueNumber),
    verdict: result.valid ? 'APPROVE' : 'MANUAL',
    score: result.score,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    duration_ms,
    input_tokens_est: estimateTokens(VALIDATION_SYSTEM_PROMPT + issueTitle + issueBody),
    output_tokens_est: estimateTokens(comment),
  });
  log('Metrics recorded', { issueNumber, verdict: result.valid ? 'APPROVE' : 'MANUAL' });

  await tracer.finalize(result.valid ? 'success' : 'partial');
}

main().catch(async (err) => {
  logError('Fatal error', { error: err.message, stack: err.stack });
  await tracer?.finalize('failed');
  process.exit(1);
});
