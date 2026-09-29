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
