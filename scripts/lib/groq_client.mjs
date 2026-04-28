import { log } from './logger.mjs';

function parseWaitMs(rawText, headers) {
  const match = rawText.match(/Please try again in (\d+(?:\.\d+)?)s/i);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  const retryAfter = headers.get('Retry-After');
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
  const parsed = parseInt(process.env.GROQ_MAX_RETRIES, 10);
  const maxRetries = Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;

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

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();

    if (response.status === 429) {
      lastError = new Error(`Groq API HTTP error ${response.status}: ${rawText}`);
      if (attempt === maxRetries) break;
      const waitMs = parseWaitMs(rawText, response.headers) ?? 1000 * 2 ** attempt;
      log('rate_limit_retry', { waitMs, attempt, model });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    if (!response.ok) {
      throw new Error(`Groq API HTTP error ${response.status}: ${rawText}`);
    }

    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch {
      throw new Error('Groq API returned non-JSON response');
    }

    const content = raw?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('Unexpected Groq API response format');
    }

    return content;
  }

  throw lastError;
}
