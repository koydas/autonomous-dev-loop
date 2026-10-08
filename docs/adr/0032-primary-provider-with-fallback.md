# ADR-0032: Primary LLM provider with the other as fallback

- **Date:** 2026-10-08
- **Status:** Accepted

## Context

`callLLM()` already tried the second provider when the first one failed, but it called it with the arguments built for the first: `loadLLMConfig()` returned only the primary provider's key, model, URL and budgets. A Groq → Anthropic fallback sent the Groq key and `openai/gpt-oss-120b` to Anthropic, an Anthropic → Groq fallback sent the Anthropic key and a `claude-*` model to Groq: the fallback could only fail (401 or unknown model). The existing fallback test passed because its fetch mock did not check the key. A 401/403 from the primary stopped the chain altogether.

The Anthropic path itself could not succeed on its default model: `callAnthropic()` always sent `temperature: 0`, which Opus 4.7+ and Opus 5.x reject (400); it read `content[0].text`, which is a thinking block when adaptive thinking runs (on by default on Opus 5.x); a 529 (`overloaded_error`) was not retried; a refusal (HTTP 200, `stop_reason: "refusal"`) surfaced as a parsing error. Stage settings (`max_tokens`, effort) were Groq-only: every Anthropic stage ran with `max_tokens: 4096`.

An `AI_PROVIDER` other than `groq`/`anthropic` (typo) silently resolved to Groq in `loadLLMConfig()` while `callLLM()` started with Anthropic.

## Decision

**Provider choice.**
- `AI_PROVIDER` (`groq` | `anthropic`, case-insensitive) picks the **primary** provider. Unset or blank: Anthropic when only `ANTHROPIC_API_KEY` is set, Groq (`DEFAULT_PROVIDER`) otherwise.
- A bad value never fails the job. An unknown value uses that same key-based default; a provider whose key is not set yields to the provider that has one. Each case logs one `provider_config_fallback` warn event per process.

**Fallback.**
- The other provider is the **fallback**, active when its API key is set (`detectFallbackProvider()`). No key: the fallback is skipped and the error reads `<provider>: skipped (no API key configured)`.
- It triggers on **any** primary failure, 401/403 included. Each fallback logs an `llm_fallback` event (`from`, `to`, `error_type`, primary error): `error` level on 401/403 (`PERMANENT`), which also emits a GitHub Actions annotation, since the primary's key is wrong or revoked; `warn` otherwise.
- The fallback call is built from its own config: `loadProviderConfig(provider, stage)`. Only the call itself is carried over: `prompt`, `systemPrompt`, `responseFormat`. Callers pass `stage` to `callLLM()` (`generation` when absent). `loadLLMConfig(stage)` is `loadProviderConfig(detectProvider(), stage)`.

**Anthropic stage settings** (`config/models.yaml`, `anthropic_*` keys).
- `anthropic_<stage>` model (default `claude-opus-5-5`; `ANTHROPIC_MODEL` overrides every stage), `anthropic_<stage>_effort` sent as `output_config.effort` (`ANTHROPIC_EFFORT` overrides every stage, `off` sends none), `anthropic_<stage>_max_tokens` (default 16000; requests are not streamed).
- No temperature is sent unless a caller sets one explicitly.
- The answer is the first `text` block. `stop_reason: "refusal"` throws with its category, so the provider fallback runs. 529 is retried like 5xx.
- Models that support it (`claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-fable-5`, `claude-fable-5-1`) send `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` when `ANTHROPIC_API_URL` is unset (Claude API only): a classifier refusal is re-run server-side on another Claude model before the provider fallback is needed.

## Alternatives Considered

- **Explicit `AI_FALLBACK_PROVIDER` variable**: with two providers, the fallback is fully determined by the primary; a second variable only adds an inconsistent state (primary = fallback).
- **No fallback on 401/403**: surfaces a revoked key by failing the job, at the cost of availability. Rejected: the fallback keeps the pipeline running and the `error`-level event keeps the misconfiguration visible.
- **Fail the job on an invalid `AI_PROVIDER`**: strict, but one typo in a repository variable stops every LLM workflow. Rejected for a logged default.
- **Pass both configs from every caller**: five call sites to change for a decision `callLLM()` can take from the environment.
- **Anthropic SDK instead of `fetch`**: would bring retries and typed errors, but adds the repository's first runtime dependency (ADR-0009 guardrail 4); the raw request stays small.

## Consequences

- ✅ Both directions work: set both keys, choose the primary with `AI_PROVIDER`.
- ✅ A misconfigured `AI_PROVIDER` or missing key degrades to a working provider instead of failing.
- ✅ The Anthropic path works on current models, with per-stage effort and output caps.
- ⚠️ A 401/403 no longer fails the job when the fallback succeeds: watch for `llm_fallback` errors (annotations) or the key stays broken unnoticed.
- ⚠️ The prompt is sized for the primary. Anthropic primary → Groq fallback: the input budgets (`<stage>_max_input_tokens`, ADR-0028) were not applied, so a large prompt can be rejected by Groq (413, not retried). The fallback is best-effort for that direction.
- ⚠️ Fallback output comes from a different model: evals and reviews of that run are not comparable with the primary's (the `llm_fallback` event identifies them).
- ⚠️ Anthropic runs are paid, and thinking tokens count as output: `high` effort on three stages costs more than the model default (`medium`).
