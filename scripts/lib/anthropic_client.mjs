import { classifyError } from './error_taxonomy.mjs';
import { retryWithBackoff } from './retry.mjs';

const ANTHROPIC_API_URL_DEFAULT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export async function callAnthropic({
  prompt,
  systemPrompt,
  apiKey,
  model,
  apiUrl,
  temperature = 0,
  maxTokens = 4096,
}) {
  const payload = {
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  };

  const rawText = await retryWithBackoff(async () => {
    let response;
    try {
      response = await fetch(apiUrl || ANTHROPIC_API_URL_DEFAULT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      fetchErr.retryable = false;
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

  const content = raw?.content?.[0]?.text;
  if (!content || typeof content !== 'string') {
    throw new Error('Unexpected Anthropic API response format');
  }

  return content;
}
