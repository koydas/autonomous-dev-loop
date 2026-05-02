import { log } from './logger.mjs';
import { setTimeout } from 'node:timers';
import { AbortController } from 'node:abort-controller';

const DEFAULT_OPTIONS = {
  maxAttempts: 4,
  baseDelayMs: 200,
  maxDelayMs: 8000,
  timeoutMs: 15000,
  jitter: true,
};

export async function retryWithBackoff(fn, options = {}) {
  const { maxAttempts, baseDelayMs, maxDelayMs, timeoutMs, jitter } = { ...DEFAULT_OPTIONS, ...options };
  const retryableStatusCodes = [429, 500, 502, 503, 504];
  const nonRetryableStatusCodes = [400, 401, 403, 404, 422];

  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await Promise.race([
        fn(),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Timeout')))),
      ]);
      clearTimeout(timeoutId);

      if (response.ok) return response;
      const statusCode = response.status;
      if (nonRetryableStatusCodes.includes(statusCode)) throw new Error(`Non-retryable status code ${statusCode}`);
      if (!retryableStatusCodes.includes(statusCode)) throw new Error(`Unexpected status code ${statusCode}`);

      const retryAfter = response.headers.get('Retry-After');
      let waitMs;
      if (retryAfter) {
        waitMs = parseInt(retryAfter, 10) * 1000;
      } else {
        waitMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        if (jitter) {
          waitMs *= Math.random() * 0.4 + 0.8;
        }
      }

      log('retry', { attempt, statusCode, waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt++;
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      attempt++;
    }
  }
  throw new Error('Max attempts exceeded');
}