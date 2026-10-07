# ADR-0031: Eval gates are a ratchet — fix the stage, never loosen the gate

- **Date:** 2026-10-07
- **Status:** Accepted

## Context

The offline evals (ADR-0027) gate each LLM stage on thresholds: `validation` on verdict accuracy, per-class recall, consistency and error rate; `review` on verdict accuracy, per-class recall, consistency and error rate.

Live run [37410486265](https://github.com/koydas/autonomous-dev-loop/actions/runs/37410486265) of `validation`, on the dataset hardened in #173 (15 → 35 cases), failed four thresholds: `verdict_match` 0.771 < 0.8, `invalid` recall 0.710 < 0.8, `consistency` 0.886 < 0.9, `error_rate` 0.057 > 0.05. The hard cases did what they were added for: the prompt let partial AC, category-named roles and environments, and a prompt injection through.

A failing gate can be turned green in two ways: make the stage better, or make the gate weaker (lower a `min`, raise a `max`, mark a metric `optional`, drop or relabel the cases that fail, run a filtered subset). The second is always cheaper and always wrong: the threshold is the only number that says the stage is good enough to run unattended, and loosening it to match a regression hides the regression from the dashboard, the badges and the PR replay gate.

## Decision

1. **A failing eval is fixed in the stage.** Prompt, parser or production code; never the gate. The fix is validated by a live `evals.yml` run on the branch before merge.
2. **Thresholds only tighten.** `scripts/tests/eval_threshold_floor.test.mjs` pins, per suite, every gated metric with its current bound, the `optional` flag and the dataset's minimum case count. It fails when a `min` drops, a `max` rises, a gated metric disappears, a metric becomes `optional`, or the dataset loses cases. Tightening a threshold or adding cases raises the floor in the same PR.
3. **Robustness of the production path is a stage fix.** When an eval error is a production failure (the stage would crash or fail the job on that output), fixing the production parser is legitimate, as long as the contract breach stays measured. First case: a validation response without `suggested_ac` crashed `validate_issue.mjs`; the parser now defaults it to `[]` (it never changes the verdict), and the `suggested_ac_count` scorer still scores the breach 0.
4. **Dataset corrections are separate and explicit.** A case may be relabelled or removed only when its label is shown to be wrong on its own merits (not because the model disagrees), in a PR of its own, with the rationale in the PR body and an ADR-0027 amendment line.
5. **Loosening needs a new ADR** that supersedes this one for the metric concerned: a human decision, recorded with its reason, never a side effect of a fix PR.

## Alternatives Considered

- **Thresholds as warnings.** Rejected: nothing would stop a prompt regression from reaching the pipeline; the gate exists precisely because LLM output drifts silently.
- **Case-by-case human judgement, no enforcement.** Rejected: an autonomous agent asked to "make the evals pass" takes the cheapest path, which is the threshold or the dataset. The floor test makes that path fail CI.
- **Lowering thresholds to the current baseline after a dataset change.** Rejected: a harder dataset is supposed to expose weaknesses; resetting the bar to what the model does today erases the signal the dataset was added for.

## Consequences

- ✅ The dashboard and badges keep meaning "good enough to run unattended"; a red badge is fixed by work on the stage.
- ✅ An agent (auto-fix, Claude Code) cannot green a gate by editing `thresholds` or the dataset: `eval_threshold_floor.test.mjs` fails.
- ⚠️ A hard dataset can keep a suite red for a while; that is the intended signal, not a reason to relax it.
- ⚠️ Tightening is one-way: raise a bound only once several live runs show it holds with margin.
