# ADR-0002: AI provider support (Anthropic default, Groq fallback)

- **Date:** 2026-04-14 (updated 2026-04-26)
- **Status:** Updated

## Context

The automation needs an external AI provider with secret-based authentication and a simple API contract. Initially Groq was chosen for its API simplicity. The project has since added Anthropic support to improve output quality, with Anthropic becoming the default provider.

## Decision

Support two LLM providers via a runtime router (`scripts/lib/llm_client.mjs`):

| Provider | Default | Key variable | Model variable |
|---|---|---|---|
| Anthropic | ✅ yes | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default: `claude-opus-4-7`) |
| Groq | no | `GROQ_API_KEY` | `GROQ_MODEL` (default: `llama-3.3-70b-versatile`) |

The active provider is selected via the `AI_PROVIDER` environment variable (`anthropic` or `groq`, default: `anthropic`).

Architecture:
- `scripts/lib/llm_client.mjs` — provider router, exports `callLLM()`
- `scripts/lib/anthropic_client.mjs` — native Anthropic Messages API client
- `scripts/lib/groq_client.mjs` — OpenAI-compatible Groq client (unchanged)
- `scripts/lib/config.mjs` — `loadLLMConfig(stage)` returns provider-aware config

Deterministic generation settings remain in effect (temperature `0` for generation and validation, `0.2` for reviews).

## Consequences

- ✅ Anthropic's Claude models improve output quality for generation and review.
- ✅ Groq remains fully supported as a fallback or cost-saving option.
- ✅ Provider switching requires only an environment variable change — no code changes.
- ✅ Each provider has its own isolated client module, independently testable.
- ⚠️ Anthropic's Messages API format differs from OpenAI-compatible APIs (no `response_format: json_object`); Claude models follow JSON instructions in the system prompt instead.
- ⚠️ Workflow availability depends on the active provider's API uptime and rate limits.
