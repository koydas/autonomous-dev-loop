# ADR-0014: Anthropic prompt caching on system prompts

- **Date:** 2026-05-31
- **Status:** Accepted

## Context

Each call to the Anthropic Messages API sends the full system prompt in the request
body. For the automation pipeline, system prompts are large (hundreds to thousands of
tokens) and identical across all calls in a single batch: the same
`generation-system.md`, `auto-fix-system.md`, or `pr-review-system.md` content is
sent on every retry and on every re-invocation of the same stage. Anthropic's API
supports prompt caching, which stores the prefix of a request on Anthropic's
infrastructure for the duration of the cache TTL, avoiding re-processing on subsequent
calls with the same prefix.

Groq, the other supported provider, does not offer an equivalent prompt-caching
mechanism. Any caching behaviour must therefore be provider-specific.

Token thresholds for cache eligibility differ by model family:
- Opus and Sonnet models: ≥1024 tokens in the cached block.
- Haiku models: ≥2048 tokens in the cached block.

System prompts shorter than these thresholds are never cached by Anthropic, even if
`cache_control` is present. This is a silent no-op: the API accepts the field without
error and simply does not cache.

## Decision

In `scripts/lib/anthropic_client.mjs`, send the system prompt as a structured content
block with `cache_control: { type: 'ephemeral' }` instead of a plain string:

```js
system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
```

`type: 'ephemeral'` requests a cache TTL that covers the lifetime of a request batch
(as defined by Anthropic's API). The change is a one-line diff in `callAnthropic()`;
no caller changes are required because the `systemPrompt` parameter remains a plain
string at the call site — the structured wrapping is an implementation detail of the
Anthropic client.

This change applies only to the Anthropic provider. `scripts/lib/groq_client.mjs` is
unchanged.

## Alternatives Considered

**Cache the user prompt instead of (or in addition to) the system prompt** — user
prompts are dynamic (they include the issue body, PR diff, or review feedback), so they
differ on every call. Caching them would yield negligible hit rates. Rejected.

**Implement caching in `llm_client.mjs` (the provider router)** — would require the
router to know about Anthropic's structured content format, creating provider-specific
coupling in a provider-agnostic module. Rejected in favour of keeping the detail inside
`anthropic_client.mjs`.

**Opt-in caching via a caller flag** — adds API surface area for a capability that is
always beneficial when the system prompt exceeds the token threshold. Rejected as
unnecessary complexity.

## Consequences

- ✅ Repeated LLM calls within the same pipeline run (retries, multi-step auto-fix
  loops) pay reduced input-token cost when the system prompt meets the cache threshold.
- ✅ Change is confined to `anthropic_client.mjs`; no caller or router changes needed.
- ✅ Groq calls are unaffected; the providers remain independently isolated.
- ⚠️ Caching is silently skipped for prompts below the token threshold (≥1024 for
  Opus/Sonnet, ≥2048 for Haiku). Operators cannot observe whether a given call was
  actually served from cache without inspecting the `usage` field in the API response.
- ⚠️ This creates a behavioural asymmetry between the Anthropic and Groq providers:
  Anthropic calls benefit from cache savings on repeated system prompts; Groq calls do
  not. Cost comparisons between providers must account for this difference.
