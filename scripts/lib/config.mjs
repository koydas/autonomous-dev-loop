import { loadPrompt, interpolatePrompt } from './prompts.mjs';

export function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfigFromEnv() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';

  const apiKey = requireEnv('GROQ_API_KEY');
  const model = (process.env.GROQ_MODEL || 'llama-3.1-8b-instant').trim();
  const apiUrl = (process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions').trim();

  return {
    issueNumber,
    issueTitle,
    issueBody,
    apiKey,
    model,
    apiUrl,
  };
}

export function buildDeterministicPrompt({ issueNumber, issueTitle, issueBody }) {
  const template = loadPrompt('generation-user');
  return interpolatePrompt(template, { issueNumber, issueTitle, issueBody });
}
