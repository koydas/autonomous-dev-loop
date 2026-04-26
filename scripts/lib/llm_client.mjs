import { callGroq } from './groq_client.mjs';
import { callAnthropic } from './anthropic_client.mjs';

export function callLLM(args) {
  const provider = (process.env.AI_PROVIDER || 'groq').trim().toLowerCase();
  if (provider === 'anthropic') return callAnthropic(args);
  return callGroq(args);
}
