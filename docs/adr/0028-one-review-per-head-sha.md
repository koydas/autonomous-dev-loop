# ADR-0028: One LLM review per head SHA

- **Date:** 2026-10-04
- **Status:** Accepted — amended the same day: Groq rate limits are waited out, never fatal (see [Amendment](#amendment-groq-rate-limits-are-waited-out-never-fatal))

## Context

`pr-review.yml` triggers on `push` (every branch but `main`) and on `pull_request: opened`. A new PR fires both for the same head commit, so two runs reach the LLM about a minute apart. Each review request is ~6.6k tokens, and the Groq free tier allows 8k tokens per minute for `openai/gpt-oss-120b` (ADR-0025): the second run got a 429 asking for ~36 s, above the 10 s `LLM_MAX_RETRY_WAIT_MS` the 2-minute review job allowed (ADR-0022), and the review failed.

The two runs also diverged. A run whose evidence was built for one commit could reach the LLM after the PR head moved on. `assessEvidence()` then marked the evidence stale and the verdict came back `WITHHELD` (ADR-0026). The newer push's own run was the one that should judge the new head.

On the auto-fix side, the `changes-requested` label outlives the review that applied it. When a corrective push was approved, a queued auto-fix (or a label event delivered late) still ran against the approved head. It used the approval as feedback, the model returned `changes: []`, and `validateAiOutput()` threw `AI response missing non-empty changes array`: a red check on a PR with nothing left to fix.

## Decision

1. **Review marker.** `pr_review.mjs` ends its review comment with `<!-- adl-review sha=<head sha> verdict=<APPROVE|REQUEST_CHANGES|WITHHELD> -->`. Helpers live in `scripts/lib/review_marker.mjs` (`formatReviewMarker`, `parseReviewMarker`). The marker now steers the pipeline, so it is treated as an authenticated value:
   - **Author:** a review comment is read only when its author is `github-actions[bot]` (the `GITHUB_TOKEN` case) or has `author_association` `OWNER`, `MEMBER` or `COLLABORATOR` (the `AI_PR_TOKEN` case, a member's PAT). Both scripts read every comment page, oldest first, and take the **newest** trusted comment that carries the heading **and a valid marker** (`findReviewComment`). Because `AI_PR_TOKEN` posts as a member, a member's own comment that merely quotes the heading would otherwise be read as the verdict and overwritten by the next upsert. Only on a PR where no trusted comment carries a marker yet (reviewed before this ADR) does the newest trusted heading-only comment count. `pr_review.mjs` never edits a third-party comment that carries the heading.
   - **Position:** `parseReviewMarker` honors only a marker that ends the body. Before appending its marker, `pr_review.mjs` strips every `<!-- adl-review … -->` from the composed body (LLM output, evidence tails), so a marker echoed from a diff or injected through PR content cannot win.
2. **Dedup in the script, not in the triggers.** Both triggers stay: the `push` run for a brand-new branch usually finds no PR yet and exits, so dropping `opened` would leave a new PR unreviewed until its next push. Before the LLM call, `decideReviewRun()` skips the run when:
   - `superseded`: the run's commit (`pull_request.head.sha`, or `after` for a push) is no longer the PR head. The run for the newer push reviews it. This also holds on a manual re-run, since the evidence would be stale.
   - `already_reviewed`: the existing review comment's marker names the current head with an `APPROVE` or `REQUEST_CHANGES` verdict. `WITHHELD` (ADR-0026: evidence missing or stale) is not a judgement of the head, so it never dedups: a healthy run that follows a `WITHHELD` one on the same SHA still reviews. A manual workflow re-run (`GITHUB_RUN_ATTEMPT > 1`) bypasses this check, so an operator can still force a fresh review.
   A skipped run emits `review.skipped` (with `reason`), writes `skipped=true` to `GITHUB_OUTPUT` and exits 0. The `no open PR` exit does the same. `pr-review.yml` skips its checkpoint upload for such a run, so the copy it downloaded cannot replace the newest `checkpoints-pr-<N>` artifact.
3. **Retry budget sized to one Groq TPM window.** The review job's timeout goes from 2 to 5 minutes, with `LLM_MAX_RETRY_WAIT_MS=45000` and `GROQ_MAX_RETRIES=2`. That allows at most 90 s of rate-limit waits, half the timeout at most (enforced in `workflow_gates.test.mjs`). This amends ADR-0022's 10 s figure for pr-review. *Superseded by the amendment below: 15 minutes, 60 s, 12 retries.*
4. **Auto-fix outcomes.**
   - **Stale label:** before touching labels or calling the LLM, `auto_fix_pr.mjs` fetches the PR head and the latest trusted review comment. `decideAutofixRun()` skips with `reason: "approved"` when the marker says `APPROVE` on the current head: `autofix.skipped` (info), no label, no push, exit 0. A trusted checkbox rerun ("Relancer Auto Fixer") overrides this, because the human is the gate (the counterpart of the manual re-run bypass in pr-review).
   - **Reviewer/fixer disagreement:** after the LLM call, an explicit `changes: []` (`hasNoProposedChanges()`) is not swallowed. The attempt label is applied, so it counts toward the cap of 3 and re-triggers stay bounded. The `needs-human` label (`config/labels.yaml` `autofix.needs_human`) is applied and a comment posts the model's `summary`. A `type: "autofix_skip"` metric with `reason: "no_changes"` is written so the rate can be tracked. The run emits `autofix.skipped` (warn), pushes nothing and exits 0.
   - A missing or non-array `changes` is still an error.

ADR-0020's per-PR concurrency group is unchanged: it serializes the two runs, which is what lets the second one see the first one's marker. ADR-0023 is unchanged: scripts still run from the default branch, so this takes effect for PRs reviewed after merge. ADR-0024/0026 are unchanged: evidence and `decideVerdict()` behave as before, and a superseded run now ends before the LLM call instead of producing a stale `WITHHELD`.

## Alternatives Considered

- **Drop the `pull_request: opened` trigger.** Rejected: the first push of a code-generation branch happens before its PR exists, so the PR would wait for a second push to get any review.
- **Drop `push` and use `pull_request: [opened, synchronize]`.** Rejected: it changes the trigger model of ADR-0007 and the concurrency key of ADR-0020 (push events carry only `ref_name`). The duplicate is also a property of any two triggers, not of this pair.
- **Workflow-level dedup (a pre-job querying reviews by `commit_id`).** Rejected: logic in YAML (AGENTS.md "keep workflow YAML dumb"). GitHub reviews also miss the case where review submission is refused on the actor's own PR (comment and labels still apply).
- **Trust only the token's own identity (`GET /user`).** Rejected: an installation `GITHUB_TOKEN` cannot call `GET /user`, and auto-fix runs with `GITHUB_TOKEN` while the review may post with `AI_PR_TOKEN`. The bot login plus member associations covers both tokens.
- **Silent exit 0 on `changes: []`.** First version of this ADR. Rejected in review: it hid a reviewer/fixer disagreement, left the PR in `changes-requested` with nothing moving, and let each re-trigger make an uncapped LLM call.
- **Key the skip on labels in auto-fix (`review-approved` present).** Rejected: labels are not tied to a commit. An approval of an older head must not suppress auto-fix for a newer one that got `REQUEST_CHANGES`.
- **Raise the wait budget while keeping the 2-minute timeout.** Rejected: three 40 s waits plus job setup cannot fit.

## Consequences

- ✅ One LLM review per head SHA: the duplicate `opened`/`push` run ends before the evidence-to-LLM step, which halves review tokens on new PRs and removes the self-inflicted 429.
- ✅ A superseded run no longer posts a stale `WITHHELD`. The run for the current head posts the verdict.
- ✅ A stale `changes-requested` label no longer turns the auto-fix check red. An empty model answer no longer does either, and it reaches a human (`needs-human`, comment, metric) instead of failing as a malformed response.
- ✅ A comment from a non-member, or a marker quoted inside the review, cannot skip a review or an auto-fix.
- ⚠️ A repo member can still post a heading-plus-marker comment by hand. Members are already trusted with the gate (merge, labels, checkbox rerun).
- ⚠️ A comment without a marker (written before this ADR, or edited by hand to remove it) does not dedup: the next run reviews again, which is the previous behavior.
- ⚠️ The skip trusts that a newer push triggers its own run. A push made with `GITHUB_TOKEN` triggers no workflow, so a superseded run then leaves the new head unreviewed until the next push or a manual run. The pipeline's own pushes use `AI_PR_TOKEN` when it is configured.
- ⚠️ The evidence job of a duplicate run still executes (runner minutes, no secrets, no LLM tokens). Only the review job short-circuits.
- ⚠️ The review job can now run up to 5 minutes. It holds the per-PR concurrency group (ADR-0020) for that long in the worst case. *(15 minutes since the amendment.)*

## Amendment: Groq rate limits are waited out, never fatal

**Invariant.** A Groq rate limit must never fail a job; duration is not a constraint. A job may fail only when Groq is down (or saturated) for longer than its timeout.

**Context.** Item 3 did not hold under load. The free tier's 8K TPM is shared by the whole org, across PRs and stages, and `concurrency` is per branch, so it does not serialize PRs:
- Run 37174238930 (#174): Groq answered **413** `{"error":{"code":"rate_limit_exceeded","type":"tokens"}}`, "Limit 8000, Requested 8521". The same request (`input_tokens_est` 7283) passed 48 s later in run 37174265373. `groq_client.mjs` did not retry 413.
- Run 37174756496 (#173): 429 "Used 5096, Requested 7111, try again in 31.5s"; the 5096 came from #174's review, started the same second.
- A 429/413 without `try again in` or `Retry-After` fell back to `retryWithBackoff` (200 ms → 8 s): all retries were spent in seconds against a 60 s window.
- `estimateTokens` (chars/4) runs ~3% low (7,283 estimated vs ~7,497 billed), and the review prompt (diff capped at 12,000 chars, body unbounded) had no token budget. `autofix` was sized at ≈ 7,986 with no margin.
- `groq_max_retries: 3` in `config/models.yaml` was read by nothing.

**Decision.**
1. **413 `rate_limit_exceeded` is a rate limit.** `groq_client.mjs` retries a 413 whose JSON body has `error.code === "rate_limit_exceeded"`; any other 413 stays final.
2. **Hint-less rate limits wait one TPM window.** A 429 or 413 `rate_limit_exceeded` without a wait hint gets `waitMs = 60000` (`TPM_WINDOW_MS`) instead of the short backoff. A hint above `LLM_MAX_RETRY_WAIT_MS` is still not retried.
3. **Input budget with a 10% margin.** For every stage, estimated input × 1.10 + `<stage>_max_tokens` ≤ 8000, with `<stage>_max_input_tokens` in `config/models.yaml` (validation and review 6300, generation 3500, autofix 2600 for the user prompt + ~890 system). `pr_review.mjs` shrinks the diff, then the PR body, to fit (`fitReviewPrompt`, `scripts/lib/token_budget.mjs`); `diff_truncated` stays `true` in the review context and the body carries a truncation note. When the prompt still does not fit with no diff and no body, the job fails with an explicit error and makes no LLM call. Validation and generation fail the same way (`assertInputBudget`), since with (1) an over-budget request would otherwise be retried until the timeout.
4. **Long explicit timeouts.** Each of the five workflows that receive `GROQ_API_KEY` sets `LLM_MAX_RETRY_WAIT_MS: '60000'`, `GROQ_MAX_RETRIES` and `timeout-minutes` on the LLM job, with retries × 60 s ≤ timeout − 3 min: pr-review 12 / 15 min, validate-issue 12 / 15 min, auto-fix-pr 15 / 20 min, code-generation 15 / 20 min, evals 20 / 120 min (and `repeats` defaults to 3). `workflow_gates.test.mjs` enforces the rule for every workflow holding the key, and the margins of `config/models.yaml`.
5. **`groq_max_retries` is removed** from `config/models.yaml`. The retry count depends on each job's timeout, so it belongs next to `timeout-minutes` in the workflow (`GROQ_MAX_RETRIES`); a repo-wide default would contradict four of the five workflows.

**Alternatives considered.**
- **A global `concurrency` group serializing every LLM call.** Rejected: GitHub keeps one pending run per group and cancels the others, so queued reviews would be lost silently.
- **Exponential backoff capped at 60 s.** Rejected: the first retries still land inside the same TPM window and are wasted; one window per retry is the smallest wait that can succeed.
- **Lower `<stage>_max_tokens` instead of the input budgets.** Rejected: reasoning tokens count as output, and a truncated answer fails closed (review) or yields no patch (generation, autofix).
- **Infinite retries.** Rejected: an outage would hold a runner until GitHub's 6 h limit; the explicit timeout bounds it.

**Consequences.**
- ✅ A rate limit (429 or transient 413) delays a job; it no longer fails it, unless Groq stays unavailable for most of the job timeout.
- ✅ A request can no longer exceed 8K tokens on its own (with the 10% margin on the estimate); a 413 is then a shared-window rate limit, and it is retried.
- ⚠️ Jobs can run much longer (pr-review up to 15 min, holding the per-PR concurrency group of ADR-0020 meanwhile; evals up to 2 h).
- ⚠️ A very large PR is reviewed on a truncated diff (as before, but the cut now depends on the rest of the prompt). Generation on an issue citing large files now fails explicitly before the LLM call, instead of with a 413.
- ⚠️ A hint-less rate limit waits 60 s even when Groq would accept the request sooner.
