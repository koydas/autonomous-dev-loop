import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrompt, interpolatePrompt } from './prompts.mjs';
import { parseFlatYaml } from './yaml.mjs';

const MODELS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../config/models.yaml');

export const GROQ_MODEL_DEFAULTS = parseFlatYaml(readFileSync(MODELS_FILE, 'utf8'));

export const GROQ_API_URL_DEFAULT = 'https://api.groq.com/openai/v1/chat/completions';

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
  const model = (process.env.GROQ_MODEL || GROQ_MODEL_DEFAULTS.generation).trim();
  const apiUrl = (process.env.GROQ_API_URL || GROQ_API_URL_DEFAULT).trim();

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
