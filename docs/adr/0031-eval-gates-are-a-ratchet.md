# ADR-0031: Eval gates are a ratchet — fix the stage, never loosen the gate

- **Date:** 2026-10-07
- **Status:** Accepted

## Context

The offline evals (ADR-0027) gate each LLM stage on thresholds: `validation` on verdict accuracy, per-class recall, consistency and error rate; `review` on verdict accuracy, per-class recall, consistency and error rate.

Live run [37410486265](https://github.com/koydas/autonomous-dev-loop/actions/runs/37410486265) of `validation`, on the dataset hardened in #173 (15 → 35 cases), failed four thresholds: `verdict_match` 0.771 < 0.8, `invalid` recall 0.710 < 0.8, `consistency` 0.886 < 0.9, `error_rate` 0.057 > 0.05. The hard cases did what they were added for: the prompt let partial AC, category-named roles and environments, and a prompt injection through.

A failing gate can be turned green in two ways: make the stage better, or make the gate weaker (lower a `min`, raise a `max`, mark a metric `optional`, drop or relabel the cases that fail, run a filtered subset). The second is always cheaper and always wrong: the threshold is the only number that says the stage is good enough to run unattended, and loosening it to match a regression hides the regression from the dashboard, the badges and the PR replay gate.

## Decision

1. **A failing eval is fixed in the stage.** Prompt, parser or production code; never the gate. The fix is validated by a live `evals.yml` run on the branch before merge.
2. **Thresholds only tighten.** `scripts/tests/eval_threshold_floor.test.mjs` pins, per suite, every gated metric with its current bound, the `optional` flag, the dataset's minimum case count and, for every existing case, its id, label and input hash. It fails when a `min` drops, a `max` rises, a gated metric disappears, a metric becomes `optional`, the dataset loses cases, or a pinned case is relabelled, removed or rewritten. `workflow_gates.test.mjs` pins that `evals.yml` and `pr-evals.yml` never pass `--tags` / `--limit` (a filtered run skips thresholds). Tightening a threshold or adding cases raises the floor in the same PR.
3. **Robustness of the production path is a stage fix.** When an eval error is a production failure (the stage would crash or fail the job on that output), fixing the production parser is legitimate, as long as the contract breach stays measured. First case: a validation response without `suggested_ac` crashed `validate_issue.mjs`; the parser now defaults it to `[]` (it never changes the verdict), and the `suggested_ac_count` scorer still scores the breach 0.
4. **Dataset corrections are separate and explicit.** A case may be relabelled or removed only when its label is shown to be wrong on its own merits (not because the model disagrees), in a PR of its own, with the rationale in the PR body and an ADR-0027 amendment line.
5. **Loosening needs a new ADR** that supersedes this one for the metric concerned: a human decision, recorded with its reason, never a side effect of a fix PR.
6. **A prompt never quotes its eval.** Writing a dataset case's wording into the stage prompt greens the gate the way a loosened threshold does: the model is handed the answer, the generalisation is no longer measured. Prompt examples come from another domain than the dataset; `eval_threshold_floor.test.mjs` fails when a suite's `prompts/<suite prefix>*.md` shares a 5-word run with any of its cases' inputs. The test only catches verbatim copies: a copied identifier (a one-word run such as a role name) or a close paraphrase passes it, so a green §6 test means "no copied sentence", not "no contamination"; review stays the guard for the rest.

## Alternatives Considered

- **Thresholds as warnings.** Rejected: nothing would stop a prompt regression from reaching the pipeline; the gate exists precisely because LLM output drifts silently.
- **Case-by-case human judgement, no enforcement.** Rejected: an autonomous agent asked to "make the evals pass" takes the cheapest path, which is the threshold or the dataset. The floor test makes that path fail CI.
- **Lowering thresholds to the current baseline after a dataset change.** Rejected: a harder dataset is supposed to expose weaknesses; resetting the bar to what the model does today erases the signal the dataset was added for.

## Consequences

- ✅ The dashboard and badges keep meaning "good enough to run unattended"; a red badge is fixed by work on the stage.
- ✅ An agent (auto-fix, Claude Code) cannot green a gate by editing `thresholds` or the dataset: `eval_threshold_floor.test.mjs` fails.
- ⚠️ A hard dataset can keep a suite red for a while; that is the intended signal, not a reason to relax it.
- ⚠️ Tightening is one-way: raise a bound only once several live runs show it holds with margin.

## Amendment (2026-10-16): §7 known-gap cases; production misjudgments become cases

The review dataset had not changed since #177 while the review stage misjudged real PRs (#187, #191, #194, #196, #207). Turning an incident into a gated case the stage fails today turns the gate red until the stage is fixed. That is the intended signal for most incidents, but not for one whose fix is a model or provider question (#194, the #199 comparison case): the choice was then to leave the incident out of the dataset, which is how the dataset stopped learning.

**7. Known-gap cases.** A case tagged `known-gap` is run, scored and published, but left out of every gated metric: `summarize` computes the quality metrics thresholds read (`error_rate`, `scores`, `consistency`, `confusion`, `per_class`) over the other cases, and reports the tagged ones under `summary.known_gap`, which no threshold may name (`checkThresholds` fails such a threshold). Run size, cost and the circuit breaker cover every run. `eval_threshold_floor.test.mjs` enforces the rest:
- a tagged case is listed in `KNOWN_GAP` (id → input hash) and is not pinned;
- every untagged case is pinned, so removing the tag pins the case in the same PR, and a pinned case can never be tagged again: removing the tag is the only way into the gate, and it is one-way;
- the floor's minimum case count counts gated cases only.

**Production misjudgments become cases** (rule in `AGENTS.md` → Eval Gates): a wrong verdict, false finding, missed bug or wrong validation gets a dataset case in the PR that fixes it, or a linked issue labelled `eval-case`. Stages without a suite keep an incident backlog in `docs/evals.md`.

**Why an amendment and not a new ADR (§5).** §5 asks a new ADR for loosening. This loosens nothing: every threshold, its bound and its `optional` flag are unchanged; the gated case set only grows (a case enters it untagged or by losing its tag, never leaves it); a gated case cannot be tagged, so the tag cannot be used to drop a failing case from the gate (§2, §4). A known-gap case is a measurement that did not exist before, not one removed from the gate. Tagging every new case `known-gap` would add cases without raising the gate; the `KNOWN_GAP` map makes each tag a reviewed line of the floor test, like a relabel under §4.

Consequences:
- ✅ An incident is recorded the day it happens, gated or not; the dashboard shows how the stage does on it.
- ✅ A fixed known-gap case enters the gate for good.
- ⚠️ A known-gap case can stay tagged after the stage starts passing it; nothing offline detects that. The run page shows it, and a human removes the tag.
