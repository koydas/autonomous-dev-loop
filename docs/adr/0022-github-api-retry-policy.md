# ADR-0022: HTTP-aware retry policy for GitHub and LLM calls

- **Date:** 2026-09-29
- **Status:** Accepted — amended by [ADR-0028](./0028-one-review-per-head-sha.md) (pr-review: 5-minute timeout, `LLM_MAX_RETRY_WAIT_MS=45000`, `GROQ_MAX_RETRIES=2`)

## Context

ADR-0010 introduced `retryWithBackoff()`: an error is retried unless it carries `retryable = false`. Two call sites got the semantics backwards:

- `anthropic_client.mjs` and `groq_client.mjs` set `retryable = false` on errors thrown by `fetch` itself (DNS failure, connection reset, TLS error): the most transient failure class failed the stage immediately.
- `ghFetch` in `auto_fix_pr.mjs` wrapped `fetch` in `retryWithBackoff()`, but `fetch` does not throw on HTTP errors, so 429/5xx were returned as ordinary Responses and never retried. `pr_review.mjs` retried only 502–504 and ignored `Retry-After`.

Separately, `retryWithBackoff()` lets `error.waitMs` override the capped backoff. Honoring an arbitrary `Retry-After` (GitHub secondary rate limits commonly send 60 s) inside a job with `timeout-minutes: 2` gets the job killed mid-run, the exact outcome ADR-0020's `cancel-in-progress: false` exists to prevent.

## Decision

1. **Network errors from `fetch` are retryable** in the LLM clients. HTTP status classification is unchanged (429/500/502/503/504 retryable).
2. **`transientHttpError(res, context, { maxRetryAfterMs })`** in `scripts/lib/retry.mjs` is the single classifier for `fetch` Responses: `null` for any status other than 429/5xx; otherwise an error with `status` and `waitMs` parsed from `Retry-After` (delta-seconds or HTTP-date, `parseRetryAfterMs()`). Both `ghFetch` wrappers throw it inside the retry function.
3. **Wait budget:** a `Retry-After` above `MAX_RETRY_AFTER_MS` (10 s) marks the error `retryable = false`: fail fast rather than sleep past the job timeout. 3 retries × 10 s stays well under the shortest job timeout (pr-review, 2 min).
4. **Replay safety:** `isRetrySafeGitHubRequest(method, path)` classifies each GitHub call. Every non-POST method and label POSTs (repo label create returns 422 on duplicate; adding issue labels is a set union) are retry-safe. Other POSTs (issue comments, PR reviews) are not: a 5xx or a network error does not prove the request was not processed, so replaying could post a duplicate. For those, only 429 (rejected before processing) is retried; 5xx and network errors surface on the first occurrence.
5. **Caller contract unchanged:** every non-transient status (404, 422, …) is returned as a `Response`. When retries are exhausted (or the wait budget is exceeded) on a 429/5xx, `ghFetch` returns the **last Response** rather than throwing, so every caller's existing `.ok` check and error message (`Label list failed: 500`, …) stays the single failure path. Only network-level failures throw.

## Alternatives Considered

- **Throw after exhaustion** — would replace each caller's specific error message with a generic one and change the failure path of existing tests. Rejected.
- **Retry every POST on 5xx and accept duplicates** — rejected: a duplicate `REQUEST_CHANGES` review or "Auto-Fix Exhausted" comment is visible noise on every flaky 502, and the stage-level retry (re-running the workflow) already exists for the rare non-replayable failure.
- **Dedup-then-retry (list comments/reviews, replay only if absent)** — correct but adds a read per failure and marker matching per endpoint. Rejected as disproportionate for two call types.
- **Classifier duplicated in each script** — ADR-0010 already rejected per-module retry logic because it diverges; hence the shared `transientHttpError()`.
- **Clamp long `Retry-After` to the budget and retry anyway** — guarantees another 429 while still spending the wait. Rejected.

## Consequences

- ✅ Transient network and GitHub 429/5xx failures no longer fail a stage on the first occurrence.
- ✅ One classifier, one budget constant; the job timeout can no longer be consumed by server-imposed waits.
- ✅ Retries cannot duplicate comments or reviews.
- ⚠️ A single 5xx on a comment or review POST still fails the stage (as before this ADR); re-run the workflow.
- ⚠️ Retry safety is decided by path pattern (`/labels$`); a new non-idempotent POST endpoint ending in `/labels` would be misclassified. The classifier has dedicated tests.
- ⚠️ Persistent 5xx now costs ~1.4 s of backoff before the caller sees the failure (test suite runtime roughly doubled for the existing 500-status tests).
- ✅ `groq_client.mjs` bounds its wait hint (body `try again in Xs` or `Retry-After`) by `MAX_LLM_RETRY_AFTER_MS` (60 s, one TPM window), overridable per job with `LLM_MAX_RETRY_WAIT_MS`. `pr-review.yml` (`timeout-minutes: 2`) sets 10 s; the 10-minute stages keep 60 s, so ordinary TPM throttling is still waited out there (a single 10 s budget for every stage would have turned a 12 s Groq wait into a hard failure in Groq-only setups).
- ⚠️ In pr-review, Groq waits above 10 s go to the fallback provider (or fail if none is configured).
