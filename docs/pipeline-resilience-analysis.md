# Pipeline Resilience Analysis (priority: do not fail)

## Context and objective

You stated a clear constraint: **speed is secondary**; the main priority is **fault tolerance** and **stability** for the generation/fix pipeline.

This analysis is based on existing repository conventions (label-gated triggers, auto-fix attempt limits, smoke/unit tests, constrained output scope) and proposes a resilience-first hardening plan.

## Executive summary

The pipeline already has strong safety foundations (label gates, bounded auto-fix retries, dedicated tests, constrained outputs). To maximize resilience, the top priorities are:

1. **Make every step idempotent** (safe to replay).
2. **Add bounded retries with exponential backoff + jitter** for external calls.
3. **Differentiate transient vs permanent errors** for smart fail-fast behavior.
4. **Add checkpoints and resume support** (explicit attempt state).
5. **Improve observability** (structured logs + reliability metrics).

---

## Current resilience assessment

### Existing strengths

- **Label-gated triggering** reduces accidental runs.
- **Auto-fix retry cap (3)** prevents infinite loops.
- **Unit + smoke tests** reduce cross-module regressions.
- **Constrained output paths** reduce unintended file changes.
- **Workflow orchestration separated from Node.js logic** makes guardrails easier to test.
- **`requireEnv()`** in `scripts/lib/config.mjs` fails fast on missing secrets at startup.
- **`upsert_issue_validation_comment.mjs`** already applies upsert semantics for validation comments.
- **`groq_client.mjs`** has configurable 429 retry with backoff (`GROQ_MAX_RETRIES`).
- **`auto-fix-pr.yml`** sets `timeout-minutes: 10` at the job level.
- **`auto_fix_pr.mjs`** registers a global `unhandledRejection` handler to prevent silent crashes.

### Potential weak points (if priority = near-zero failure)

- External API dependencies (LLM, GitHub, etc.) are exposed to:
  - timeouts,
  - intermittent network errors,
  - rate limiting,
  - partial/invalid responses.
- Incomplete recovery risk after run interruption (runner stop/cancel/restart).
- Non-deterministic behavior in some operations (ordering, permissive parsing).

---

## Code-level gap analysis

This section grounds each recommendation in concrete evidence from the current codebase. All file paths are relative to the repository root.

### `scripts/lib/anthropic_client.mjs` — Zero fault tolerance

The Anthropic client performs a single raw `fetch` with no retry, no timeout, and no error classification. Any transient failure (network reset, 5xx, gateway timeout) throws immediately and propagates uncaught to the caller.

```js
// No retry, no timeout, no classification
const response = await fetch(apiUrl || ANTHROPIC_API_URL_DEFAULT, { ... });
if (!response.ok) {
  throw new Error(`Anthropic API HTTP error ${response.status}: ${rawText}`);
}
```

All Anthropic-backed stages (generation, review, autofix) inherit this fragility. This is the highest-priority gap in the codebase.

### `scripts/lib/groq_client.mjs` — Partial (429-only) retry

Groq has configurable retry logic (`GROQ_MAX_RETRIES`), but only for HTTP 429. Any 5xx error throws immediately without retry. There is also no per-call timeout: a hung connection blocks the runner until the GitHub Actions step timeout fires.

```js
if (response.status === 429) {
  // Retries with backoff — good
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  continue;
}
if (!response.ok) {
  // 5xx: throws immediately, no retry
  throw new Error(`Groq API HTTP error ${response.status}: ${rawText}`);
}
```

The 429 handling is a good model that should be extended to 5xx and applied to the Anthropic client.

### `scripts/lib/llm_client.mjs` — Provider fallback masks permanent errors

The LLM router falls back to the secondary provider on **any** error, including permanent 4xx (invalid API key, malformed request). This silently hides configuration errors and wastes attempts against a second provider that will also fail.

```js
for (const provider of ordered) {
  try {
    return await provider.call(args);
  } catch (error) {
    // 401, 400, 422 all trigger fallback — not just transient errors
    errors.push(`${provider.name}: ${error.message}`);
  }
}
```

A 401 from Anthropic (invalid API key) should fail fast, not silently retry against Groq. The fallback should only activate on `TRANSIENT` errors once the error taxonomy is in place.

### `.github/workflows/code-generation.yml` — Missing job timeout

The `generate-pr` job has no `timeout-minutes`. A hung LLM call can block the runner for up to 6 hours (GitHub Actions default limit). By contrast, `auto-fix-pr.yml` correctly sets `timeout-minutes: 10`.

```yaml
# code-generation.yml — no timeout
generate-pr:
  runs-on: ubuntu-latest
  # timeout-minutes: <missing>

# auto-fix-pr.yml — bounded
auto-fix:
  timeout-minutes: 10
```

Adding `timeout-minutes: 15` to `generate-pr` is a one-line, zero-risk fix with immediate impact.

### `scripts/lib/logger.mjs` — Incomplete structured fields

The logger already emits JSON lines (good), but lacks the fields needed for cross-run correlation and error diagnosis.

Current output shape: `{ level, msg, ...data }`

Missing fields relative to the recommended schema:

| Field | Status | Impact if absent |
|---|---|---|
| `run_id` | Missing | Cannot correlate lines across multi-job workflows |
| `step` | Missing | Cannot locate which pipeline stage failed |
| `attempt` | Missing | Retry context invisible in logs |
| `duration_ms` | Missing | No per-step latency data |
| `error_class` | Missing | Cannot distinguish transient from permanent failures in logs |

The `log()` and `error()` functions in `scripts/lib/logger.mjs` are the right extension point. The change is purely additive.

### `scripts/auto_fix_pr.mjs` — Labels as implicit checkpoint, `ghFetch` without retry

**Positive**: Attempt state is tracked by counting PR labels prefixed `auto-fix-attempt-`. This is a lightweight checkpoint mechanism that survives runner restarts. Label creation already tolerates 422 (existing label), which is a correct upsert pattern.

**Gap 1**: If the label API call fails *after* the AI work is done, the checkpoint is not saved. The attempt is lost and will be re-counted incorrectly on the next run.

**Gap 2**: All GitHub API calls are made via `ghFetch`, which has no retry and no per-call timeout. A single transient network error on any of them (diff fetch, label fetch, comment post) fails the entire run permanently, even though the failure is transient.

```js
async function ghFetch(endpoint, options = {}) {
  try {
    return await fetch(`${githubApiBase}${endpoint}`, { ... });
  } catch (err) {
    // Network error: re-throws immediately — no retry
    throw new Error(`Network error calling GitHub API (${endpoint}): ${err.message}`, { cause: err });
  }
}
```

### Partial idempotence coverage

Idempotence is already partially implemented but inconsistently applied:

| Operation | Status | File |
|---|---|---|
| Validation comment | Upsert by marker (✅) | `upsert_issue_validation_comment.mjs` |
| Auto-fix label creation | 422-tolerant (✅) | `auto_fix_pr.mjs` |
| Generated file writes | Unconditional overwrite (❌) | `scripts/lib/output_writer.mjs` |
| Label management | Needs verification | `scripts/manage_labels.mjs` |

File writes in `output_writer.mjs` are not idempotent by design (they always overwrite), but they are also not checked against expected state before writing. A re-run with the same inputs will produce the same output files, which is acceptable, but intermediate states during a partial failure may leave inconsistent file sets.

### Gap summary table

| File / Artifact | Gap | Severity | Effort |
|---|---|---|---|
| `scripts/lib/anthropic_client.mjs` | No retry, no timeout, no error class | **High** | Medium |
| `scripts/lib/groq_client.mjs` | 5xx not retried, no call timeout | **High** | Low |
| `scripts/lib/llm_client.mjs` | Fallback triggered on permanent errors | **High** | Low |
| `.github/workflows/code-generation.yml` | No job timeout | **High** | Trivial |
| `scripts/auto_fix_pr.mjs` (`ghFetch`) | No retry/timeout on GitHub API calls | **Medium** | Medium |
| `scripts/lib/logger.mjs` | Missing `run_id`, `step`, `attempt`, `error_class` | **Medium** | Low |
| `scripts/lib/output_writer.mjs` | No idempotence check on file writes | **Low** | Low |
| `config/models.yaml` | Values not validated at startup | **Low** | Low |

---

## Prioritized recommendations (impact order)

## 1) Standard error policy (transient vs permanent)

**Goal**: avoid noisy failures and avoid useless retries on unrecoverable errors.

- Classify errors into 3 classes:
  - `TRANSIENT`: timeout, 429, 5xx, network reset.
  - `PERMANENT`: business 4xx (invalid input, missing secret).
  - `UNKNOWN`: treat conservatively (one guarded retry, then stop).
- Enforce explicit behavior:
  - `TRANSIENT` => bounded retry.
  - `PERMANENT` => immediate fail-fast.
  - `UNKNOWN` => one confirmation attempt, then fail.
- **Primary targets**: `anthropic_client.mjs`, `groq_client.mjs`, `llm_client.mjs`.

## 2) Robust retry strategy for external calls

**Goal**: absorb intermittent failures without destabilizing the full run.

- Retry with **exponential backoff + jitter**.
- Max attempt budget per operation (e.g., 3 to 5 attempts).
- Strict per-call timeout + step-level timeout.
- Simple circuit breaker (if N consecutive failures, stop early).
- **Primary targets**: `anthropic_client.mjs`, `groq_client.mjs` (extend to 5xx), `ghFetch` in `auto_fix_pr.mjs`.
- **Quick win**: add `timeout-minutes: 15` to `code-generation.yml` immediately.

## 3) Strict idempotence for critical steps

**Goal**: allow safe reruns without inconsistent side effects.

- Compute idempotency keys (issue id, commit SHA, step).
- Before writing, verify expected state is not already applied.
- For labels/comments, prefer upsert semantics over append.
- **Primary targets**: `output_writer.mjs`, `manage_labels.mjs`.

## 4) Checkpointing and explicit run state

**Goal**: resume safely after interruption without starting from scratch.

- Persist minimal state (json/artifact) per run:
  - current step,
  - attempts consumed,
  - latest relevant external results.
- Resume only when checkpoint is valid.
- Invalidate checkpoint cleanly when inputs change.
- **Note**: the label-based attempt counter in `auto_fix_pr.mjs` is a good foundation — extend it with atomic write semantics.

## 5) Harden input/output validation

**Goal**: fail early on certain causes and avoid late-stage failures.

- Validate at startup:
  - required secrets,
  - config format,
  - required prompt/config files.
- Validate external payload schemas systematically.
- For invalid payloads, classify correctly (often transient if truncated).
- **Primary targets**: `scripts/lib/config.mjs` (already has `requireEnv()`, extend to prompts/files), `scripts/lib/prompts.mjs`.

## 6) Reliability-focused observability

**Goal**: accelerate diagnosis and continuous improvement.

- Structured JSON logs:
  - `run_id`, `step`, `attempt`, `duration_ms`, `error_class`.
- Key metrics:
  - overall success rate,
  - retry rate,
  - errors by class,
  - average step latency,
  - MTTR (mean time to recovery).
- Always emit end-of-run summary, including failures.
- **Primary target**: `scripts/lib/logger.mjs` (additive changes only).

---

## Implementation plan (resilience MVP)

### Phase 1 (quick wins, high ROI)

1. Add `timeout-minutes: 15` to `code-generation.yml` `generate-pr` job.
2. Add a shared `retry_with_backoff` utility in `scripts/lib/`.
3. Add shared error taxonomy (`TRANSIENT/PERMANENT/UNKNOWN`) in `scripts/lib/`.
4. Extend `groq_client.mjs` retry to cover 5xx in addition to 429.
5. Apply the same retry pattern to `anthropic_client.mjs`.
6. Fix `llm_client.mjs` fallback to only trigger on `TRANSIENT` errors.
7. Add standardized log fields (`run_id`, `attempt`, `error_class`) to `logger.mjs`.

### Phase 2 (advanced resilience)

1. Add retry + timeout to `ghFetch` in `auto_fix_pr.mjs`.
2. Add run-level checkpoints (extend label-based tracking with atomic writes).
3. Make all write-side operations idempotent (labels, comments, outputs).
4. Add exportable reliability metrics.

### Phase 3 (hardening)

1. Add targeted chaos scenarios (simulated timeout/429/5xx).
2. Define SLO targets (e.g., >99% runs without manual intervention).
3. Tune retry budgets based on observed production behavior.

---

## Recommended anti-failure tests

- Unit tests:
  - error classification,
  - backoff/jitter behavior,
  - timeout handling,
  - writer idempotence.
- Smoke tests:
  - transient failure recovered in N attempts,
  - permanent failure stops immediately,
  - interrupted run resumes with valid checkpoint.
- Non-regression tests:
  - no duplicate labels/comments,
  - no writes outside allowed scope.
- Specific regression guard:
  - `llm_client.mjs` fallback must NOT trigger on 401/403.

---

## Risks and trade-offs

- **More resilience = more latency** (acceptable for this objective).
- **More control logic** increases complexity, mitigated by tests + observability.
- **Over-aggressive retries** can hide systemic incidents:
  - use bounded budgets + circuit breaker.
- **Provider fallback** is useful for `TRANSIENT` failures but dangerous for `PERMANENT` ones — the fix must be precise.

---

## Conclusion

If the priority is "**I prefer slower runs, but I do not want failures**", the main axis is:

1. smart retries,
2. idempotence,
3. resume checkpoints,
4. error classification,
5. actionable observability.

The repository is already well-structured for this direction. The most concrete gaps are:
- `anthropic_client.mjs` has zero fault tolerance and must be the first target.
- `llm_client.mjs` masks permanent errors behind provider fallback — a correctness bug, not just a resilience gap.
- `code-generation.yml` missing `timeout-minutes` is a trivial one-line fix with immediate impact.

What is mostly missing is a **uniform, tested transient-failure handling layer** applied consistently across both LLM clients and the GitHub API client.
