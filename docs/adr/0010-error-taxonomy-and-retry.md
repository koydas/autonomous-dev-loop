# ADR-0010: Error taxonomy and bounded retry with jitter

- **Date:** 2026-05-01
- **Status:** Accepted

## Context

External LLM API calls (Groq, Anthropic) and GitHub API calls fail in two fundamentally different ways:

- **Transient failures** (rate limits, timeouts, 5xx) — the operation can succeed if retried after a delay.
- **Permanent failures** (401 unauthorised, 403 forbidden) — retrying is pointless and wastes quota.

Without a shared classification, each script handled errors ad-hoc: some retried on every exception, some not at all. This caused silent quota exhaustion on rate-limit storms and failed quickly on recoverable timeouts.

## Decision

Introduce two dedicated modules:

**`scripts/lib/error_taxonomy.mjs`** — single source of truth for error classification:

| Category | Triggers | Retry? |
|---|---|---|
| `TRANSIENT` | `timeout`, HTTP `429`, HTTP `5xx` | ✅ yes |
| `PERMANENT` | HTTP `401`, `403` | ❌ no |
| `UNKNOWN` | anything else | ✅ yes (conservative) |

**`scripts/lib/retry.mjs`** — bounded exponential back-off with jitter:
- Default: 4 attempts, base delay 200 ms, max delay 8 s
- Delay formula: `min(maxDelay, baseDelay × 2^attempt) × U(0.8, 1.2)` (±20 % jitter)
- Callers can inject `error.retryable = false` to skip retry unconditionally.
- Callers can inject `error.waitMs` to override the computed delay (useful for `Retry-After` headers).

Both modules are imported by `llm_client.mjs` and `auto_fix_pr.mjs`.

## Alternatives Considered

**Retry inside each client module** — duplicates logic and diverges over time. Rejected.

**Exponential back-off without jitter** — causes thundering-herd on concurrent workflow runs hitting the same rate limit. Rejected.

**No retry, fail fast everywhere** — too aggressive for ephemeral 429s, especially on Groq's free tier. Rejected.

## Consequences

- ✅ All external calls share the same retry semantics.
- ✅ Permanent auth failures surface immediately without wasting quota.
- ✅ Jitter distributes retry load across concurrent workflow runs.
- ⚠️ `UNKNOWN` errors are retried by default; a misbehaving API returning a non-standard error code could cause unnecessary retries. Adjust `ERROR_TYPES.PERMANENT` if that happens.
