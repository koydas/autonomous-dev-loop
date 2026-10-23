# ADR-0050: Circuit breaker on the review → auto-fix loop, and Retry-After on the Anthropic client

- **Date:** 2026-10-23
- **Status:** Accepted

## Context

The loop is bounded by three things: 3 auto-fix attempts per round, counted from `auto-fix-attempt-N` labels (AGENTS.md); one LLM review per head SHA (ADR-0028); human merge. Two of those can be cleared. An APPROVE removes the attempt labels (ADR-0034 §C), and the "rerun auto-fix" checkbox removes them on demand, so a PR whose fixes do not change the review outcome can be sent round again and again, each round paying for a review and a fix. The label count also cannot tell "three different problems" from "the same problem three times", and the second is the one that will not converge.

Rate limits are handled already: `retryWithBackoff` honors `Retry-After` and the Groq TPM window (ADR-0022, ADR-0028), a wait beyond `LLM_MAX_RETRY_WAIT_MS` fails fast, and `callLLM` then falls back to the other provider (ADR-0032). One gap: the Anthropic client retried a 429/529 on its short exponential backoff and ignored `Retry-After`, so it either hammered a limited endpoint or, with a long wait, burned its retries inside the window.

## Decision

1. **A failure signature per review.** `failureSignature` (`scripts/lib/circuit_breaker.mjs`) fingerprints a REQUEST_CHANGES by what it reports: the failing checks of the tool evidence plus the files its findings cite (10 hex chars). Line numbers, wording and severity are left out, so a fix that moves the defect or a reviewer that rephrases it is still the same failure. A review naming neither has no signature and claims no streak.
2. **The count rides in the review marker**, next to the head SHA and verdict: `<!-- adl-review sha=… verdict=REQUEST_CHANGES streak=3 sig=0123456789 -->`. Optional fields, so every marker written before still parses, and the marker's anchoring and trust rules (ADR-0028) are unchanged. No store, no label, no permission. `nextStreak` continues the streak when the previous trusted review was a REQUEST_CHANGES with the same signature, restarts it at 1 otherwise, and ends it on APPROVE or WITHHELD.
3. **ESCALATED at `BREAKER_THRESHOLD` (3) consecutive identical failures.** The third identical REQUEST_CHANGES: the review is still posted and still REQUEST_CHANGES (the PR is red), but `changes-requested` is **not re-pulsed** (the re-pulse is what starts auto-fix), `needs-human` is set, the comment carries a `🚨 ESCALATED` note, and `review.escalated` is journaled (`reason: circuit_breaker`, `streak`). ESCALATED is a state, not a fourth verdict: it is `needs-human` plus a halted loop, the vocabulary the dashboard already has ("Waiting on you", `*.escalated`), explained by design in `explainEscalation`.
4. **Auto-fix stops on an open breaker too** (`decideAutofixRun`, reason `circuit_open`), before any LLM call, for the other ways a run can start (the label already present, a re-applied label). A trusted human rerun overrides it (human as gate), as it overrides the approval skip.
5. **What resets it**: a different failure signature, an APPROVE, or a WITHHELD between. Nothing a bot does in the loop clears it; the attempt-label reset does not.
6. **Why 3, and what "more than 3" means.** Three failing reviews in a row with the same signature is two fixes that changed nothing; the third automated fix is not started. It is stricter than the label cap (3 attempts) only for identical failures, and it is the same number as the cap so there is one figure to remember. It is a constant, not a setting: raising it needs an ADR (ADR-0046 §5 already forbids a lever on the attempt cap).
7. **Anthropic `Retry-After`** (`anthropic_client.mjs`): a retryable response (429, 5xx, 529) with a `Retry-After` waits that long instead of the backoff, within the Groq client's budget (`LLM_MAX_RETRY_WAIT_MS`, 60 s default); a longer wait is not retryable, so `callLLM` falls back at once instead of idling until the job timeout.
8. **Quota exhaustion is not counted as a failure of the task.** A run that dies on a 429 posts no review comment, so it leaves the marker, and the streak, untouched; the breaker counts reviews, not infrastructure.

## Alternatives Considered

- **Count in a label (`breaker-N`).** The same store the cap uses, and the same weakness: cleared by a reset, no signature. Rejected.
- **Count auto-fix pushes in the checkpoint** (`pr_metrics`). Checkpoints are artifacts passed between workflows and expire (retention days); the marker lives as long as the PR.
- **Compare the diffs the fixer produced.** Needs the history of pushes and a notion of "equivalent patch". The reviewer's own findings already say whether the fix helped.
- **A new `ESCALATED` review verdict.** It would touch the marker values, the labels, the verdict metrics, the dashboard states and every consumer of `REVIEW_VERDICTS` for what is already `REQUEST_CHANGES` + `needs-human`.
- **Back off and retry later on quota exhaustion.** A job cannot sleep for a daily quota (the eval harness has the same circuit breaker for it, `detectQuotaExhaustion`); a red run that says which provider refused is the useful signal, and the fallback already moved to the other provider first.

## Consequences

- ✅ A PR that does not converge costs three identical reviews, not an unbounded number; the stop is visible (`needs-human`, ESCALATED note, journal) and the human decides.
- ✅ The cap is no longer the only bound: it survives a manual reset and an unrelated APPROVE.
- ✅ No new label, workflow, token scope or store; old markers keep working.
- ⚠️ A loop that alternates between two different failures never trips (the signature changes). That is bounded by the label cap only.
- ⚠️ Two defects in the same file are one signature: a fix that cures one and exposes the other in that file counts as no progress. Tracking findings individually would need the model's wording, which is not stable enough to compare.
- ⚠️ The streak counts reviews of head SHAs, one per SHA (ADR-0028); a manual re-run of the same head (run attempt > 1) re-reviews and can count again. A human re-running three times is not a loop.
