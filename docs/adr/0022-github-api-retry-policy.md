# ADR-0022: HTTP-aware retry policy for GitHub and LLM calls

- **Date:** 2026-09-29
- **Status:** Accepted

## Context

ADR-0010 introduced `retryWithBackoff()`: an error is retried unless it carries `retryable = false`. Two call sites got the semantics backwards:

- `anthropic_client.mjs` and `groq_client.mjs` set `retryable = false` on errors thrown by `fetch` itself (DNS failure, connection reset, TLS error): the most transient failure class failed the stage immediately.
- `ghFetch` in `auto_fix_pr.mjs` wrapped `fetch` in `retryWithBackoff()`, but `fetch` does not throw on HTTP errors, so 429/5xx were returned as ordinary Responses and never retried. `pr_review.mjs` retried only 502–504 and ignored `Retry-After`.

Separately, `retryWithBackoff()` lets `error.waitMs` override the capped backoff. Honoring an arbitrary `Retry-After` (GitHub secondary rate limits commonly send 60 s) inside a job with `timeout-minutes: 2` gets the job killed mid-run, the exact outcome ADR-0020's `cancel-in-progress: false` exists to prevent.

## Decision

1. **Network errors from `fetch` are retryable** in the LLM clients. HTTP status classification is unchanged (429/500/502/503/504 retryable).
2. **`transientHttpError(res, context, { maxRetryAfterMs })`** in `scripts/lib/retry.mjs` is the single classifier for `fetch` Responses: `null` for any status other than 429/5xx; otherwise an error with `status` and `waitMs` parsed from `Retry-After` (delta-seconds or HTTP-date, `parseRetryAfterMs()`). Both `ghFetch` wrappers throw it inside the retry function.
3. **Wait budget:** a `Retry-After` above `MAX_RETRY_AFTER_MS` (10 s) marks the error `retryable = false`: fail fast rather than sleep past the job timeout. 3 retries × 10 s stays well under the shortest job timeout (pr-review, 2 min).
4. **Caller contract unchanged:** every non-transient status (404, 422, …) is returned as a `Response`. When retries are exhausted (or the wait budget is exceeded) on a 429/5xx, `ghFetch` returns the **last Response** rather than throwing, so every caller's existing `.ok` check and error message (`Label list failed: 500`, …) stays the single failure path. Only network-level failures throw.

## Alternatives Considered

- **Throw after exhaustion** — would replace each caller's specific error message with a generic one and change the failure path of existing tests. Rejected.
- **Retry only idempotent methods on 5xx** — see Consequences. Rejected for now: the pipeline's POSTs are mostly idempotent in effect (label create returns 422 on duplicate, add-labels is a set union), and failing a whole stage on one 502 was the observed, more costly failure.
- **Classifier duplicated in each script** — ADR-0010 already rejected per-module retry logic because it diverges; hence the shared `transientHttpError()`.
- **Clamp long `Retry-After` to the budget and retry anyway** — guarantees another 429 while still spending the wait. Rejected.

## Consequences

- ✅ Transient network and GitHub 429/5xx failures no longer fail a stage on the first occurrence.
- ✅ One classifier, one budget constant; the job timeout can no longer be consumed by server-imposed waits.
- ⚠️ **Non-idempotent POSTs may duplicate:** a 5xx does not guarantee the request was not processed, so a retried `POST …/comments` or `POST …/pulls/N/reviews` can post twice. Accepted: duplicates are cosmetic for this loop (labels, not comments or reviews, drive state). Revisit if duplicate reviews become noisy.
- ⚠️ Persistent 5xx now costs ~1.4 s of backoff before the caller sees the failure (test suite runtime roughly doubled for the existing 500-status tests).
- ⚠️ `groq_client.mjs` still honors its own `waitMs` (body hint or `Retry-After`) without the budget; unchanged here.
