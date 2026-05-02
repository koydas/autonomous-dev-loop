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

https://github.com/koydas/autonomous-dev-loop/issues/109

---

## Issue 2

**Title**
`[FEATURE] Bounded exponential retry with jitter for external calls`

https://github.com/koydas/autonomous-dev-loop/issues/111

---

## Issue 3

**Title**
`[FEATURE] Idempotence for labels/comments/generated outputs`

https://github.com/koydas/autonomous-dev-loop/issues/113

---

## Issue 4

**Title**
`[FEATURE] Run progression checkpoints for interruption recovery`

https://github.com/koydas/autonomous-dev-loop/issues/116

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
