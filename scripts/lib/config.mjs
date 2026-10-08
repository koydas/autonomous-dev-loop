import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrompt, interpolatePrompt } from './prompts.mjs';
import { parseFlatYaml, parseNestedYaml } from './yaml.mjs';
import { log } from './observability.mjs';

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

const ANTHROPIC_FALLBACK_MODEL = 'claude-opus-5-5';
const ANTHROPIC_MAX_TOKENS_DEFAULT = 16000;
const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// anthropic_<stage> in config/models.yaml; ANTHROPIC_MODEL overrides every stage at runtime.
export const ANTHROPIC_MODEL_DEFAULTS = Object.fromEntries(
  ['validation', 'generation', 'review', 'autofix'].map(stage => [stage, GROQ_MODEL_DEFAULTS[`anthropic_${stage}`] ?? ANTHROPIC_FALLBACK_MODEL]),
);

export function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const PROVIDERS = ['groq', 'anthropic'];
export const DEFAULT_PROVIDER = 'groq';

const PROVIDER_KEY_ENV = { groq: 'GROQ_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const hasKey = (provider) => Boolean(process.env[PROVIDER_KEY_ENV[provider]]?.trim());

// detectProvider() runs several times per LLM call: report each misconfiguration once per process.
const reportedConfigWarnings = new Set();
function warnConfigOnce(message, meta) {
  if (reportedConfigWarnings.has(message)) return;
  reportedConfigWarnings.add(message);
  log({ stage: 'config', event: 'provider_config_fallback', level: 'warn', meta: { message, ...meta } });
}

// Primary provider (ADR-0032). A bad AI_PROVIDER never fails the job: an unknown value falls back to the
// key-based default, and a provider whose key is missing yields to the one that has a key. Both are logged.
export function detectProvider() {
  const otherThan = (p) => PROVIDERS.find(x => x !== p);
  const keyBased = hasKey('anthropic') && !hasKey('groq') ? 'anthropic' : DEFAULT_PROVIDER;
  const raw = process.env.AI_PROVIDER?.trim();
  if (!raw) return keyBased;

  const explicit = raw.toLowerCase();
  if (!PROVIDERS.includes(explicit)) {
    warnConfigOnce(`AI_PROVIDER "${raw}" is not ${PROVIDERS.join(' or ')}: using ${keyBased}`, { ai_provider: raw, provider: keyBased });
    return keyBased;
  }
  if (!hasKey(explicit) && hasKey(otherThan(explicit))) {
    const other = otherThan(explicit);
    warnConfigOnce(`AI_PROVIDER=${explicit} but ${PROVIDER_KEY_ENV[explicit]} is not set: using ${other}`, { ai_provider: raw, provider: other });
    return other;
  }
  return explicit;
}

// The provider that is not the primary one, when its API key is set; null otherwise (no fallback).
export function detectFallbackProvider() {
  const fallback = PROVIDERS.find(p => p !== detectProvider());
  return process.env[PROVIDER_KEY_ENV[fallback]]?.trim() ? fallback : null;
}

export function loadLLMConfig(stage = 'generation') {
  return loadProviderConfig(detectProvider(), stage);
}

// Config for one provider, independent of AI_PROVIDER: the fallback call needs its own key, model and budgets.
export function loadProviderConfig(provider, stage = 'generation') {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}" (must be ${PROVIDERS.join(' or ')})`);
  }

  if (provider === 'anthropic') {
    const apiKey = requireEnv('ANTHROPIC_API_KEY');
    const model = (process.env.ANTHROPIC_MODEL || ANTHROPIC_MODEL_DEFAULTS[stage] || ANTHROPIC_MODEL_DEFAULTS.generation).trim();
    const apiUrl = process.env.ANTHROPIC_API_URL?.trim() || undefined;

    // Thinking tokens count toward max_tokens: the Groq budgets (8K TPM) do not apply here.
    const rawMaxTokens = GROQ_MODEL_DEFAULTS[`anthropic_${stage}_max_tokens`] ?? GROQ_MODEL_DEFAULTS.anthropic_max_tokens;
    const maxTokens = rawMaxTokens === undefined ? ANTHROPIC_MAX_TOKENS_DEFAULT : parseInt(rawMaxTokens, 10);
    if (isNaN(maxTokens) || maxTokens <= 0) {
      throw new Error(`Invalid anthropic max_tokens for stage "${stage}": ${rawMaxTokens} (must be a positive integer)`);
    }

    // Sent as output_config.effort. ANTHROPIC_EFFORT overrides every stage; `off` sends none (model default).
    let effort = process.env.ANTHROPIC_EFFORT?.trim().toLowerCase()
      || (GROQ_MODEL_DEFAULTS[`anthropic_${stage}_effort`] ?? GROQ_MODEL_DEFAULTS.anthropic_effort);
    if (effort === 'off') effort = undefined;
    if (effort !== undefined && !ANTHROPIC_EFFORTS.includes(effort)) {
      throw new Error(`Invalid anthropic effort for stage "${stage}": ${effort} (must be ${ANTHROPIC_EFFORTS.join(', ')} or off)`);
    }

    // No temperature: sampling parameters are rejected (400) by Opus 4.7+ and Opus 5.x.
    return { provider, apiKey, model, apiUrl, maxTokens, reasoningEffort: effort };
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

  if (diffRatio !== undefined && feedbackRatio !== undefined && diffRatio + feedbackRatio >= 1) {
    throw new Error(`Invalid ratio config for stage "${stage}": autofix_diff_ratio (${diffRatio}) + autofix_feedback_ratio (${feedbackRatio}) must sum to less than 1.0`);
  }

  // GROQ_REASONING_EFFORT overrides every stage (like GROQ_MODEL); `off` drops the parameter for non-reasoning models.
  const envReasoningEffort = process.env.GROQ_REASONING_EFFORT?.trim().toLowerCase();
  let reasoningEffort = envReasoningEffort || (GROQ_MODEL_DEFAULTS[`${stage}_reasoning_effort`] ?? GROQ_MODEL_DEFAULTS.reasoning_effort);
  if (reasoningEffort === 'off') reasoningEffort = undefined;
  if (reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(reasoningEffort)) {
    throw new Error(`Invalid reasoning_effort for stage "${stage}": ${reasoningEffort} (must be low, medium, high or off)`);
  }

  return { provider, apiKey, model, apiUrl, temperature, maxTokens, maxInputTokens, diffRatio, feedbackRatio, reasoningEffort };
}

export function loadConfigFromEnv() {
  const issueNumber = requireEnv('ISSUE_NUMBER');
  const issueTitle = requireEnv('ISSUE_TITLE');
  const issueBody = (process.env.ISSUE_BODY || '').trim() || '(no body provided)';

  const { apiKey, model, apiUrl, temperature, maxTokens, reasoningEffort } = loadLLMConfig('generation');

  return {
    issueNumber,
    issueTitle,
    issueBody,
    apiKey,
    model,
    apiUrl,
    temperature,
    maxTokens,
    reasoningEffort,
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
