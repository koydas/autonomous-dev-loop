# ADR-0007: PR Review Trigger Strategy

- **Date:** 2026-04-29
- **Status:** Amended 2026-04-30

## Context

The PR review workflow (`pr-review.yml`) must fire after every push to a PR branch so the automated review loop can run promptly. The choice of trigger has meaningful consequences for event semantics, permissions, and guard logic.

Two candidate trigger strategies were considered:

1. **`push` to all branches (`branches: ["**"]`)** — fires on every push regardless of PR state; the script resolves the PR number via the GitHub API and exits silently when no open PR exists for the branch.
2. **`pull_request` with `synchronize`/`opened` activity types** — fires only for pushes that are already associated with an open PR; the PR number and diff URL are available directly from the event payload.

## Decision

Use a `push` trigger on `branches: ["**"]` combined with a `pull_request: [opened]` trigger.

The `push` trigger alone was insufficient because of a GitHub security rule: when a workflow pushes using `GITHUB_TOKEN`, the resulting push event does not trigger other workflows. The `code-generation.yml` workflow falls back to `GITHUB_TOKEN` when `AI_PR_TOKEN` is not configured, which means `pr-review.yml` never fires on the initial push from `peter-evans/create-pull-request`. Even when a PAT is used, there is a race window where `pr_review.mjs` queries for an open PR before GitHub has finished indexing it.

Adding `pull_request: [opened]` closes both gaps:

- When `code-generation.yml` (or any workflow) opens a PR, the `opened` event fires unconditionally regardless of the token used for the push.
- The event payload carries `pull_request.number` directly, so `pr_review.mjs` reads it at line 42 without a GitHub API lookup — eliminating the race condition.
- The `push` trigger is retained to cover all subsequent pushes to the branch (auto-fix commits, manual fixups) where a PR already exists.

The `pull_request: synchronize` type is intentionally omitted: subsequent pushes are already covered by the `push` trigger, and adding `synchronize` would cause duplicate review runs on every auto-fix commit.

## Guardrails

- The script checks for an open PR at the beginning of each `push`-triggered run. If none is found for the pushed branch, it exits immediately without calling the LLM or writing any output.
- On `pull_request: opened` runs, `pull_request.number` is read directly from the payload; no API lookup is needed.
- The `timeout-minutes: 2` job constraint prevents runaway executions on branches with large diffs or slow API responses.
- The `actions: read` permission is the minimum required to query run status for the re-pulse guard (ADR-0006), and no broader permissions are granted.

## Consequences

- ✅ Review fires on PR open regardless of which token was used to push (`GITHUB_TOKEN` or PAT).
- ✅ Review fires on every subsequent push (auto-fix commits, manual fixups) via the `push` trigger.
- ✅ No race condition between push and PR indexing: `opened` event carries the PR number directly.
- ⚠️ When `AI_PR_TOKEN` is configured and the push succeeds in triggering `pr-review.yml`, the `opened` event will also fire — resulting in two concurrent review runs on the very first commit. Both runs are safe (idempotent comment upsert, label swap); the mild redundancy is accepted.
- ⚠️ Pushes to branches with no open PR (e.g., direct commits to `main`) will invoke the workflow but exit immediately after a single API call — a minor, accepted overhead.
