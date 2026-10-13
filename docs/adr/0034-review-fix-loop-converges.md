# ADR-0034: The review → auto-fix loop converges — visible findings, code-first diff, APPROVE resets the loop

- **Date:** 2026-10-13
- **Status:** Accepted

## Context

The pipeline's contract is that after each fix the review agent re-runs and, if the fix is right, approves. PR #187 showed four ways the loop broke or degraded even after the false HIGH of ADR-0012 was fixed (ADR-0033):

1. **Findings the fixer cannot act on.** On `816328d` the reviewer asked for an edit to `docs/evals.md`. The diff had been cut inside the ADR table, so neither the reviewer nor the fixer saw that file's hunks. `auto_fix_pr.mjs` only edits files it is shown in full (ADR-0029), so attempt 1 proposed nothing: attempt counted, `needs-human`, loop stopped.
2. **Truncation hid the tests, not the prose.** `filterDiff` keeps git's file order (alphabetical), then the token budget cuts the tail. On #187, `.github/`, `CHANGELOG.md` and the ADR fitted; `docs/evals.md` and `scripts/tests/workflow_gates.test.mjs` did not. The reviewer judged gate (a) on `has_test_file_changes` alone.
3. **An APPROVE left the loop's state behind.** `needs-human` and `auto-fix-attempt-N` stayed on #187 after the APPROVE on `97e1bdc`. Auto-fix counts attempts from those labels (cap 3, AGENTS.md), so a PR that goes red again after an approval started with a partly spent budget, and `needs-human` kept saying a human had to decide something already settled.
4. Re-triggering itself works: auto-fix pushes with `AI_PR_TOKEN` (a PAT), so each fix commit fires `pr-review.yml` (`push`). Commits `971ff38` and `4f040fa` (#173) each got a review run. No change needed.

## Decision

**A. Every finding is fixable from what was shown** (`prompts/pr-review-system.md`). A finding must cite a file and lines in the diff shown, and its fix must not require editing an existing file whose hunks the reviewer did not see. With `diff_truncated: true`, a concern that depends on unseen content (a test, a doc section, a workflow step, a `test.yml` gate past the cutoff) is not a finding: it is listed once under the summary as "Not verified (diff truncated): …", with no severity, and never makes the verdict REQUEST_CHANGES.

**B. APPROVE clears `needs-human`** (`scripts/pr_review.mjs`). The approval is the decision `needs-human` was waiting for.

**C. APPROVE resets the attempt budget** (`scripts/pr_review.mjs`). On APPROVE, every `autofix` label in `config/labels.yaml` is removed: `auto-fix-attempt-1..3` and `needs-human`. The next REQUEST_CHANGES on a new head starts at attempt 1. Not on REQUEST_CHANGES, and not on a withheld approval (ADR-0026): neither closes the loop. A test pins that the `autofix` labels are exactly `auto-fix-attempt-1..MAX_ATTEMPTS` (read from `auto_fix_pr.mjs`) plus `needs-human`, so the reset cannot miss a label the counter reads.

**D. The review diff is ordered code → tests → docs** (`orderDiffForReview`, `scripts/lib/review_prompt.mjs`). Files keep git order within each tier; code is anything that is neither a test (`isTestFile`) nor documentation (`isDocumentationFile`, `change_classifier.mjs`), so prompts and `docs/code-generation.md` (automation scope) stay with the code. The token-budget cut then drops docs before tests and tests before code. Only the diff text is reordered; the classification and automation-gate contexts still read the raw diff, so `docs_updates_present`, `has_test_file_changes` and `changed_files` are unchanged.

## Alternatives Considered

- **Show the fixer every file the reviewer names.** Contradicts ADR-0029: the fixer returns whole files, so an unseen file would be rewritten blind. Rejected for A.
- **Keep the cap global, clear only `needs-human`.** A long-lived PR with three approved rounds would stop auto-fixing forever. The cap exists to stop a non-converging reviewer/fixer ping-pong (ADR-0009); an APPROVE is proof of convergence. Rejected.
- **Reset on any human push.** Needs actor detection on `push` and would let a human reset the cap mid-ping-pong without a verdict. Rejected for "reset on APPROVE".
- **Tests first in the diff.** Would hide the code under review behind its tests on large PRs. Rejected for code → tests → docs.
- **Raise `review_max_input_tokens`.** Bounded by Groq's 8K TPM (ADR-0028). Rejected.

## Consequences

- ✅ A REQUEST_CHANGES always names something the fixer can see and edit; the "reviewer and fixer disagree" stop of #187 cannot come from truncation any more.
- ✅ On a truncated diff the reviewer sees the code and its tests before any prose.
- ✅ After an APPROVE the PR carries no stale `needs-human` / attempt labels; a later red round gets the full 3 attempts.
- ⚠️ **The attempt cap is per fix round, not per PR.** Each round is still capped at 3 and still needs a new head and a fresh review to start; an APPROVE on the same head cannot be followed by REQUEST_CHANGES there (one review per head SHA, ADR-0028), so the reset cannot loop by itself. A PR can now consume more than 3 auto-fix pushes over its life.
- ⚠️ **More truncated diffs pass.** A defect that only shows in an unseen hunk is a "Not verified" note, not a blocking finding. The CI checks (tool evidence, ADR-0024/0026) and the human merge gate still cover it.
- ⚠️ Docs past the cutoff are reviewed less. `docs_updates_present` still feeds gate (b).
- ⚠️ The prompt rule takes effect after merge (`pr-review.yml` runs the default-branch prompt, ADR-0023). The `review` eval replays recorded responses, so it does not measure the new rule; a live `review` eval run does.
