---
name: pr-review-workflow
description: "Use when acting on review comments or inline threads of a pull request, human or bot: fix the class, reply per thread, resolve per thread, post @Codex review only if code changed."
---

# pr-review-workflow

## When to Apply

When acting on review comments or inline threads on a pull request in this repository, from a human reviewer or the automated review bot.

## Expected Behavior

The rules and the four steps are in `AGENTS.md` → **PR Review Comment Workflow (interactive agents)**; follow them in order. Procedure notes:

1. **Fix first.** Push the fix before replying to any thread. For each finding, name the defect class in one phrase and enumerate the same class in the touched function, its file and its siblings (callers, mirrored branches, docs and tests that state the behavior) with a search, not from memory. Fix every occurrence in the same commit, each with a regression test that fails on the old code. A class that spans more than the PR's files is reported in the reply, not widened; an unrelated improvement stays out (`edit-guardrails`).
2. **Reply** on every addressed thread: what changed and the commit (`Fixed in abc1234 — …`), or why no change was needed.
3. **Resolve** each thread after its reply, never before. Address all open threads in the same pass.
4. **`@Codex review`** as a PR comment only if a new commit was pushed.

## References

- `AGENTS.md` — "PR Review Comment Workflow (interactive agents)"
- `.github/workflows/pr-review.yml` — the automated review bot workflow
