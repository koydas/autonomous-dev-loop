# ADR-0032: Primary LLM provider with the other as fallback

- **Date:** 2026-10-08
- **Status:** Accepted

## Context

`callLLM()` already tried the second provider when the first one failed, but it called it with the arguments built for the first: `loadLLMConfig()` returned only the primary provider's key, model, URL and budgets. A Groq → Anthropic fallback sent the Groq key and `openai/gpt-oss-120b` to Anthropic, an Anthropic → Groq fallback sent the Anthropic key and a `claude-*` model to Groq: the fallback could only fail (401 or unknown model). The existing fallback test passed because its fetch mock did not check the key.

Two other gaps: an `AI_PROVIDER` other than `groq`/`anthropic` (typo) silently resolved to Groq in `loadLLMConfig()` while `callLLM()` started with Anthropic; and the Groq fallback inherited the call's `responseFormat` only by accident of argument reuse.

## Decision

- `AI_PROVIDER` (`groq` | `anthropic`, case-insensitive) picks the **primary** provider. Unset: unchanged auto-detection (Anthropic when only `ANTHROPIC_API_KEY` is set, Groq otherwise). Any other value throws `Invalid AI_PROVIDER`.
- The other provider is the **fallback**, active only when its API key is set (`detectFallbackProvider()`). No key: the fallback is skipped and the error reads `<provider>: skipped (no API key configured)`.
- The fallback call is built from its own config: `loadProviderConfig(provider, stage)` (key, model, URL, temperature, `max_tokens`, reasoning effort). Only the call itself is carried over: `prompt`, `systemPrompt`, `responseFormat`. Callers pass `stage` to `callLLM()` so the fallback loads the right stage block (`generation` when absent). `loadLLMConfig(stage)` is now `loadProviderConfig(detectProvider(), stage)`.
- Fallback triggers on any primary failure except a permanent one (401/403): an invalid or revoked primary key fails loudly instead of being masked by the fallback.
- Each fallback emits an `llm_fallback` warn event (`from`, `to`, primary error) through `observability.mjs`.

## Alternatives Considered

- **Explicit `AI_FALLBACK_PROVIDER` variable**: with two providers, the fallback is fully determined by the primary; a second variable only adds an inconsistent state (primary = fallback).
- **Fallback on 401/403 too**: keeps the pipeline running on a revoked key, but hides the misconfiguration until the fallback also fails. Rejected: the job failing is the signal.
- **Pass both configs from every caller**: five call sites to change for a decision `callLLM()` can take from the environment.

## Consequences

- ✅ Both directions work: set both keys, choose the primary with `AI_PROVIDER`.
- ✅ A typo in `AI_PROVIDER` fails the job instead of selecting a provider silently.
- ⚠️ The prompt is sized for the primary. Anthropic primary → Groq fallback: the input budgets (`<stage>_max_input_tokens`, ADR-0028) were not applied, so a large prompt can be rejected by Groq (413, not retried). The fallback is best-effort for that direction.
- ⚠️ Fallback output comes from a different model: evals and reviews of that run are not comparable with the primary's (the `llm_fallback` event identifies them).
