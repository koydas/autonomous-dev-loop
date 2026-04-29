# ADR-0007: PR Review Trigger Strategy

- **Date:** 2026-04-29
- **Status:** Accepted

## Context

The PR review workflow (`pr-review.yml`) must fire after every push to a PR branch so the automated review loop can run promptly. The choice of trigger has meaningful consequences for event semantics, permissions, and guard logic.

Two candidate trigger strategies were considered:

1. **`push` to all branches (`branches: ["**"]`)** — fires on every push regardless of PR state; the script resolves the PR number via the GitHub API and exits silently when no open PR exists for the branch.
2. **`pull_request` with `synchronize`/`opened` activity types** — fires only for pushes that are already associated with an open PR; the PR number and diff URL are available directly from the event payload.

## Decision

Use a `push` trigger on `branches: ["**"]`.

Key reasons:

- **Timing of PR creation:** In this pipeline, a PR is opened by the code-generation workflow moments before the first push. Relying on `pull_request: synchronize` would miss that first push unless the generation workflow itself opens the PR in a way that guarantees `opened` fires before review starts, which is fragile with `peter-evans/create-pull-request`.
- **Label-event availability:** The re-pulse strategy (ADR-0006) removes and re-applies `changes-requested` to force a fresh `labeled` event. This re-labeling does not cause a `synchronize` event, so `pull_request`-based triggers would require a secondary event source — adding complexity.
- **Simplicity of the guard:** A silent exit when no PR is found is a clean, low-risk guard. The cost is a few extra API calls on pushes to branches without open PRs (e.g., direct commits to `main`). This overhead is negligible given the repository's usage pattern.

## Guardrails

- The script checks for an open PR at the beginning of each run. If none is found for the pushed branch, it exits immediately without calling the LLM or writing any output.
- The `timeout-minutes: 2` job constraint prevents runaway executions on branches with large diffs or slow API responses.
- The `actions: read` permission is the minimum required to query run status for the re-pulse guard (ADR-0006), and no broader permissions are granted.

## Consequences

- ✅ Review fires reliably on the first push to a new AI branch, even before the PR is fully indexed by GitHub's event system.
- ✅ No secondary event wiring needed for the re-pulse loop; every push (including auto-fix pushes) triggers review naturally.
- ⚠️ Pushes to branches with no open PR (e.g., direct commits to `main`) will invoke the workflow but exit immediately after a single API call — a minor, accepted overhead.
- ⚠️ Contributors adding branch-protection or push rules for `main` should be aware that the review workflow will still fire (and silently no-op) on those pushes.
