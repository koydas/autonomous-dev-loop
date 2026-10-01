# ADR-0026: Withhold approval when tool evidence is unverified

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

ADR-0024 made a failing check force `REQUEST_CHANGES` in code. Every other evidence outcome was advisory: a check that ended in `timeout` or `error`, evidence that was *missing* (no file, malformed, crashed evidence job) or *stale* (produced for another head SHA) left the LLM verdict untouched. An `APPROVED` from the model was therefore submitted as `APPROVE` with the `review-approved` label even when nothing had verified the code — for example a test suite hanging past `timeout_seconds`, or an evidence job that died before writing its file.

A README audit of this repository found the claim "the model cannot approve red code" false for exactly these cases. The gap is between what the review shows (unverified) and what it does (approve).

ADR-0024 kept these cases advisory for a sound reason that still holds: forcing `REQUEST_CHANGES` applies `changes-requested`, which starts auto-fix, and auto-fix cannot repair a runner outage or a raced push — it would spend attempts and possibly rewrite correct code to chase an infrastructure symptom.

## Decision

The final verdict gets a third value, computed by `decideVerdict(llmApproved, assessment, { evidenceRequired })` in `scripts/lib/review_evidence.mjs`:

| Model verdict | Evidence | Final verdict |
|---|---|---|
| `REQUEST_CHANGES` (or none) | any | `REQUEST_CHANGES` |
| `APPROVED` | available, a check `fail` | `REQUEST_CHANGES` (ADR-0024 override, unchanged) |
| `APPROVED` | missing or stale | **`WITHHELD`** |
| `APPROVED` | available, a check `timeout` / `error` | **`WITHHELD`** |
| `APPROVED` | available, every check `pass` (or no checks declared) | `APPROVE` |

`WITHHELD` in `scripts/pr_review.mjs`:

- submits the GitHub review with event `COMMENT` — no approval, no change request;
- removes both `review-approved` and `changes-requested` and applies neither, so auto-fix is not triggered and the PR does not look approved;
- appends an **Approval withheld** note with the reason to the review comment;
- records `verdict: "WITHHELD"` on the `review.verdict` event and in the trace; `request_changes_count` is not incremented.

The next push re-runs the review with fresh evidence; an operator can also re-run the `pr-review` workflow once the cause (hanging suite, runner failure) is addressed.

**Opt-in preserved.** Evidence stays opt-in per repo (ADR-0024): without `config/review-evidence.yaml` the evidence is always *missing*. `pr_review.mjs` resolves the config exactly as `run_review_evidence.mjs` does (script-relative, or `REVIEW_EVIDENCE_CONFIG`) and passes `evidenceRequired: false` when it is absent, which keeps the pre-ADR behavior for those repos.

## Alternatives Considered

**Force `REQUEST_CHANGES` on any unverified evidence.** Simplest and closest to "fail closed", but it starts auto-fix on infrastructure failures — the exact cost ADR-0024 rejected. Rejected.

**Treat only `timeout` as `REQUEST_CHANGES`** (a hang can be the PR's fault, e.g. an infinite loop). Plausible, but the evidence cannot distinguish a code hang from a slow or overloaded runner, and a wrong guess burns auto-fix attempts. `WITHHELD` still blocks approval and leaves the call to a human. Rejected for now.

**Keep advisory behavior and fix only the README wording.** Honest, but leaves an approval path where nothing was verified. Rejected.

**Retry the evidence job before deciding.** Adds latency and workflow complexity to every review and still needs a rule for when the retry also fails. Not pursued.

## Consequences

- ✅ An `APPROVE` from the pipeline now means every declared check passed on the PR head — the README can state "cannot approve unverified code" again.
- ✅ Infrastructure failures do not consume auto-fix attempts or trigger LLM rewrites.
- ✅ Repos that have not opted in to evidence are unaffected.
- ⚠️ A persistently hanging or crashing check now blocks approval until someone acts; previously it was only visible. This is the intended trade, but it makes the pipeline's own CI health a merge prerequisite.
- ⚠️ A push racing the evidence job (*stale*) withholds approval for that run; the push's own review normally follows and resolves it.
- ⚠️ `WITHHELD` leaves no state label on the PR. Operators read the review comment, not the label set, to see why.
