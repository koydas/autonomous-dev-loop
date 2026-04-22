# ADR-0003: Safe output scope (up to 3 generated files)

- **Date:** 2026-04-14
- **Status:** Accepted

## Context

MVP requires low-risk automated code changes and clear failure behavior.
Single-file output proved too restrictive for tasks that naturally span a source file
and its test, so the scope was relaxed to a hard cap of 3 files while keeping the
same safety invariants.

## Decision

Constrain generation to a maximum of 3 validated relative file paths returned by the AI:
- no absolute paths
- no `..` traversal
- duplicate target paths within a single run are rejected
- each file content is capped at 16 000 characters

The workflow fails fast and does not open a PR if the AI call, path validation, or
file write steps fail.

## Consequences

- ✅ Minimizes blast radius of generated changes.
- ✅ Keeps review surface small and easy to audit.
- ✅ Allows source + test (+ optional config) in a single run.
- ⚠️ Tasks requiring more than 3 files remain out of scope for MVP.
