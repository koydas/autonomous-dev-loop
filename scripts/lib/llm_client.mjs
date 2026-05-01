import { callGroq } from './groq_client.mjs';
import { callAnthropic } from './anthropic_client.mjs';
import { detectProvider } from './config.mjs';

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
  for (const provider of ordered) {
    try {
      return await provider.call(args);
    } catch (error) {
      errors.push(`${provider.name}: ${error.message}`);
    }
  }
  throw new Error(`All providers failed: ${errors.join(', ')}`);
}
