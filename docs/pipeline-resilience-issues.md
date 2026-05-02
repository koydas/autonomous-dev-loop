# GitHub Issue Copy/Paste Pack — Pipeline resilience

This file is designed for fast issue creation in GitHub.

How to use:
1. Create a new GitHub issue.
2. Copy one **Title** line.
3. Copy the matching **Body** block exactly as-is.

---

## Issue 1

**Title**
`[FEATURE] Unified TRANSIENT/PERMANENT/UNKNOWN error taxonomy`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Pipeline reliability
- Component: `scripts/lib/*` (error handling + external clients)

## 🚀 Description
Introduce a shared error taxonomy (`TRANSIENT`, `PERMANENT`, `UNKNOWN`) used across modules calling external services (LLM, GitHub API).

Value: consistent retry/fail-fast decisions and reduced behavioral drift across scripts.

## 🧩 Scope
- In:
  - Create a shared error classification module.
  - Explicitly map known cases (timeout, 429, 5xx, business 4xx, invalid payload).
  - Expose a simple API consumed by existing clients.
- Out:
  - Full refactor of unrelated scripts.

## 🧪 Acceptance criteria
- [ ] Functional
  - Errors are deterministically classified according to documented rules.
- [ ] Edge cases covered
  - Ambiguous cases (`UNKNOWN`) are explicitly handled.
- [ ] Tests included
  - Unit tests for 429/5xx/timeout/4xx/invalid payload classification.

## ⚙️ Constraints
No heavy new dependencies; keep API minimal and stable.
```

---

## Issue 2

**Title**
`[FEATURE] Bounded exponential retry with jitter for external calls`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Transient failure tolerance
- Component: `scripts/lib/*client*.mjs`

## 🚀 Description
Create a shared retry utility with exponential backoff + jitter, per-attempt timeout, and max-attempt budget.

Value: better recovery from intermittent incidents without infinite loops.

## 🧩 Scope
- In:
  - `retry_with_backoff` utility.
  - Configurable parameters (max attempts, base delay, max delay, timeout).
  - Integrate into LLM/GitHub clients.
- Out:
  - Global pipeline performance optimization.

## 🧪 Acceptance criteria
- [ ] Functional
  - Transient external failures are retried automatically.
- [ ] Edge cases covered
  - Max attempt count and timeout budget are strictly enforced.
- [ ] Tests included
  - Unit tests for backoff calculation and budget stop behavior.

## ⚙️ Constraints
Reliability is more important than speed. Retries must stay bounded and observable.
```

---

## Issue 3

**Title**
`[FEATURE] Idempotence for labels/comments/generated outputs`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Re-runnability
- Component: scripts managing labels/comments/output

## 🚀 Description
Make all write-side operations idempotent (labels, comments, generated files) so reruns do not create duplicates or inconsistent state.

## 🧩 Scope
- In:
  - "Already applied" checks before write operations.
  - Upsert strategy for comments/labels.
  - Run-context idempotency keys.
- Out:
  - Workflow trigger strategy changes.

## 🧪 Acceptance criteria
- [ ] Functional
  - Re-running with same inputs does not change the final state.
- [ ] Edge cases covered
  - No duplicates after interrupted/retried runs.
- [ ] Tests included
  - Unit + smoke tests for duplicate prevention.

## ⚙️ Constraints
Preserve current business behavior; hardening only.
```

---

## Issue 4

**Title**
`[FEATURE] Run progression checkpoints for interruption recovery`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Execution continuity
- Component: orchestration scripts/workflows

## 🚀 Description
Add minimal progression state (checkpoint) to resume interrupted runs safely without restarting from scratch when safe.

## 🧩 Scope
- In:
  - Minimal state format (step, attempts, timestamp, input version).
  - Conditional resume when checkpoint is valid.
  - Checkpoint invalidation when inputs change.
- Out:
  - Long-term persistence beyond current run context.

## 🧪 Acceptance criteria
- [ ] Functional
  - Interrupted runs can resume successfully for transient failures.
- [ ] Edge cases covered
  - Invalid checkpoints are detected and safely ignored.
- [ ] Tests included
  - Smoke test for resume + no-resume test on changed inputs.

## ⚙️ Constraints
Keep MVP-simple; no additional infrastructure.
```

---

## Issue 5

**Title**
`[FEATURE] Early validation of prerequisites and external payloads`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Reliable fail-fast behavior
- Component: config/prompt loading + external payload parsing

## 🚀 Description
Harden startup validation (secrets/config/prompts) and enforce schema validation for external payloads before costly steps.

## 🧩 Scope
- In:
  - Explicit checks for required secrets/files.
  - Validation of expected payload structure.
  - Actionable error messages.
- Out:
  - Full redesign of global config format.

## 🧪 Acceptance criteria
- [ ] Functional
  - Pipeline fails early with explicit errors when prerequisites are missing.
- [ ] Edge cases covered
  - Incomplete/malformed payloads are classified correctly.
- [ ] Tests included
  - Unit tests for config + payload validation.

## ⚙️ Constraints
Do not hide root causes behind generic messages.
```

---

## Issue 6

**Title**
`[FEATURE] Structured logs and pipeline health metrics`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Operational diagnosability
- Component: `scripts/lib/logger.mjs` + orchestration hooks

## 🚀 Description
Standardize structured logs and produce key metrics (success, retries, error classes, per-step latency) to accelerate failure diagnosis.

## 🧩 Scope
- In:
  - Standard fields (`run_id`, `step`, `attempt`, `duration_ms`, `error_class`).
  - End-of-run summary for success/failure.
  - Basic metric export through logs.
- Out:
  - Mandating an external observability platform.

## 🧪 Acceptance criteria
- [ ] Functional
  - Each run emits end-to-end correlatable logs.
- [ ] Edge cases covered
  - Errors before full initialization are still traceable.
- [ ] Tests included
  - Unit tests for logger + smoke checks for required fields.

## ⚙️ Constraints
Keep logs useful and stable; avoid excessive verbosity by default.
```

---

## Issue 7

**Title**
`[FEATURE] Chaos test scenarios for transient failure recovery`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Robustness validation
- Component: `scripts/tests/*.test.mjs` (including smoke)

## 🚀 Description
Add tests that simulate timeouts, 429, 5xx, and intermittent failures to validate automatic recovery and prevent regressions.

## 🧩 Scope
- In:
  - Mocks/stubs for network/API failure simulation.
  - Recoverable vs non-recoverable cases.
  - Verification of attempt counters.
- Out:
  - E2E tests requiring real third-party services.

## 🧪 Acceptance criteria
- [ ] Functional
  - Transient scenarios pass with retries.
- [ ] Edge cases covered
  - Permanent scenarios fail fast without excessive retries.
- [ ] Tests included
  - New targeted unit + smoke suites.

## ⚙️ Constraints
Tests must be deterministic (no flakes).
```

---

## Issue 8

**Title**
`[FEATURE] Lightweight circuit breaker for consecutive external failures`

**Body (copy/paste):**
```md
## 🎯 Goal
Add a feature that addresses a clear product need.

## 📍 Context
- Repo: autonomous-dev-loop
- Domain: Protection against systemic incidents
- Component: external-call orchestration

## 🚀 Description
Implement a minimal circuit breaker that stops a run when consecutive external failures indicate a systemic incident, avoiding wasted attempts.

## 🧩 Scope
- In:
  - Configurable threshold for consecutive failures.
  - Open/closed state within run context.
  - Explicit logging when breaker opens.
- Out:
  - Distributed cross-run persistent circuit breaker.

## 🧪 Acceptance criteria
- [ ] Functional
  - Run stops cleanly when threshold is exceeded.
- [ ] Edge cases covered
  - Correct reset behavior after an intermediate success.
- [ ] Tests included
  - Unit tests for breaker state transitions.

## ⚙️ Constraints
Behavior must remain predictable and easy to explain; configuration should stay simple.
```
