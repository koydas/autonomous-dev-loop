#!/usr/bin/env node

import { validateIssue, VALIDATION_SYSTEM_PROMPT, formatGitHubComment } from './lib/issue_validator.mjs';
import { callLLM } from './lib/llm_client.mjs';
import { requireEnv, loadLLMConfig } from './lib/config.mjs';
import { log, error as logError } from './lib/logger.mjs';
import fs from 'node:fs/promises';

async function main() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';
  const { apiKey, model, apiUrl, temperature } = loadLLMConfig('validation');

  log('Validating issue', { issueNumber, issueTitle, model });

  const boundCallGroq = ({ prompt }) =>
    callLLM({ prompt, systemPrompt: VALIDATION_SYSTEM_PROMPT, apiKey, model, apiUrl, temperature });

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
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});
