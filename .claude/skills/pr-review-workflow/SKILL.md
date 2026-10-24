---
description: Four-step PR review response sequence — fix code, reply to thread, resolve thread, conditionally post @Codex review only if code was changed.
---

# pr-review-workflow
## When to Apply
When acting on review comments or inline threads on a pull request in this repository — whether from a human reviewer or from the automated PR review bot.
## Expected Behavior
Follow these four steps in order for every review thread:
### Step 1 — Fix the code
Implement the requested change and push the commit. Do not reply to the thread before the fix is in.
Fix the class, not the instance. Before pushing, for each finding: (1) name the defect class in one phrase, (2) enumerate the same class in the touched function, its file and its siblings (callers, mirrored branches, docs and tests that state the behavior) with a search, not from memory, (3) fix every occurrence in the same commit, each with a regression test that fails on the old code. A neighbour left behind is the next review round. Stay inside the class: an unrelated improvement is still out of scope (`edit-guardrails`). A class that spans more than the PR's files is reported in the reply, not widened.
### Step 2 — Reply to each thread
For every inline review thread you addressed, post a reply explaining:
- What was changed
- Which commit contains the fix (e.g., "Fixed in `abc1234` — …")
If no code change was needed (the comment was a false positive or already correct), explain why in the reply instead.
### Step 3 — Resolve each thread
After replying, mark the thread as resolved. Do not resolve a thread without first posting a reply. Steps 2 and 3 are always paired — never one without the other.
### Step 4 — Request a new review (conditional)
Post a PR comment with `@Codex review` **only if at least one thread required an actual code fix** (i.e., a new commit was pushed). If all threads were addressed with explanations only and no code was changed, do **not** post `@Codex review`. Then, wait for the review bot to re-run and provide a new verdict based on the updated code.
## Constraints
- Never resolve a thread without first posting a reply.
- Never post `@Codex review` unless new code was committed.
- Address all open threads in the same pass — do not leave some threads unresolved after pushing a fix.
- Do not make speculative improvements beyond what the review thread explicitly requests (see `edit-guardrails` skill); the same defect class in the touched code is part of the request.
## References
- `AGENTS.md` — "PR Review Comment Workflow (interactive agents)" section
- `.github/workflows/pr-review.yml` — the automated review bot workflow