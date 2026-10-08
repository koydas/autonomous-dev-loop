import { classifyError } from './error_taxonomy.mjs';
import { retryWithBackoff } from './retry.mjs';

const ANTHROPIC_API_URL_DEFAULT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// 529 = overloaded_error: transient, retried like 5xx.
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);

// Models accepting server-side refusal fallback (`fallbacks: "default"`), on the Claude API only.
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5']);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export async function callAnthropic({
  prompt,
  systemPrompt,
  apiKey,
  model,
  apiUrl,
  temperature,
  maxTokens = 16000,
  reasoningEffort,
}) {
  const payload = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }],
  };
  // Opus 4.7+ / 5.x reject sampling parameters (400): sent only when a caller sets one explicitly.
  if (temperature !== undefined) payload.temperature = temperature;
  // Anthropic effort (loadProviderConfig maps anthropic_<stage>_effort to reasoningEffort).
  if (reasoningEffort) payload.output_config = { effort: reasoningEffort };

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  // A safety-classifier refusal is re-run server-side on the model Anthropic picks for its category.
  if (!apiUrl && SERVER_FALLBACK_MODELS.has(model)) {
    payload.fallbacks = 'default';
    headers['anthropic-beta'] = SERVER_FALLBACK_BETA;
  }

  const rawText = await retryWithBackoff(async () => {
    let response;
    try {
      response = await fetch(apiUrl || ANTHROPIC_API_URL_DEFAULT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      fetchErr.retryable = true;
      throw fetchErr;
    }
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`Anthropic API HTTP error ${response.status}: ${text}`);
      err.errorType = classifyError(String(response.status));
      err.retryable = RETRYABLE_STATUS_CODES.has(response.status);
      throw err;
    }
    return text;
  });

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new Error('Anthropic API returned non-JSON response', { cause: err });
  }

  // A refusal is HTTP 200: fail so callLLM moves on to the fallback provider.
  if (raw?.stop_reason === 'refusal') {
    const category = raw?.stop_details?.category ?? 'unspecified';
    throw new Error(`Anthropic API refused the request (stop_reason: refusal, category: ${category})`);
  }

  // Thinking blocks (adaptive thinking is on by default on Opus 5.x) precede the answer: take the first text block.
  const content = Array.isArray(raw?.content) ? raw.content.find(block => block?.type === 'text')?.text : undefined;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('Unexpected Anthropic API response format: expected a non-empty text content block');
  }

  return content;
}
