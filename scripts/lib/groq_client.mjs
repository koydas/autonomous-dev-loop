import { log } from './logger.mjs';
import { classifyError } from './error_taxonomy.mjs';
import { retryWithBackoff, MAX_LLM_RETRY_AFTER_MS } from './retry.mjs';

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

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// Groq free tier: one TPM window. A rate limit without a wait hint is waited out for a whole
// window rather than the short backoff, which would spend every retry within seconds (ADR-0028).
export const TPM_WINDOW_MS = 60000;

// Groq answers 413 `rate_limit_exceeded` when the org-wide TPM budget is momentarily spent:
// the same request passes once the window rolls. Any other 413 (payload too large) is final.
function isTpmRateLimit(status, rawText) {
  if (status === 429) return true;
  if (status !== 413) return false;
  try {
    return JSON.parse(rawText)?.error?.code === 'rate_limit_exceeded';
  } catch {
    return false;
  }
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
  reasoningEffort,
}) {
  const parsed = parseInt(process.env.GROQ_MAX_RETRIES, 10);
  const maxAttempts = (Number.isFinite(parsed) && parsed >= 0 ? parsed : 3) + 1;
  const waitBudget = Number(process.env.LLM_MAX_RETRY_WAIT_MS);
  const maxWaitMs = Number.isFinite(waitBudget) && waitBudget > 0 ? waitBudget : MAX_LLM_RETRY_AFTER_MS;

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
  // Only reasoning models (e.g. openai/gpt-oss-120b) accept it; others reject the parameter.
  if (reasoningEffort) {
    payload.reasoning_effort = reasoningEffort;
  }

  const rawText = await retryWithBackoff(async () => {
    let response;
    try {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      fetchErr.retryable = true;
      throw fetchErr;
    }
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`Groq API HTTP error ${response.status}: ${text}`);
      err.status = response.status;
      err.errorType = classifyError(String(response.status));
      const tpmRateLimit = isTpmRateLimit(response.status, text);
      err.retryable = tpmRateLimit || RETRYABLE_STATUS_CODES.has(response.status);
      err.waitMs = parseWaitMs(text, response.headers) ?? (tpmRateLimit ? TPM_WINDOW_MS : null);
      // A wait beyond the budget would outlast the job timeout: fail fast so callLLM can fall back.
      if (err.waitMs != null && err.waitMs > maxWaitMs) err.retryable = false;
      throw err;
    }
    return text;
  }, { maxAttempts });

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw new Error('Groq API returned non-JSON response', { cause: err });
  }

  const content = raw?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('Unexpected Groq API response format: expected non-empty string at choices[0].message.content');
  }

  return content;
}
