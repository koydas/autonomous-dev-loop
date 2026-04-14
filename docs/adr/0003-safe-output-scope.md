# ADR-0003: Safe output scope (single generated file)

- **Date:** 2026-04-14
- **Status:** Accepted

## Context

MVP requires low-risk automated code changes and clear failure behavior.

## Decision

Constrain generation to a single predictable file path:
- `ai-generated/issue-<number>.md`

The workflow fails fast and does not open a PR if AI call/validation/patch steps fail.

## Consequences

- ✅ Minimizes blast radius of generated changes.
- ✅ Keeps review surface small and easy to audit.
- ⚠️ Limits usefulness for tasks requiring multi-file edits (out of scope for MVP).
