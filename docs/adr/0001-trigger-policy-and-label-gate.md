# ADR-0001: Trigger policy and label gate

- **Date:** 2026-04-14
- **Status:** Accepted

## Context

The MVP must run automatically from GitHub issues while avoiding accidental executions.

## Decision

Use a GitHub Actions workflow triggered on `issues.labeled`, and run the job only when the triggered label is `ai-task`.

## Consequences

- ✅ Reduces unwanted runs and noisy PR generation.
- ✅ Keeps activation explicit and predictable.
- ✅ Triggering on `labeled` means the pipeline fires whenever the `ai-task` label is applied, whether at creation time or added later.
