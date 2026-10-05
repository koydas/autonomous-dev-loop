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

// Longest server-imposed wait (Retry-After) on GitHub API calls worth honoring: three retries
// must fit well inside the shortest job timeout. Longer waits fail fast instead.
export const MAX_RETRY_AFTER_MS = 10000;

// LLM rate-limit waits (Groq TPM) are per-minute: one window is always worth waiting out.
// Every LLM workflow sets LLM_MAX_RETRY_WAIT_MS=60000 explicitly (ADR-0022, ADR-0028).
export const MAX_LLM_RETRY_AFTER_MS = 60000;

// fetch does not throw on HTTP errors. Returns a retryable error for 429/5xx (carrying
// Retry-After as waitMs), or null for any other status, which callers handle via .ok (ADR-0022).
// A 5xx does not prove the request was not processed, so for a request that is not
// retry-safe (see isRetrySafeGitHubRequest) only 429 — rejected before processing — is retried.
export function transientHttpError(res, context, { maxRetryAfterMs = MAX_RETRY_AFTER_MS, retrySafe = true } = {}) {
  if (res.status !== 429 && res.status < 500) return null;
  const err = new Error(`${context} transient error: ${res.status}`);
  err.status = res.status;
  err.waitMs = parseRetryAfterMs(res.headers?.get('retry-after'));
  if (err.waitMs !== undefined && err.waitMs > maxRetryAfterMs) err.retryable = false;
  if (!retrySafe && res.status !== 429) err.retryable = false;
  return err;
}

// GitHub requests whose replay cannot create a duplicate: every method except POST, plus
// label POSTs (repo label create returns 422 on duplicate; adding issue labels is a set union).
// Comment and review POSTs are not retry-safe.
export function isRetrySafeGitHubRequest(method, path) {
  if (String(method ?? 'GET').toUpperCase() !== 'POST') return true;
  return /\/labels$/.test(String(path).split('?')[0]);
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
