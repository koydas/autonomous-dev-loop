import { log } from './logger.mjs';

const DEFAULT_OPTIONS = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 8000,
  jitter: true,
};

// Parses an HTTP Retry-After header (delta-seconds or HTTP-date) into milliseconds.
// Returns undefined when absent or unparseable so callers fall back to backoff.
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || String(value).trim() === '') return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.ceil(secs * 1000) : undefined;
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

// Longest server-imposed wait (Retry-After) worth honoring: three retries must fit well
// inside the shortest job timeout (pr-review: 2 min). Longer waits fail fast instead.
export const MAX_RETRY_AFTER_MS = 10000;

// fetch does not throw on HTTP errors. Returns a retryable error for 429/5xx (carrying
// Retry-After as waitMs), or null for any other status, which callers handle via .ok (ADR-0022).
export function transientHttpError(res, context, { maxRetryAfterMs = MAX_RETRY_AFTER_MS } = {}) {
  if (res.status !== 429 && res.status < 500) return null;
  const err = new Error(`${context} transient error: ${res.status}`);
  err.status = res.status;
  err.waitMs = parseRetryAfterMs(res.headers?.get('retry-after'));
  if (err.waitMs !== undefined && err.waitMs > maxRetryAfterMs) err.retryable = false;
  return err;
}

export async function retryWithBackoff(fn, options = {}) {
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = { ...DEFAULT_OPTIONS, ...options };

  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      if (error.retryable === false || attempt === maxAttempts - 1) throw error;

      const base = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const waitMs = error.waitMs ?? (jitter ? base * (Math.random() * 0.4 + 0.8) : base);
      log('retry', { attempt, error: error.message, waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt++;
    }
  }
}
