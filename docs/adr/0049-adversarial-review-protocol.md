# ADR-0049: Adversarial review protocol: four axes, and no approval without two named risks

- **Date:** 2026-10-23
- **Status:** Accepted

## Context

The review stage is the loop's quality gate, and a model asked "is this diff correct?" leans towards "yes". ADR-0034 and the over-strictness fixes of #267 pulled the prompt the other way on purpose (a Low note alone is APPROVED, a High or Medium finding names a concrete input), so the prompt cannot simply be made harsher: the false REQUEST_CHANGES it would produce starts an auto-fix loop on a correct PR (ADR-0012, ADR-0033).

What is missing is not severity but **a forced attack on the diff before the verdict**, and a check in code that it happened. A rule only in the prompt is a request; the pipeline already treats such rules as requests (ADR-0024: a failing check blocks APPROVE in code, whatever the model concluded; ADR-0038: so does unseen code).

## Decision

1. **Four fixed axes**, one line each under a new `### 🔬 Adversarial Analysis` section of the review (`prompts/pr-review-user.md`, rule in `prompts/pr-review-system.md`): Robustness (empty, null, boundary, failing and concurrent inputs), Side effects (callers, shared state, I/O, ordering), Type integrity (signatures, return shapes, coercions, module format), Issue fit (what the issue asks that the diff misses, or the diff does beyond it). A line names a concrete risk with `file:line`, or says "none" and what was checked.
2. **The analysis is observation, not finding.** It does not change the verdict rules: REQUEST_CHANGES still needs a High or Medium finding or a FAIL check, a Low note alone still approves (#267). The protocol only adds a precondition to APPROVED.
3. **No APPROVED without two critical points**: at least 2 axes must name a risk or weak point (a residual one counts). Enforced in code, not only asked: `enforceAdversarialProtocol` (`scripts/lib/adversarial_review.mjs`) turns an APPROVE whose parsed analysis has fewer than `MIN_CRITICAL_POINTS` (2) risks into **WITHHELD**, after the evidence (ADR-0024/0026) and unseen-code (ADR-0038) decisions. WITHHELD is the existing "no approval, no REQUEST_CHANGES" state (ADR-0026): the comment says why, `review-withheld` is applied, auto-fix is not triggered, and the next push or a manual re-run reviews again. A section that is missing, empty, echoes the template placeholders, or says "none" on every axis counts as no point.
4. **Each blocking finding carries an `Axis:` tag** (`robustness | side_effects | types | issue_fit | other`, last field of the finding line). `blockingFindingAxes` reads the closed ids off High and Medium findings only. They are the adverse decisions the meta-loop learns from (ADR-0051); a missing or unknown tag counts for nothing.
5. **Journal and diagnostics.** `review.verdict` gains `withheld_for` (`protocol` or null), `adversarial_points`, `adversarial_axes` and `blocking_axes` (closed ids, never the model's text: `EVENT_META_ALLOWLIST`). `withheldCause` classifies a protocol withhold as `protocol`, and the `review-withheld` rule counts it as an **anomaly**, not a guardrail: unlike a cut diff or missing CI evidence, it is the model not following the format, so a share above `RULES.withheldShare` is a warning whose lever is `prompts/pr-review-system.md` (live `review` eval).
6. **The `review` eval measures the protocol, but does not apply it yet.** The eval suite shares the production verdict code (ADR-0027), but `eval-replay.yml` replays the responses recorded under the previous prompt, which have no analysis: enforcing the protocol there would turn every recorded APPROVE into WITHHELD and fail the replay gate on a change the replay cannot measure (it says so itself: a prompt change is not measured). The suite is wired when a live run (`evals.yml`) has published responses that carry the analysis; until then compliance is read from `review.verdict` in production (`withheld_for`, `adversarial_points`).

## Alternatives Considered

- **A harsher prompt only** ("be skeptical, find problems"). It raises false REQUEST_CHANGES (the failure #267 fixed) and cannot be checked. Rejected.
- **Turn a thin APPROVE into REQUEST_CHANGES.** Starts auto-fix with nothing to fix: the fixer would "address" an analysis it has no finding for (ADR-0026 made the same call for missing evidence). Rejected for WITHHELD.
- **Repair call: ask the model once more for the missing analysis.** Doubles the review's tokens against an 8K TPM budget (ADR-0028) on the commonest outcome of the rule. Rejected; revisit if the live withhold rate is high.
- **A second, independent "devil's advocate" reviewer.** Another LLM call per head and a second verdict to reconcile; the single-review-per-SHA design (ADR-0028) exists to avoid exactly that. Rejected.
- **Free-form analysis, count by length.** Not checkable. The four ids are a closed vocabulary the journal and ADR-0051 can use.

## Consequences

- ✅ A review cannot approve without having written down where the diff could break; a model that skips the section is withheld, visibly, instead of silently approving.
- ✅ The axes give the meta-loop a typed signal about *why* patches get blocked (ADR-0051).
- ⚠️ **The review prompts grow by 261 tokens in this repository** (3,240 → 3,501 for system plus user template, 227 in another repository; 12 of them are the four new modules in the gate (c) list) and the review's output by about 100. Both come out of the same 8K TPM window: `review_max_input_tokens` stays 6300, so the room left for the diff goes from about 3,060 to 2,800 tokens, 8 % less, and a diff is cut a little earlier (ADR-0038 withholds an approval on cut code). The gate (c) list of 48 module paths is the largest block of the prompt that is not rules; replacing it by a pointer to `config/coverage-gates.json` would give the room back, and is a separate decision (the review has no file access). The #219 incident case `incident-cut-mid-step-name` now cuts inside `reset-auto-fix.yml`, before its `Upload run trace` step; its test pins the invariant (hunks before the cut are shown) rather than that step.
- ⚠️ **Clean PRs may be withheld** when the model finds nothing to say on two axes. That is the point of the rule, and also its cost: a human approves those. Watch `withheld_for: protocol` in Diagnostics; if the rate is high, the lever is the prompt, not the threshold (ADR-0031: never lowered to pass).
- ⚠️ `MIN_CRITICAL_POINTS` is a code constant, not a setting: lowering it needs an ADR (the eval-ratchet reasoning of ADR-0031 applies to a gate that only tightens).
- ⚠️ The `review` eval does not yet cover the rule (point 6). The dataset floor test and the no-copy rule (ADR-0031) are unaffected: the prompt text is generic and shares no five-word run with a case.
