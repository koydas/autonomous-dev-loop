# ADR-0038: Withhold approval when code was cut from the reviewed diff

- **Date:** 2026-10-13
- **Status:** Accepted

## Context

`buildReviewPrompt` fits the diff to the input budget. On Groq that budget is `review_max_input_tokens` (6300); the system prompt alone takes ~2.4k tokens, so a diff of more than roughly 150 lines is cut. On Anthropic the diff is capped at 12,000 characters. `orderDiffForReview` (ADR-0034) puts code first, then tests, then documentation, so prose and tests are cut before code. A large enough PR still loses code.

When the diff is cut, the model is told `diff_truncated: true` and must say so in its review. It is not stopped from answering `APPROVED`. `decideVerdict` (ADR-0026) then turns that answer into `APPROVE` and the `review-approved` label, for code that no model read. #194 was approved with the note "the diff view is truncated; only the visible hunks were reviewed". In that case only tests and the CHANGELOG were cut, but nothing would have changed if code had been.

## Decision

`buildReviewPrompt` also returns `unreviewedCodeFiles`: the files of the first tier of `orderDiffForReview` (not a test, not documentation, per `change_classifier.mjs`) whose diff was not put in the prompt in full. `findUnreviewedCodeFiles(fullDiff, shownDiff)` computes the list. It relies on the shown diff being a prefix of the filtered, ordered diff, which is how both the budget cut and the 12k cap work.

`withholdOnUnreviewedCode(decision, unreviewedCodeFiles)` runs after `decideVerdict`:

| Decision from `decideVerdict` | Code cut | Final verdict |
|---|---|---|
| `APPROVE` | yes | **`WITHHELD`**, reason `code cut from the reviewed diff: <files>` |
| `APPROVE` | no (nothing cut, or only tests / docs) | `APPROVE` |
| `REQUEST_CHANGES` / `WITHHELD` | any | unchanged |

`WITHHELD` takes the ADR-0026 path. The review is submitted as `COMMENT` with the `review-withheld` label, and auto-fix is not triggered. The note in the comment names the files. `review.verdict` gains `unreviewed_code_files` (a count).

The `review` eval suite applies the same rule, so the eval keeps measuring the production code path (ADR-0027). On the current dataset no case has code cut: only `truncated-diff-visible-bug` is truncated, and its code is shown in full. Scores are unchanged.

## Alternatives Considered

**Include tests in the rule.** A cut test hunk can hide a weak assertion; on #194 a behavior claimed in the PR body had no test, and the model could not see it. But tests are also run by the tool evidence (ADR-0024), and on Groq most medium PRs lose some test lines: the rule would withhold almost every one of them and become noise. Rejected for now.

**Force `REQUEST_CHANGES`.** Auto-fix cannot make a PR smaller or the budget larger, so it would spend attempts on a problem it cannot fix. Rejected for the same reason as in ADR-0026.

**Raise the budget instead.** That is the provider choice (ADR-0032, #199) and does not remove the case: the Anthropic path still caps the diff at 12,000 characters. Complementary, not a substitute.

**Prompt rule only (do not approve a truncated diff).** It already exists in the classification context and was not followed on #194. A rule in code cannot be ignored by the model.

## Consequences

- ✅ An `APPROVE` now means the model was shown every code hunk of the PR.
- ✅ No auto-fix attempt is spent: the PR waits for a human under `review-withheld`.
- ⚠️ On Groq, a large PR can no longer be approved by the pipeline. It needs a human review, a split, or the Anthropic provider. This is the intended trade.
- ⚠️ `WITHHELD` never dedups (ADR-0028). A head can be reviewed twice (`push` and `pull_request: opened`) with the same truncation and the same result, which costs one more LLM call per head on a large PR.
- ⚠️ Tests and documentation cut from the diff still do not block approval (see Alternatives).
