import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrompt, interpolatePrompt } from './prompts.mjs';
import { parseFlatYaml, parseNestedYaml } from './yaml.mjs';

const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../config');
const MODELS_FILE = resolve(CONFIG_DIR, 'models.yaml');
const LABELS_FILE = resolve(CONFIG_DIR, 'labels.yaml');

export const GROQ_MODEL_DEFAULTS = parseFlatYaml(readFileSync(MODELS_FILE, 'utf8'));

export function loadLabelsConfig(group) {
  const all = parseNestedYaml(readFileSync(LABELS_FILE, 'utf8'));
  const section = all[group];
  if (!section) throw new Error(`Unknown label group "${group}" in labels.yaml`);
  return section;
}

export const GROQ_API_URL_DEFAULT = 'https://api.groq.com/openai/v1/chat/completions';

export const ANTHROPIC_MODEL_DEFAULTS = {
  validation: 'claude-opus-4-7',
  generation: 'claude-opus-4-7',
  review: 'claude-opus-4-7',
  autofix: 'claude-opus-4-7',
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
  if (process.env.ANTHROPIC_API_KEY?.trim() && !process.env.GROQ_API_KEY?.trim()) return 'anthropic';
  return 'groq';
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
  const rawTemp = GROQ_MODEL_DEFAULTS[`${stage}_temperature`] ?? GROQ_MODEL_DEFAULTS.temperature;
  let temperature;
  if (rawTemp !== undefined) {
    temperature = parseFloat(rawTemp);
    if (isNaN(temperature) || temperature < 0 || temperature > 2) {
      throw new Error(`Invalid temperature for stage "${stage}": ${rawTemp} (must be a number between 0 and 2)`);
    }
  }
  const rawMaxTokens = GROQ_MODEL_DEFAULTS[`${stage}_max_tokens`] ?? GROQ_MODEL_DEFAULTS.max_tokens;
  let maxTokens;
  if (rawMaxTokens !== undefined) {
    maxTokens = parseInt(rawMaxTokens, 10);
    if (isNaN(maxTokens) || maxTokens <= 0) {
      throw new Error(`Invalid max_tokens for stage "${stage}": ${rawMaxTokens} (must be a positive integer)`);
    }
  }

  const rawMaxInputTokens = GROQ_MODEL_DEFAULTS[`${stage}_max_input_tokens`] ?? GROQ_MODEL_DEFAULTS.max_input_tokens;
  let maxInputTokens;
  if (rawMaxInputTokens !== undefined) {
    maxInputTokens = parseInt(rawMaxInputTokens, 10);
    if (isNaN(maxInputTokens) || maxInputTokens <= 0) {
      throw new Error(`Invalid max_input_tokens for stage "${stage}": ${rawMaxInputTokens} (must be a positive integer)`);
    }
  }

  const rawDiffRatio = GROQ_MODEL_DEFAULTS[`${stage}_diff_ratio`] ?? GROQ_MODEL_DEFAULTS.diff_ratio;
  let diffRatio;
  if (rawDiffRatio !== undefined) {
    diffRatio = parseFloat(rawDiffRatio);
    if (isNaN(diffRatio) || diffRatio <= 0 || diffRatio >= 1) {
      throw new Error(`Invalid diff_ratio for stage "${stage}": ${rawDiffRatio} (must be a number between 0 and 1 exclusive)`);
    }
  }

  const rawFeedbackRatio = GROQ_MODEL_DEFAULTS[`${stage}_feedback_ratio`] ?? GROQ_MODEL_DEFAULTS.feedback_ratio;
  let feedbackRatio;
  if (rawFeedbackRatio !== undefined) {
    feedbackRatio = parseFloat(rawFeedbackRatio);
    if (isNaN(feedbackRatio) || feedbackRatio <= 0 || feedbackRatio >= 1) {
      throw new Error(`Invalid feedback_ratio for stage "${stage}": ${rawFeedbackRatio} (must be a number between 0 and 1 exclusive)`);
    }
  }

  return { provider, apiKey, model, apiUrl, temperature, maxTokens, maxInputTokens, diffRatio, feedbackRatio };
}

export function loadConfigFromEnv() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';

  const { apiKey, model, apiUrl, temperature, maxTokens } = loadLLMConfig('generation');

  return {
    issueNumber,
    issueTitle,
    issueBody,
    apiKey,
    model,
    apiUrl,
    temperature,
    maxTokens,
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

export function validateStartup(promptsDirOverride) {
  requireEnv('GITHUB_TOKEN');
  requireEnv('GITHUB_REPOSITORY');
  requireEnv('GITHUB_EVENT_PATH');
  requireEnv('ISSUE_NUMBER');
  requireEnv('ISSUE_TITLE');
  const promptsDir = promptsDirOverride ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts');
  const generationSystemPromptPath = resolve(promptsDir, 'generation-system.md');
  const generationUserPromptPath = resolve(promptsDir, 'generation-user.md');
  if (!existsSync(generationSystemPromptPath)) {
    throw new Error(`Prompt file not found: ${generationSystemPromptPath}`);
  }
  if (!existsSync(generationUserPromptPath)) {
    throw new Error(`Prompt file not found: ${generationUserPromptPath}`);
  }
}
