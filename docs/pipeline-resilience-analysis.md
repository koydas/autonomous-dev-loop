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

### Potential weak points (if priority = near-zero failure)

- External API dependencies (LLM, GitHub, etc.) are exposed to:
  - timeouts,
  - intermittent network errors,
  - rate limiting,
  - partial/invalid responses.
- Incomplete recovery risk after run interruption (runner stop/cancel/restart).
- Non-deterministic behavior in some operations (ordering, permissive parsing).

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

## 2) Robust retry strategy for external calls

**Goal**: absorb intermittent failures without destabilizing the full run.

- Retry with **exponential backoff + jitter**.
- Max attempt budget per operation (e.g., 3 to 5 attempts).
- Strict per-call timeout + step-level timeout.
- Simple circuit breaker (if N consecutive failures, stop early).

## 3) Strict idempotence for critical steps

**Goal**: allow safe reruns without inconsistent side effects.

- Compute idempotency keys (issue id, commit SHA, step).
- Before writing, verify expected state is not already applied.
- For labels/comments, prefer upsert semantics over append.

## 4) Checkpointing and explicit run state

**Goal**: resume safely after interruption without starting from scratch.

- Persist minimal state (json/artifact) per run:
  - current step,
  - attempts consumed,
  - latest relevant external results.
- Resume only when checkpoint is valid.
- Invalidate checkpoint cleanly when inputs change.

## 5) Harden input/output validation

**Goal**: fail early on certain causes and avoid late-stage failures.

- Validate at startup:
  - required secrets,
  - config format,
  - required prompt/config files.
- Validate external payload schemas systematically.
- For invalid payloads, classify correctly (often transient if truncated).

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

---

## Implementation plan (resilience MVP)

### Phase 1 (quick wins, high ROI)

1. Add a shared `retry_with_backoff` utility.
2. Add shared error taxonomy (`TRANSIENT/PERMANENT/UNKNOWN`).
3. Apply retries + timeouts to external clients (LLM/GitHub).
4. Add standardized log fields (`run_id`, `attempt`, `error_class`).

### Phase 2 (advanced resilience)

1. Add run-level checkpoints.
2. Make all write-side operations idempotent (labels, comments, outputs).
3. Add exportable reliability metrics.

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

---

## Risks and trade-offs

- **More resilience = more latency** (acceptable for this objective).
- **More control logic** increases complexity, mitigated by tests + observability.
- **Over-aggressive retries** can hide systemic incidents:
  - use bounded budgets + circuit breaker.

---

## Conclusion

If the priority is "**I prefer slower runs, but I do not want failures**", the main axis is:

1. smart retries,
2. idempotence,
3. resume checkpoints,
4. error classification,
5. actionable observability.

The repository is already well-structured for this direction; what is mostly missing is a **uniform, tested transient-failure handling layer**.
