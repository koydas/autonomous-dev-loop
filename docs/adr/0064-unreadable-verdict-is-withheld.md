# ADR-0064: A review with no readable verdict is withheld, not a request for changes

- **Date:** 2026-10-27
- **Status:** Accepted

## Context

`pr_review.mjs` reads the model's verdict from a `### 🚀 Verdict` line followed by `APPROVED` or `REQUEST_CHANGES` and, when it finds none, "fails closed": not approved, which is REQUEST_CHANGES. Failing closed was the safe side of an approval. It is the wrong side of the auto-fix: REQUEST_CHANGES puts the `changes-requested` label on the PR and starts the auto-fixer, which is sent a comment that holds no request. On #311 the model answered in another layout (`APPROVED` at the top, no verdict line, no finding); the PR got `changes-requested` and the auto-fix workflow started. [ADR-0026](./0026-withhold-approval-on-unverified-evidence.md) rejected the same reflex for infrastructure failures ("starts auto-fix on a failure the fixer cannot fix"), and [ADR-0038](./0038-withhold-approval-on-unreviewed-code.md) and [ADR-0061](./0061-evidence-for-findings-outside-the-diff.md) withhold a REQUEST_CHANGES that cannot be acted on.

## Decision

1. **No readable verdict is WITHHELD** (`withheld_for: unreadable_verdict`): a COMMENT review, the `review-withheld` label (neither `review-approved` nor `changes-requested`), a note in the comment saying why, no auto-fix. A human reads the comment.
2. **Deterministic defects keep their REQUEST_CHANGES.** A failing check ([ADR-0024](./0024-tool-evidence-for-pr-review.md)) or a guardrail finding ([ADR-0060](./0060-guardrail-findings-in-the-review.md)) is a defect whatever the model wrote; so does a decision that is already WITHHELD for its own reason.
3. **The parser does not guess.** No approval is inferred from prose (`APPROVED` at the top of a free-form answer): the answer is unreadable, and that is all the tool says. Widening the accepted layouts is a separate decision, with a test per layout.
4. **The eval suite is unchanged.** The `review` suite counts a missing verdict as an errored run (`error_rate`), as before: counting it as a withheld review would hide a format regression behind a verdict.

## Alternatives Considered

- **Keep failing closed to REQUEST_CHANGES.** Starts auto-fix on a review that holds no request, three attempts that cannot succeed, and `needs-human` at the end: a human reads it anyway, later.
- **Read the first `APPROVED` or `REQUEST_CHANGES` word anywhere.** A review that quotes "REQUEST_CHANGES" in a finding about the verdict logic itself would approve or reject by accident.
- **Re-ask the model for a verdict.** A second call per unreadable answer, and an answer the model may also get wrong; a human is the cheaper gate for a rare event.

## Consequences

- ✅ A format drift of the reviewer model costs a human read, not an auto-fix loop.
- ✅ A review that is withheld is visible: label, note, and `review.verdict` with `withheld_for: unreadable_verdict` (the rate of this reason is the signal that the prompt's layout is drifting).
- ⚠️ A truncated answer that held a real REQUEST_CHANGES finding is withheld too: the comment is posted, a human reads it, auto-fix does not run on it.
- ⚠️ Anything that matched the old behavior (an unreadable verdict is REQUEST_CHANGES) changes: three `pr_review` tests did.
