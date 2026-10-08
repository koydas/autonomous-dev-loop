# ADR-0029: Deterministic write guard for auto-fix

- **Date:** 2026-10-05
- **Status:** Accepted — extended to code generation, and composed with the static rules (module format, exported signatures, imports), by [ADR-0019](./0019-static-verification-backstop.md)

## Context

Auto-fix keeps deleting large parts of files. The model returns each changed file whole (`file_content`), but it often saw only part of it:

- On the Groq free tier (`autofix_max_input_tokens: 3000`, `autofix_diff_ratio: 0.45`, `autofix_feedback_ratio: 0.25`), file contents got about 837 tokens, roughly 3.3 KB for **all** files together. Each file was also cut at 8,000 characters (`MAX_FILE_SIZE`). Both cuts were silent, and the prompt called the result "the authoritative base". The model therefore sent back the truncated view as the complete file, and everything past the cut was deleted.
- `changes` had to contain 1 to 6 objects, so the model was not allowed to decline. When it could not fix something safely, it rewrote instead.
- Nothing checked that `target_path` was one of the files shown. Writing an existing file that was not in the prompt meant inventing its content.
- `auto-fix-user.md` asked for edits under `scripts/`, `prompts/` and `.github/workflows/`, which the system prompt protects (ADR-0021).

ADR-0009 added prompt guardrails (no test removal, ≤ 30% rewrite) and rejected a validation script as unnecessary infra. In practice, prompt-only guardrails do not hold when the model is asked to reproduce content it never received.

## Decision

1. **A file is shown in full or withheld, never cut.** `auto_fix_pr.mjs` fills the file budget with whole files. A file larger than `MAX_FILE_SIZE`, or one that does not fit in the remaining budget, is replaced by a `File withheld … do NOT target this file` marker.
2. **Write guard before anything touches disk.** `scripts/lib/autofix_guard.mjs` (`findUnsafeChanges`) rejects a change to an existing file when:
   - the file was withheld, or not shown at all;
   - it removes more than `max(20, 30%)` of the file's non-blank lines (multiset line difference, so moved lines do not count);
   - it is a test file and its `test(` / `it(` count drops.

   New files are allowed.
3. **Explicit "blocked" outcome.** Any guard violation is raised as a `GuardrailError` and escalated like the write denylist and the shrink guard (ADR-0021, ADR-0009): an `Auto-Fix: Patch Rejected` PR comment lists the reason per file, no file is written, no `fixed_paths` is emitted, the attempt label and `needs-human` are applied (so the 3-attempt limit holds), `autofix.skipped` is logged with `reason: "guardrail_rejected"`, and the run exits 0. The ADR-0029 guard is stricter than the shrink guard (30% vs 50%) and also covers unshown files and test counts; both run, before any write. The model may also decline with `"changes": []` and a `blocked_reason`: that case goes through the `no_changes` path of ADR-0028 (attempt counted, `needs-human`, `autofix.skipped`), whose comment now shows `blocked_reason` when present, collapsed to one line and capped at 500 chars.
4. **Prompt cleanup.** The system prompt allows 0 to 6 changes and forbids targeting withheld or unshown files. The test rule no longer says "regardless of its path". The user prompt drops the block that invited edits to protected paths and puts the review feedback after the file contents.
5. **Budget rebalance.** `autofix_diff_ratio` goes from `0.45` to `0.15`. Files now get 60% of the budget: the diff mostly repeats them, and only files shown in full can be edited.

## Alternatives Considered

**Stronger prompt wording only** — this is what ADR-0009 did, and the incidents continued. The deletion comes from missing input, which no prompt wording can make up for.

**Search/replace edits instead of whole files** — this removes the failure mode at its root and cuts output tokens. It is deferred to a follow-up because it changes the output contract shared with `output_writer.mjs` and the generation stage. The guard stays useful afterwards as a backstop.

**Fail the job on a guard violation** — this would make the cause harder to find (the job turns red with no PR comment) and does not stop the next review from triggering again. Blocking with a comment and counting the attempt keeps the loop bounded and visible.

## Consequences

- ✅ Auto-fix can no longer write an existing file it did not see in full.
- ✅ Bulk deletions and test removals are rejected deterministically, not just discouraged.
- ✅ "I can't fix this safely" becomes an outcome the operator can see, instead of a forced rewrite.
- ⚠️ A legitimate fix that deletes a lot of code, such as dead-code removal asked for by the review, is blocked and must be done by hand.
- ⚠️ On the Groq free tier, files above roughly 6.5 KB (or several medium-sized files) are withheld, so auto-fix blocks more often. That is the honest outcome for that budget. Raising `autofix_max_input_tokens` or switching to Anthropic removes it.
- ⚠️ A rewrite that keeps most lines textually but changes their meaning is not detected. The guard limits deletion, not correctness.
