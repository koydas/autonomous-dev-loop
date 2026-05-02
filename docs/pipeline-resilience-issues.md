# GitHub Issue Copy/Paste Pack — Pipeline resilience

This file is designed for fast issue creation in GitHub.

How to use:
1. Create a new GitHub issue.
2. Copy one **Title** line.
3. Copy the matching **Body** block exactly as-is.

---

## Priority matrix

Use this table to decide which issues to open first.

| Issue | Title (short) | Affected files | Phase | Urgency |
|---|---|---|---|---|
| 1 | Error taxonomy | `lib/anthropic_client.mjs`, `lib/groq_client.mjs`, `lib/llm_client.mjs` | 1 | **High** |
| 2 | Retry + backoff | `lib/anthropic_client.mjs`, `lib/groq_client.mjs`, `auto_fix_pr.mjs` | 1 | **High** |
| 5 | Early validation | `lib/config.mjs`, `lib/prompts.mjs` | 1 | **High** |
| 6 | Structured logs | `lib/logger.mjs` | 1 | **Medium** |
| 3 | Idempotence | `lib/output_writer.mjs`, `manage_labels.mjs` | 2 | **Medium** |
| 4 | Checkpoints | `auto_fix_pr.mjs`, `workflows/` | 2 | **Medium** |
| 8 | Circuit breaker | `lib/llm_client.mjs`, `auto_fix_pr.mjs` | 2 | **Low** |
| 7 | Chaos tests | `scripts/tests/*.test.mjs` | 3 | **Low** |

> **Quick win not listed above**: add `timeout-minutes: 15` to the `generate-pr` job in `.github/workflows/code-generation.yml`. Single-line change, zero risk, immediate impact — can be done as a standalone commit before any issue is opened.

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

Current state:
- `groq_client.mjs` retries on 429 only — 5xx is not retried.
- `anthropic_client.mjs` has no retry at all.
- `llm_client.mjs` falls back to secondary provider on **any** error, including permanent 4xx (e.g. invalid API key). This is a correctness bug: a 401 should fail fast, not trigger provider fallback.

## 🧩 Scope
- In:
  - Create a shared error classification module.
  - Explicitly map known cases (timeout, 429, 5xx, business 4xx, invalid payload).
  - Expose a simple API consumed by existing clients.
  - Fix `llm_client.mjs` to only fall back on `TRANSIENT` errors.
- Out:
  - Full refactor of unrelated scripts.

## 🧪 Acceptance criteria
- [ ] Functional
  - Errors are deterministically classified according to documented rules.
- [ ] Edge cases covered
  - Ambiguous cases (`UNKNOWN`) are explicitly handled.
  - `llm_client.mjs` does NOT fall back on 401/403/400.
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
- Component: `scripts/lib/anthropic_client.mjs`, `scripts/lib/groq_client.mjs`, `scripts/auto_fix_pr.mjs` (`ghFetch`)

## 🚀 Description
Create a shared retry utility with exponential backoff + jitter, per-attempt timeout, and max-attempt budget.

Value: better recovery from intermittent incidents without infinite loops.

Current state:
- `anthropic_client.mjs`: single `fetch`, zero retry, zero timeout.
- `groq_client.mjs`: retries on 429 only; 5xx throws immediately; no per-call timeout.
- `ghFetch` in `auto_fix_pr.mjs`: no retry, no timeout — a single network error fails the entire run.

## 🧩 Scope
- In:
  - `retry_with_backoff` utility in `scripts/lib/`.
  - Configurable parameters (max attempts, base delay, max delay, timeout).
  - Integrate into `anthropic_client.mjs` and extend `groq_client.mjs` to cover 5xx.
  - Apply to `ghFetch` in `auto_fix_pr.mjs` for GitHub API calls.
- Out:
  - Global pipeline performance optimization.

## 🧪 Acceptance criteria
- [ ] Functional
  - Transient external failures (5xx, network reset) are retried automatically.
- [ ] Edge cases covered
  - Max attempt count and timeout budget are strictly enforced.
  - 429 retry-after header is respected (already implemented in Groq — preserve this).
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
- Component: `scripts/lib/output_writer.mjs`, `scripts/manage_labels.mjs`

## 🚀 Description
Make all write-side operations idempotent (labels, comments, generated files) so reruns do not create duplicates or inconsistent state.

Current state (partial):
- `upsert_issue_validation_comment.mjs` already applies upsert by marker — good model to follow.
- `auto_fix_pr.mjs` label creation tolerates 422 (existing label) — good.
- `output_writer.mjs` overwrites files unconditionally — acceptable but not verified against expected state.
- `manage_labels.mjs` label operations need idempotence verification.

## 🧩 Scope
- In:
  - "Already applied" checks before write operations.
  - Upsert strategy for comments/labels (extend the pattern from `upsert_issue_validation_comment.mjs`).
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
- Component: `scripts/auto_fix_pr.mjs`, orchestration workflows

## 🚀 Description
Add minimal progression state (checkpoint) to resume interrupted runs safely without restarting from scratch when safe.

Current state:
- `auto_fix_pr.mjs` already uses PR labels (`auto-fix-attempt-N`) as a lightweight checkpoint.
- Gap: if the label API call fails after the AI work is done, the checkpoint is lost and the attempt counter is wrong on the next run.
- `code-generation.yml` has no checkpoint mechanism at all.

## 🧩 Scope
- In:
  - Minimal state format (step, attempts, timestamp, input version).
  - Conditional resume when checkpoint is valid.
  - Checkpoint invalidation when inputs change.
  - Atomic write semantics for the checkpoint (write before declaring work done).
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
- Component: `scripts/lib/config.mjs`, `scripts/lib/prompts.mjs`, external payload parsing

## 🚀 Description
Harden startup validation (secrets/config/prompts) and enforce schema validation for external payloads before costly steps.

Current state:
- `requireEnv()` in `config.mjs` already validates required secrets at startup — good.
- Prompt files are loaded on demand but their existence is not verified before the LLM call.
- External payload structure (GitHub event JSON, LLM response JSON) is parsed without schema validation.

## 🧩 Scope
- In:
  - Extend startup checks to prompt and config file existence (`scripts/lib/prompts.mjs`).
  - Validation of expected payload structure for GitHub events and LLM responses.
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

Current state:
- `logger.mjs` already emits JSON lines with `{ level, msg, ...data }` — good foundation.
- Missing fields: `run_id`, `step`, `attempt`, `duration_ms`, `error_class`.
- Without `run_id`, log lines from a single run cannot be correlated in multi-job workflows.
- No end-of-run summary is emitted.

## 🧩 Scope
- In:
  - Standard fields (`run_id`, `step`, `attempt`, `duration_ms`, `error_class`) added to `logger.mjs`.
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

Current state:
- `groq_client.test.mjs` covers 429 retry — good.
- No tests simulate 5xx on Anthropic or Groq.
- No tests verify that `llm_client.mjs` does NOT fall back on permanent 4xx errors.
- No timeout injection tests.

## 🧩 Scope
- In:
  - Mocks/stubs for network/API failure simulation.
  - Recoverable vs non-recoverable cases.
  - Verification of attempt counters.
  - Regression guard: `llm_client.mjs` fallback must not trigger on 401/403.
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
- Component: `scripts/lib/llm_client.mjs`, `scripts/auto_fix_pr.mjs` (`ghFetch`)

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
