# ADR-0065: The adversarial protocol gates on verified coverage of the four axes, not on a count of named risks

- **Date:** 2026-10-27
- **Status:** Proposed

> **Replaces** [ADR-0049](./0049-adversarial-review-protocol.md) §3 (the gate) and §6 (the eval deferral, whose premise no longer holds, see Decision 6) once accepted. Until then ADR-0049 stands and `MIN_CRITICAL_POINTS` is unchanged: this ADR changes no code. Accepting it is the pull request that implements it (see Rollout), which also marks ADR-0049 `Superseded by ADR-0065` for those two points. ADR-0049 §1, §2, §4 and §5 (four axes, observation not finding, `Axis:` tags, journal) are kept.

## Context

[ADR-0049](./0049-adversarial-review-protocol.md) withholds an APPROVE whose analysis names a risk on fewer than two of the four axes (`MIN_CRITICAL_POINTS`). The aim is a review that attacked the diff before it approved. The mechanism checks something else: how many lines the model **phrased as a risk**.

Issue [#284](https://github.com/koydas/autonomous-dev-loop/issues/284) is the evidence. PR #282 rewrites two comment lines of `config/models.yaml` into four; no key or value changes. The same head, reviewed twice by the same model:

| Pass | Risks named | Result |
|---|---|---|
| 1 | 1 of 4 axes (Issue fit) | `WITHHELD`: "Robustness / Side effects / Type integrity: no risk named" |
| 2 (same comment, edited; a withheld review is never deduplicated, ADR-0028) | 2 of 4 (Side effects: a dated claim in a comment goes stale; Issue fit: the claim is inferred) | `APPROVE` |

Same input, opposite published verdicts. On a diff with nothing to attack, passing the protocol depended on whether the model chose to phrase a second residual as a risk. Three consequences:

1. **The gate does not measure what it is for.** A review can check all four axes and say so ("none: lines 12-15 are comments, no key changed") and be withheld; another can invent a residual risk to reach two and be approved. The second is rewarded for the thing the protocol should discourage.
2. **The cost falls on clean changes.** ADR-0049 accepted that ("clean PRs may be withheld") and named the prompt as the lever. #282 shows the lever cannot be the prompt alone: asking for "at least 2 risks" is asking for risks to exist.
3. **The one data point is thin.** One incident, two passes. The production rate of `withheld_for: protocol` is what Diagnostics reports (ADR-0049 §5); this ADR does not have it, and the implementation must read it before the switch (Rollout).

[ADR-0031](./0031-eval-gates-are-a-ratchet.md) still holds: a threshold is not lowered to make a case pass. Lowering `MIN_CRITICAL_POINTS` to 1 would be that, and would keep the flaw (the count would still depend on phrasing).

## Decision

1. **Gate on coverage, not on a count.** An APPROVE needs all four axes **verified**. An axis line is verified when it is either
   - a **risk**: a concrete observation that cites a `file:line` of the diff (as today, a residual risk counts); or
   - a **negative check**: `none` followed by what was checked, and that text **names something that is in the diff**: a path, a symbol or a quoted fragment found in the diff text. "none, checked the return shape" names nothing and is not a verification; "none: `config/models.yaml` lines 12-15 are comments, no key or value changed" is.
   The number of risks no longer matters: zero risks on four verified axes approves.
2. **Anything else is WITHHELD, as before.** A missing section, an uncovered axis, a placeholder, or a negative check that names nothing in the diff gives `WITHHELD` with `withheld_for: protocol`: no REQUEST_CHANGES, no auto-fix (ADR-0026), the comment says which axes failed and why (`covered` / `named something` / `risk` per axis). This keeps ADR-0049's choice of WITHHELD over a repair call or a REQUEST_CHANGES.
3. **The check is deterministic and ties the claim to the diff.** It is a separate pass over the same parsed axis lines as `analyzeAdversarial` (`verifyAxes`, shadow-implemented before the gate moves) that marks each axis `verified`. The shadow applies one rule to every line, risk or `none`: it is a real statement (not a label or a placeholder) and it names something in the diff, so a risk without a `file:line` or symbol of the diff is not verified either. "Names something in the diff" is a string search of the axis text against the diff's file paths and identifiers; no LLM. It is a floor on specificity, not proof that the check was done (a model can name a file it did not read): the same limit as a quote in ADR-0061, and the human merge stays the gate.
4. **`MIN_CRITICAL_POINTS` stops gating.** The count stays as `adversarial_points` in the journal (continuity of the series, ADR-0049 §5), next to a new `verified_axes` (0-4). The constant is removed with the gate; a new constant `REQUIRED_VERIFIED_AXES = 4` replaces it and, like its predecessor, only moves by ADR.
5. **The prompt asks for what the code checks.** In two steps, because the gate still counts risks until the switch: the shadow PR *adds* the ask (every axis line cites a file, symbol or line of the diff, risk or `none`) and keeps the 2-risk sentence, since removing it while the gate stands would only raise the withhold rate; the switch PR replaces "APPROVED is forbidden unless at least 2 axes name a risk" with "every axis line is a concrete risk with file:line, or `none` plus the file, symbol or lines you looked at". The template placeholders already say it; the rule that creates the pressure to invent a risk goes. The rewording must share no five-word run with a dataset case (ADR-0031).
6. **The eval needs no separate activation, and the switch moves it at once.** ADR-0049 §6 deferred the protocol in the `review` suite; since then the suite shares the production resolver (`resolveReviewDecision`, which applies `enforceAdversarialProtocol` unconditionally), so the live suite and the replay already apply the gate. Replacing the gate in that resolver changes live and replay verdicts in the same commit. What this requires of the switch:
   - **Recorded answers must carry verified axes.** `scripts/replay_evals_ci.mjs` replays the last *published live run* against the checked-out code, and the hand-written `review-replay.json` fixture is replayed by `npm test`. Their answers were written for the count rule: "none, checked the return shape" and risks at `src/x.js:1` name nothing in the case's diff, so under the new gate every recorded APPROVE would become WITHHELD. The fixture's analysis lines are rewritten in the switch PR (labels, case ids and inputs untouched, so the ADR-0031 pins hold), and the switch PR is opened only after a live run published under the shadow PR's prompt exists, so the replay of that run is meaningful.
   - **A replay that fails after that is a real signal.** If the replay of a run made under the new prompt fails a threshold the run met live, the switch does not merge; no threshold moves (ADR-0031).
   - The #284 incident already has its `review` case, `incident-comment-only-config-withheld` (PR #282, comment-only config change, expected `APPROVE`), added as `known-gap` by #329 with the recorded incident answer (one risk axis, withheld by the count rule). The switch rewrites that recorded answer with the others, and moves the case out of `known-gap` (out of `KNOWN_GAP`, into `PINNED`, ADR-0031 §7) only when a published live run passes it under the new rule.

## Rollout

Two pull requests, so the switch is made on data and not on this reading of one incident:

1. **Shadow.** Parse `verified` per axis and journal `verified_axes` (counts only, on `review.verdict`, and `adversarial_verified_axes` in the `review` suite output); the prompt gains the ask for verifications; the gate is still ADR-0049's, so the live suite and the replay (which share it) are unchanged. After it merges, a live `review` run is published (the scheduled one, Wednesdays 06:23 UTC with publication, or a manual `evals.yml` dispatch with suite `review` and repeats 3): its answers, written for the new prompt, are what the switch is checked and replayed against. With the production `review.verdict` events, they give, per approval, the points and the verified axes.
2. **Switch**, opened after that published run exists. The gate changes and ADR-0065 becomes `Accepted` (ADR-0049 `Superseded by ADR-0065` for §3 and §6) when, on that data, (a) the approvals that ADR-0049 withholds now pass because they verified four axes, not because they named more risks, and (b) no approval that ADR-0049 withheld for a missing section or an empty analysis passes. Thresholds for (a) and (b) are written in the switch PR from the numbers; if the prompt change does not produce verified negative checks, the answer is another prompt iteration, not a looser check.

## Alternatives Considered

- **Keep ADR-0049, accept one pass in two on clean diffs.** The flaw is the reward for invented risks; a human approving every thin diff is the cost ADR-0049 accepted for a rule that works, and #282 says it does not.
- **Lower `MIN_CRITICAL_POINTS` to 1.** Moves the failure from two phrased risks to one, and loosens a gate to pass a case (ADR-0031). Rejected.
- **Exempt comment-only, documentation-only or config-only diffs.** The class is decided by path, a model cannot be asked to attack a diff that is exempt, and a document or a config comment can contradict code (RV-04b, PR #279). A fallback if coverage still withholds too much; not the first answer.
- **Review twice and keep the stricter or the more lenient result.** Doubles the tokens of the commonest outcome against the 8K TPM window (ADR-0028), and averages the noise instead of removing it.
- **Ask the model for a confidence in its analysis.** Self-reported and unverifiable.
- **Accept any `none` that has text.** Passes "none, checked the return shape" on every diff: the protocol would measure nothing. The diff-name check is the minimum that ties the line to this diff.

## Consequences

- ✅ A clean change whose four axes are checked and said so is approved on its first pass; the verdict stops depending on a second residual being phrased as a risk.
- ✅ A model is no longer rewarded for inventing a risk; the journal separates "named risks" from "verified axes".
- ✅ The #282 incident has a deterministic pass condition and a case that can leave `known-gap`.
- ⚠️ A negative check can name a file it did not read. The check is a floor on specificity, not a proof, and a verified axis is a claim a human merges on.
- ⚠️ A model that writes `none` with a generic sentence is withheld where ADR-0049 approved it (it had two phrased risks elsewhere). Expect the withhold rate to move in both directions; Diagnostics' `review-withheld` rule (anomaly share `withheldShare`) is the alarm, and the lever is the prompt.
- ⚠️ The evidence is one incident. The Rollout is the answer to that: the gate does not change before the shadow data exists.
- ⚠️ The switch moves the eval and the replay at once (Decision 6): the fixture is rewritten in the same PR and a published run under the new prompt must exist first. Merging the switch against a run recorded for the count rule would turn every recorded approval into a withheld one.
- ⚠️ Not decided here: the exact identifier extraction for "names something in the diff" (what counts as a symbol in a YAML or Markdown diff), and the thresholds of the switch. Both belong to the implementation, with tests, and are the review's open questions.
