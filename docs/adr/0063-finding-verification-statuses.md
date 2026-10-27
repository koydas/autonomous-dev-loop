# ADR-0063: Every finding gets a verification status, and only substantiated findings request changes or reach the auto-fixer

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

[ADR-0061](./0061-evidence-for-findings-outside-the-diff.md) (RV-04a) made a finding about code outside the diff prove itself: a quote, checked in the PR tree. It left the other findings as they were: any High or Medium finding that names a file of the diff, whatever its lines, requests changes and goes to the auto-fixer. A finding can point at lines of that file the reviewer was never shown, and the fixer receives the whole comment, so a claim nobody substantiated starts an auto-fix loop (three attempts) that cannot succeed. The process rules of the adversarial protocol ([ADR-0049](./0049-adversarial-review-protocol.md)) do not catch it: the finding is well formed.

## Decision

1. **A status per finding, computed in code** (`substantiateFindings`, `finding_evidence.mjs`; deterministic, no LLM):
   - **verified**: every quote of its `Evidence:` field is written in the PR tree near the line given (ADR-0061, for any finding, in the diff or not).
   - **supported**: it points at the diff: a cited file is in the diff and its lines, if it gives them, fall in a hunk of that file (old or new side) give or take 5 lines (the tolerance of the finding-level metrics). A file with no hunk (a rename) counts as located. With no list of the files of the diff (no `diff --git` header) nothing can be judged and a finding is supported as before.
   - **refuted**: it is not located in the diff and a quote it gives is not in a file that was read.
   - **unverified**: any other finding that is not located: outside the diff without a checked quote, no file, lines the diff does not show.
2. **Only substantiated findings decide.** A blocking (High or Medium) finding that is neither verified nor supported is unproven. A REQUEST_CHANGES whose blocking findings are all unproven becomes WITHHELD (`withheld_for: unproven_findings`, the rule of ADR-0061, now over every finding); a failing check, a guardrail finding or an approval is never changed.
3. **The auto-fixer is sent what was substantiated.** When changes are requested, the unproven findings leave `### ⚠️ Issues Found` for a `### 🔎 Unsubstantiated Findings` section (text intact, a human reads it), which `auto_fix_pr.mjs` strips from the review comment it uses as feedback. A refuted or unverified finding therefore neither blocks alone nor costs an attempt.
4. **Visible.** The `### 🔎 Evidence Check` section lists every blocking finding with its status; `review.finding_evidence` carries the counts (`verified`, `supported`, `unverified`, `refuted`, `unproven`).
5. **Escalation is unchanged.** When the fixer still cannot fix a substantiated finding, the existing paths apply: no proposed change or a rejected patch is `autofix.escalated` with `needs-human`, three attempts end the round, and an open circuit breaker ([ADR-0050](./0050-circuit-breaker-review-loop.md)) escalates without re-pulsing auto-fix. What this ADR removes is the attempts spent on claims that were never substantiated.

## Alternatives Considered

- **Keep the status to outside findings (ADR-0061).** Leaves the in-diff case, where a model cites lines it was not shown, to the fixer.
- **Ask the model for a confidence.** Self-reported, unverifiable, and the same blind spot as the claim.
- **Run the claim (a reproduction).** The right answer for behavior claims; it needs the isolated runner of [ADR-0052](./0052-isolated-grader-for-executable-evals.md) and is RV-07.
- **Drop unproven findings from the comment.** Hides the model's output from the person who merges. They are moved, not deleted.
- **Treat a finding with no file as supported (as ADR-0061 did).** Nothing says where to fix it; the fixer cannot act on it. It is unverified and a human reads it.

## Consequences

- ✅ A review requests changes only on a finding that points at shown lines or quotes text the tree holds; the auto-fixer gets only those.
- ✅ The same code decides in production and in the `review` suite (`output.evidence_check` carries the counts).
- ⚠️ Location is a line window, not a proof that the finding is right: a supported finding is a claim about shown code, which a human still merges on.
- ⚠️ A correct finding whose line numbers are far off (a function cited by its start, a hunk far away) is unverified and, alone, withholds the review: a human reads it, auto-fix does not run. The tolerance is one constant; it is to be tuned on live runs, which this ADR does not have (the published runs are not reachable from the session that wrote it).
- ⚠️ Refuted is narrower than it sounds: only a quote against a file that was read. An unreadable, missing or oversized file is unverified.
