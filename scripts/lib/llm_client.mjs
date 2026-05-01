import { callGroq } from './groq_client.mjs';
import { callAnthropic } from './anthropic_client.mjs';
import { detectProvider } from './config.mjs';

const providers = [
  { name: 'anthropic', call: callAnthropic },
  { name: 'groq', call: callGroq }
];

export function callLLM(args) {
  const availableProviders = providers.filter(p => {
    // Assume detectProvider checks for valid API key presence
    return detectProvider() === p.name;
  });

  const attemptCall = async (providerIndex) => {
    try {
      return await availableProviders[providerIndex].call(args);
    } catch (error) {
      if (providerIndex < availableProviders.length - 1) {
        return await attemptCall(providerIndex + 1);
      } else {
        const failureReasons = availableProviders.map(p => `${p.name}: ${error.message}`);
        throw new Error(`All providers failed: ${failureReasons.join(', ')}`);
      }
    }
  };

  return attemptCall(0);
}