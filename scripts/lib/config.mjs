import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrompt, interpolatePrompt } from './prompts.mjs';
import { parseFlatYaml } from './yaml.mjs';

const MODELS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../config/models.yaml');

export const GROQ_MODEL_DEFAULTS = parseFlatYaml(readFileSync(MODELS_FILE, 'utf8'));

export const GROQ_API_URL_DEFAULT = 'https://api.groq.com/openai/v1/chat/completions';

export const ANTHROPIC_MODEL_DEFAULTS = {
  validation: 'claude-opus-4-7',
  generation: 'claude-opus-4-7',
  review: 'claude-opus-4-7',
};

export function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function detectProvider() {
  const explicit = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.GROQ_API_KEY?.trim() && !process.env.ANTHROPIC_API_KEY?.trim()) return 'groq';
  return 'anthropic';
}

export function loadLLMConfig(stage = 'generation') {
  const provider = detectProvider();

  if (provider === 'anthropic') {
    const apiKey = requireEnv('ANTHROPIC_API_KEY');
    const model = (process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULTS[stage] || ANTHROPIC_MODEL_DEFAULTS.generation).trim();
    const apiUrl = process.env.ANTHROPIC_API_URL?.trim() || undefined;
    return { provider, apiKey, model, apiUrl };
  }

  const apiKey = requireEnv('GROQ_API_KEY');
  const model = (process.env.GROQ_MODEL || GROQ_MODEL_DEFAULTS[stage] || GROQ_MODEL_DEFAULTS.generation).trim();
  const apiUrl = (process.env.GROQ_API_URL || GROQ_API_URL_DEFAULT).trim();
  return { provider, apiKey, model, apiUrl };
}

export function loadConfigFromEnv() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';

  const { apiKey, model, apiUrl } = loadLLMConfig('generation');

  return {
    issueNumber,
    issueTitle,
    issueBody,
    apiKey,
    model,
    apiUrl,
  };
}

export function buildDeterministicPrompt({
  issueNumber,
  issueTitle,
  issueBody,
  fileContents = 'No existing files identified as relevant to this issue.',
}) {
  const template = loadPrompt('generation-user');
  return interpolatePrompt(template, { issueNumber, issueTitle, issueBody, fileContents });
}
