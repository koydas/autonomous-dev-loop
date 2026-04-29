# ADR-0002: AI provider support (Groq default, Anthropic optional)

- **Date:** 2026-04-14 (updated 2026-04-29)
- **Status:** Updated

## Context

The automation needs an external AI provider with secret-based authentication and a simple API contract. Groq was chosen initially for its API simplicity and remains the default. Anthropic is also supported and can be selected via configuration.

## Decision

Support two LLM providers via a runtime router (`scripts/lib/llm_client.mjs`):

| Provider | Default | Key variable | Model variable |
|---|---|---|---|
| Groq | ✅ yes | `GROQ_API_KEY` | `GROQ_MODEL` (default: `qwen/qwen3-32b` — see ADR-0005) |
| Anthropic | no | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default: `claude-opus-4-7`) |

The active provider is determined automatically by which API keys are present:

| Keys configured | Provider used |
|---|---|
| `GROQ_API_KEY` only | Groq |
| `ANTHROPIC_API_KEY` only | Anthropic |
| Both | Groq (default) — override with `AI_PROVIDER=anthropic` |

`AI_PROVIDER` is only consulted as a tiebreaker when both keys are present.

Architecture:
- `scripts/lib/llm_client.mjs` — provider router, exports `callLLM()`
- `scripts/lib/anthropic_client.mjs` — native Anthropic Messages API client
- `scripts/lib/groq_client.mjs` — OpenAI-compatible Groq client (unchanged)
- `scripts/lib/config.mjs` — `loadLLMConfig(stage)` returns provider-aware config

Temperature is configured per stage in `config/models.yaml` (see ADR-0005).

## Consequences

- ✅ Groq is the default; only `GROQ_API_KEY` is required for a minimal setup.
- ✅ Anthropic is fully supported as an opt-in alternative for higher output quality.
- ✅ Provider switching requires only an environment variable change — no code changes.
- ✅ Each provider has its own isolated client module, independently testable.
- ⚠️ Anthropic's Messages API format differs from OpenAI-compatible APIs (no `response_format: json_object`); Claude models follow JSON instructions in the system prompt instead.
- ⚠️ Workflow availability depends on the active provider's API uptime and rate limits.
