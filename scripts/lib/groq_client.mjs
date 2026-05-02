import { log } from './logger.mjs';
import { classifyError } from './error_taxonomy.mjs';
import { retryWithBackoff } from './retry.mjs';

function parseWaitMs(rawText, headers) {
  const match = rawText.match(/Please try again in (\d+(?:\.\d+)?)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  const retryAfter = headers?.get('Retry-After');
  if (retryAfter != null) {
    const secs = parseFloat(retryAfter);
    if (!isNaN(secs) && secs >= 0) return Math.ceil(secs * 1000);
  }
  return null;
}

export async function callGroq({
  prompt,
  systemPrompt,
  apiKey,
  model,
  apiUrl,
  temperature = 0,
  maxTokens,
  responseFormat = { type: 'json_object' },
}) {
  const payload = {
    model,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
  };
  if (maxTokens != null) {
    payload.max_tokens = maxTokens;
  }
  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  const response = await retryWithBackoff(async () => {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    return response;
  }, {
    retryableStatusCodes: [429, 500, 502, 503, 504],
  });

  const rawText = await response.text();

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new Error('Groq API returned non-JSON response', { cause: err });
  }

  const content = raw?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Unexpected Groq API response format');
  }

  return content;
}