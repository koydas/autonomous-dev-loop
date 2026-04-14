# ADR-0002: AI provider choice (Groq)

- **Date:** 2026-04-14
- **Status:** Accepted

## Context

The automation needs an external AI provider with secret-based authentication and a simple API contract.

## Decision

Use Groq Chat Completions API with:
- Required secret: `GROQ_API_KEY`
- Optional variables: `GROQ_MODEL`, `GROQ_API_URL`
- Deterministic generation settings in MVP (temperature `0`).

## Consequences

- ✅ Matches repository setup where Groq key is configured in Actions secrets.
- ✅ Easy provider configuration without hardcoding credentials.
- ⚠️ Workflow availability depends on Groq API uptime/limits.
