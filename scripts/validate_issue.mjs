#!/usr/bin/env node

import { validateIssue, VALIDATION_SYSTEM_PROMPT, formatGitHubComment } from './lib/issue_validator.mjs';
import { callClaude as callGroq } from './lib/claude_client.mjs';
import fs from 'node:fs/promises';

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';
  const apiKey = requireEnv('GROQ_API_KEY');
  const model = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
  const apiUrl = (process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions').trim();

  console.log(`[INFO] Validating issue #${issueNumber}: "${issueTitle}" using model ${model}`);

  const callClaude = ({ userPrompt }) =>
    callGroq({ systemPrompt: VALIDATION_SYSTEM_PROMPT, userPrompt, apiKey, model, apiUrl });

  const result = await validateIssue({ issueTitle, issueBody, callClaude });
  const comment = formatGitHubComment(result, issueTitle);

  console.log(`[INFO] Result: valid=${result.valid}, score=${result.score}/100`);
  result.blockers.forEach((b) => console.log(`[BLOCKER] ${b}`));

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
    console.log('[INFO] Exported workflow outputs: valid, score, comment');
  }
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exit(1);
});
