# ADR-0004: PR authentication token strategy

- **Status:** Accepted
- **Date:** 2026-04-14

## Context

The workflow opens pull requests from GitHub Actions (`.github/workflows/ai-issue-to-pr.yml`).
Some repositories/organizations disable the setting that allows `GITHUB_TOKEN` to create or approve PRs.
In that configuration, the run fails with:

`GitHub Actions is not permitted to create or approve pull requests.`

MVP still requires fail-fast behavior and deterministic PR creation when an issue receives
the `ready-for-dev` label.

## Decision

Use a dedicated secret token for PR-related writes when available:

- Prefer `secrets.AI_PR_TOKEN`.
- Fallback to `secrets.GITHUB_TOKEN` when `AI_PR_TOKEN` is not configured.

Apply this strategy to PR creation (`peter-evans/create-pull-request`).

## Consequences

- Works in stricter org/repo policies without changing MVP orchestration.
- Keeps backward compatibility for repositories that rely on `GITHUB_TOKEN`.
- Requires setup documentation for `AI_PR_TOKEN` scopes and repository settings.
