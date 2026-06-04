# ADR-0017: Configurable per-stage token budget in `config/models.yaml`

- **Date:** 2026-06-04
- **Status:** Accepted

## Context

`auto_fix_pr.mjs` calculates its input budget as a direct function of the LLM model's full context window. For `llama-3.3-70b-versatile` (context window: 131,072 tokens) the formula produced an input budget of ~126,000 tokens, distributed across diff, review feedback, and file contents.

In practice the auto-fix stage was sending requests of ~16,000–17,000 tokens total. On Groq's **on_demand** service tier, `llama-3.3-70b-versatile` is subject to a **12,000 TPM (tokens-per-minute) hard limit that is enforced per request**: any single request whose total token count (prompt + requested output) exceeds 12,000 receives HTTP 413. This is distinct from a rate-limit retry scenario — there is no backoff that resolves it; the request itself is too large.

This caused every run of `auto-fix-pr.yml` to fail with:

```
groq: Groq API HTTP error 413: Request too large … Limit 12000, Requested ~16685
```

The Anthropic fallback was not available (invalid `ANTHROPIC_API_KEY`), so all 4 auto-fix runs on a single PR failed in a 15-hour window.

Two root causes compounded:
1. The input budget was derived from the full context window (131k), not from the provider's per-request limit.
2. There was no operator-facing knob to tune the budget without touching source code.

## Decision

Add three optional per-stage keys to `config/models.yaml` and surface them through `loadLLMConfig(stage)`:

| Key | Type | Default (if absent) | Description |
|---|---|---|---|
| `{stage}_max_input_tokens` | positive integer | context window - margins | Hard ceiling on the input budget passed to the LLM call |
| `{stage}_diff_ratio` | float in (0, 1) | `0.45` | Fraction of input budget allocated to the PR diff |
| `{stage}_feedback_ratio` | float in (0, 1) | `0.25` | Fraction of input budget allocated to review feedback |

`auto_fix_pr.mjs` applies them as:

```js
const contextWindowBudget = contextWindow - TOKEN_SAFETY_MARGIN - systemTokens - maxOutputBudget;
const inputBudget = cfgMaxInputTokens != null
  ? Math.min(contextWindowBudget, cfgMaxInputTokens)
  : contextWindowBudget;
const diffBudget     = Math.floor(inputBudget * (cfgDiffRatio     ?? 0.45));
const feedbackBudget = Math.floor(inputBudget * (cfgFeedbackRatio ?? 0.25));
const fileBudget     = inputBudget - diffBudget - feedbackBudget;
```

The repository default for `autofix_max_input_tokens` is **7,400**, calculated to keep the total request within Groq on_demand's 12k limit:

```
system (~460) + input (7,400) + max_output (4,096) = 11,956 < 12,000
```

## Consequences

- ✅ Auto-fix no longer hits Groq HTTP 413 on the `on_demand` tier.
- ✅ Operators can tune the budget without code changes — edit `config/models.yaml` and push.
- ✅ Upgrading to Groq Dev Tier or switching to Anthropic requires only increasing (or removing) `autofix_max_input_tokens`.
- ⚠️ A lower input budget truncates diff and file contents; very large PRs may receive incomplete fixes. Monitor `token_estimate` log lines to detect consistent truncation.
- ⚠️ `diff_ratio + feedback_ratio` must sum to less than 1.0; the remainder goes to file contents. Validation is enforced in `loadLLMConfig` at startup.
- ⚠️ When a new pipeline stage with similar provider constraints is added, the same three YAML keys must be defined for that stage and consumed in the corresponding script.
