import { callGroq } from './groq_client.mjs';
import { callAnthropic } from './anthropic_client.mjs';
import { detectProvider } from './config.mjs';
import { classifyError } from './error_taxonomy.mjs';

const ALL_PROVIDERS = [
  { name: 'anthropic', call: callAnthropic },
  { name: 'groq', call: callGroq },
];

export async function callLLM(args) {
  const primary = detectProvider();
  const startIndex = ALL_PROVIDERS.findIndex(p => p.name === primary);
  const ordered = startIndex > 0
    ? [...ALL_PROVIDERS.slice(startIndex), ...ALL_PROVIDERS.slice(0, startIndex)]
    : ALL_PROVIDERS;

  const errors = [];
  // Per-provider status for callers that must tell an exhausted quota from a bad response (eval circuit breaker).
  const providerErrors = [];
  for (const provider of ordered) {
    try {
      return await provider.call(args);
    } catch (error) {
      const errorType = error.errorType ?? classifyError(String(error.status ?? ''));
      errors.push(`${provider.name}: ${error.message}`);
      const status = error.status ?? Number(String(error.message).match(/HTTP error (\d{3})/)?.[1]);
      providerErrors.push({ provider: provider.name, status: Number.isFinite(status) ? status : null });
      if (errorType === 'PERMANENT') {
        break;
      }
    }
  }
  throw Object.assign(new Error(`All providers failed: ${errors.join(', ')}`), { providerErrors });
}
