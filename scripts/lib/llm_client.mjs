import { callGroq } from './groq_client.mjs';
import { callAnthropic } from './anthropic_client.mjs';
import { PROVIDERS, detectProvider, detectFallbackProvider, loadProviderConfig } from './config.mjs';
import { classifyError } from './error_taxonomy.mjs';
import { log } from './observability.mjs';

const PROVIDER_CALLS = {
  anthropic: callAnthropic,
  groq: callGroq,
};

// args: the primary provider's config (loadLLMConfig) + the call itself (prompt, systemPrompt, responseFormat)
// + stage. The fallback never reuses the primary's config: it loads its own key, model and budgets.
export async function callLLM(args) {
  const primary = detectProvider();
  const fallback = PROVIDERS.find(p => p !== primary);
  const stage = args.stage ?? 'generation';

  const errors = [];
  let errorType;
  try {
    return await PROVIDER_CALLS[primary](args);
  } catch (error) {
    errorType = error.errorType ?? classifyError(String(error.status ?? ''));
    errors.push(`${primary}: ${error.message}`);
  }

  if (detectFallbackProvider() !== fallback) {
    errors.push(`${fallback}: skipped (no API key configured)`);
    throw new Error(`All providers failed: ${errors.join(', ')}`);
  }

  // Any primary failure falls back. 401/403 means the primary's key is wrong: logged as an error
  // (GitHub annotation) so the misconfiguration stays visible while the fallback keeps the job running.
  const level = errorType === 'PERMANENT' ? 'error' : 'warn';
  log({ stage, event: 'llm_fallback', level, meta: { from: primary, to: fallback, error_type: errorType, error: errors[0] } });
  try {
    const fallbackConfig = loadProviderConfig(fallback, stage);
    const call = { prompt: args.prompt, systemPrompt: args.systemPrompt };
    if ('responseFormat' in args) call.responseFormat = args.responseFormat;
    return await PROVIDER_CALLS[fallback]({ ...fallbackConfig, ...call });
  } catch (error) {
    errors.push(`${fallback}: ${error.message}`);
  }
  throw new Error(`All providers failed: ${errors.join(', ')}`);
}
