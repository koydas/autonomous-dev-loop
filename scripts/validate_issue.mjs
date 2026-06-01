#!/usr/bin/env node

import { validateIssue, VALIDATION_SYSTEM_PROMPT, formatGitHubComment } from './lib/issue_validator.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { requireEnv, loadLLMConfig } from './lib/config.mjs';
import { log, error as logError } from './lib/logger.mjs';
import { writeCheckpoint } from './lib/checkpoint.mjs';
import { appendMetric, estimateTokens } from './lib/metrics.mjs';
import fs from 'node:fs/promises';

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled promise rejection', { error: err.message, stack: err.stack });
  process.exit(1);
});

async function main() {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';
  const { apiKey, model, apiUrl, temperature, maxTokens } = loadLLMConfig('validation');

  log('Validating issue', { issueNumber, issueTitle, model });

  const boundCallGroq = ({ prompt }) =>
    callLLM({ prompt, systemPrompt: VALIDATION_SYSTEM_PROMPT, apiKey, model, apiUrl, temperature, maxTokens });

  const result = await validateIssue({ issueTitle, issueBody, callGroq: boundCallGroq });
  const comment = formatGitHubComment(result, issueTitle);

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

  const runId = process.env.CHECKPOINT_RUN_ID ?? `issue-${issueNumber}`;
  await writeCheckpoint(runId, 'validate', { valid: result.valid, score: result.score });
  log('Checkpoint written', { runId, step: 'validate' });

  await appendMetric({
    type: 'issue',
    issue_number: Number(issueNumber),
    verdict: result.valid ? 'APPROVE' : 'MANUAL',
    score: result.score,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    duration_ms: Date.now() - startMs,
    input_tokens_est: estimateTokens(VALIDATION_SYSTEM_PROMPT + issueTitle + issueBody),
    output_tokens_est: estimateTokens(comment),
  });
  log('Metrics recorded', { issueNumber, verdict: result.valid ? 'APPROVE' : 'MANUAL' });
}

main().catch((err) => {
  logError('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
