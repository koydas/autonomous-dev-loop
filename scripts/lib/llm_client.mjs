import { callGroq } from './groq_client.mjs';
import { callAnthropic } from './anthropic_client.mjs';
import { detectProvider } from './config.mjs';

export function callLLM(args) {
  const provider = detectProvider();
  if (provider === 'anthropic') return callAnthropic(args);
  return callGroq(args);
}
