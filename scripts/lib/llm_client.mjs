import { callGroq } from './groq_client.mjs';
import { callAnthropic } from './anthropic_client.mjs';
import { PROVIDERS, detectProvider, detectFallbackProvider, loadProviderConfig } from './config.mjs';
import { classifyError } from './error_taxonomy.mjs';
import { log } from './observability.mjs';
import { estimateTokens } from './metrics.mjs';
import { assertInputBudget } from './token_budget.mjs';

const PROVIDER_CALLS = {
  anthropic: callAnthropic,
  groq: callGroq,
};

// A non-transient 4xx other than 401/403 (unknown model, unsupported parameter) is a misconfiguration
// as much as a bad key: logged at error level too, so a successful fallback does not hide it.
const CONFIG_ERROR_STATUSES = new Set([400, 404]);

// args: the primary provider's config (loadLLMConfig) + the call itself (prompt, systemPrompt, responseFormat)
// + stage, and optionally the primary's maxInputTokens (validation, generation). The fallback never reuses
// the primary's config: it loads its own key, model and budgets.
export async function callLLM(args) {
  const primary = detectProvider();
  const fallback = PROVIDERS.find(p => p !== primary);
  const stage = args.stage ?? 'generation';

  const errors = [];
  let errorType;
  let status;
  try {
    // An over-budget Groq primary can only end in a 413 retried until the job timeout (ADR-0028): skip it
    // without a request, so the fallback (Anthropic: no input budget) gets the prompt instead.
    assertInputBudget(stage, estimateTokens(args.systemPrompt + args.prompt), args.maxInputTokens);
    return await PROVIDER_CALLS[primary](args);
  } catch (error) {
    errorType = error.errorType ?? classifyError(String(error.status ?? ''));
    status = error.status;
    errors.push(`${primary}: ${error.message}`);
  }

  if (detectFallbackProvider() !== fallback) {
    errors.push(`${fallback}: skipped (no API key configured)`);
    throw new Error(`All providers failed: ${errors.join(', ')}`);
  }

  let fallbackConfig;
  try {
    fallbackConfig = loadProviderConfig(fallback, stage);
  } catch (error) {
    errors.push(`${fallback}: ${error.message}`);
    throw new Error(`All providers failed: ${errors.join(', ')}`);
  }

  // The prompt was sized for the primary. A prompt over the fallback's input budget (Groq: 8K TPM) can only
  // end in a 413 retried as a rate limit until the job timeout (ADR-0028): skip the call instead.
  // The autofix budget bounds the user prompt only; the other stages bound system + user.
  const inputTokens = estimateTokens(stage === 'autofix' ? args.prompt : args.systemPrompt + args.prompt);
  if (fallbackConfig.maxInputTokens != null && inputTokens > fallbackConfig.maxInputTokens) {
    errors.push(`${fallback}: skipped (prompt ~${inputTokens} tokens over ${stage}_max_input_tokens ${fallbackConfig.maxInputTokens})`);
    throw new Error(`All providers failed: ${errors.join(', ')}`);
  }

  // Any primary failure falls back. 401/403 means the primary's key is wrong: logged as an error
  // (GitHub annotation) so the misconfiguration stays visible while the fallback keeps the job running.
  const level = errorType === 'PERMANENT' || CONFIG_ERROR_STATUSES.has(status) ? 'error' : 'warn';
  log({ stage, event: 'llm_fallback', level, meta: { from: primary, to: fallback, error_type: errorType, error: errors[0] } });
  try {
    const call = { prompt: args.prompt, systemPrompt: args.systemPrompt };
    if ('responseFormat' in args) call.responseFormat = args.responseFormat;
    return await PROVIDER_CALLS[fallback]({ ...fallbackConfig, ...call });
  } catch (error) {
    errors.push(`${fallback}: ${error.message}`);
  }
  throw new Error(`All providers failed: ${errors.join(', ')}`);
}
