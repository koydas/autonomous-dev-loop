# ADR-0001: Trigger policy and label gate

- **Date:** 2026-04-14
- **Status:** Accepted

## Context

The MVP must run automatically from GitHub issues while avoiding accidental executions.

## Decision

Use a GitHub Actions workflow triggered on `issues.opened`, and run the job only when the issue includes label `ai-task`.

## Consequences

- ✅ Reduces unwanted runs and noisy PR generation.
- ✅ Keeps activation explicit and predictable.
- ⚠️ If the label is added after issue creation, this workflow run will not trigger (MVP limitation).
