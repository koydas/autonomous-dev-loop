# ADR-0006: Label-driven auto-fix trigger and re-pulse strategy

- **Date:** 2026-04-27
- **Status:** Accepted

## Context

The auto-fix loop initially depended on `pull_request_review` events with `review.state == changes_requested`.
In practice, repositories may block GitHub Actions from submitting formal review events (`REQUEST_CHANGES`) due to repository permissions.
When that happens, the review workflow still applies the `changes-requested` label, but no reliable `pull_request_review` trigger is emitted for auto-fix.

Additionally, once `changes-requested` already exists on a PR, applying it again does not emit a fresh `pull_request:labeled` event.
That caused later review iterations to skip auto-fix.

## Decision

1. **Drive auto-fix from labels**  
   `auto-fix-pr.yml` runs on `pull_request:labeled` and only when the applied label matches `review.changes.name` from `config/labels.yaml`.

2. **Re-pulse `changes-requested` on each REQUEST_CHANGES verdict**  
   In `scripts/pr_review.mjs`, when verdict is `REQUEST_CHANGES`, remove `changes-requested` before adding it again.
   This guarantees a fresh `labeled` event for each iteration.

3. **Fallback feedback source for auto-fix**  
   If the auto-fix trigger payload has no review body, `scripts/auto_fix_pr.mjs` uses the latest automated review comment (`## 🔍 Automated Code Review`) as feedback context.

## Consequences

- ✅ Auto-fix no longer depends on GitHub review-submission permissions.
- ✅ Each request-changes cycle emits a deterministic trigger for auto-fix.
- ✅ Label names remain centralized in `config/labels.yaml` instead of being hardcoded in workflow conditions.
- ⚠️ The review workflow must continue to publish/apply `review.changes.name` correctly for the loop to run.
