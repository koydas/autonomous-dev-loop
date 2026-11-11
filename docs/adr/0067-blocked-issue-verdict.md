# ADR-0067: An issue waiting on a declared external precondition is BLOCKED, not INVALID

- **Date:** 2026-11-11
- **Status:** Proposed

## Context

The issue validator answers with one boolean (`parseGroqResponse` → `valid`), and the labels follow it: `ready-for-dev` when valid, `needs-refinement` otherwise (`config/labels.yaml` → `issue.valid` / `issue.invalid`, `scripts/manage_labels.mjs`). The code-generation trigger reads the same boolean (`adl-validate-issue.yml`, `steps.validate.outputs.valid == 'true'`).

`needs-refinement` is described as "Issue requires clearer acceptance criteria before automation". That is false for a class of issues: those whose acceptance criteria depend on something that does not exist yet and that a human has *declared* as a precondition: a published live eval run (#332, #334, #340 step 2), a maintainer's approval of an ADR change (#336), an accepted superseding ADR (#330). The validator is right to refuse them (rule B4: "the coder agent cannot call a service that does not exist yet"), and no rewording of the issue can clear the blocker. Only the external event does. On 2026-11-11, five of the seven `needs-refinement` issues of the repository were in this state; the validator's own "suggested acceptance criteria" for them are then noise, and the label hides which issues actually need an author's attention.

Not measured: how often B4 is the only blocker across all validated issues. Decision 7 adds the data to find out.

## Decision

1. **A third outcome, `blocked`, derived in code, never asserted by the model.** The validator output is unchanged (`valid`, `score`, `blockers`, `warnings`, `suggested_ac`). A pure function `isBlocked(result, issueBody)` returns true only when all of these hold:
   - `result.valid === false`;
   - `result.blockers` is non-empty and **every** blocker starts with `B4:`;
   - the issue body contains a `Blocked by` section (Decision 2).
2. **The `Blocked by` section is recognised by the parser, not by the model.** A heading line `## Blocked by` or `### Blocked by` (case-insensitive, outside fenced code blocks), followed before the next heading by at least one list item. The items are data: the code does not read, fetch or interpret what they reference.
3. **`blocked` never makes an issue valid.** `valid` stays `false`. Every consumer of `valid` (code-generation trigger, checkpoint, metrics) behaves as today. The change can only move an `INVALID` issue to a different label and comment; it cannot start the pipeline.
4. **Labels and comment.** A new label `issue.blocked` (`blocked`) in `config/labels.yaml`. `manage_labels.mjs` applies exactly one of `ready-for-dev`, `needs-refinement`, `blocked` and removes the other two. The comment status reads `BLOCKED — waiting on a declared precondition`; it lists the B4 blockers, omits the "suggested acceptance criteria" block and the paste-and-save instruction, and says: resolve the precondition, then save the issue.
5. **Anything else stays `INVALID`.** A B4 without a `Blocked by` section is an undeclared dependency, which is what B4 targets. A B4 next to a B1–B3 blocker is a spec that still has to be fixed. A score below 70 with no blocker is unchanged.
6. **Re-validation is unchanged and there is no stale state.** Saving the issue re-runs the validator. `blocked` is a pure function of the model output and the body: once the precondition holds and the AC no longer depend on a missing artifact, B4 is not raised, the verdict is `VALID`, and the labels flip. The `Blocked by` section is then ignored. No polling and no read of the referenced runs, issues or ADRs.
7. **Observability without a new event.** `issue_validation.fail` carries `blocked: true` in its meta (key added to `EVENT_META_ALLOWLIST`); the metric `verdict` stays `MANUAL`. The B4-only rate is derived from the same record, which answers the question left open in Context.
8. **Prompt and evals.** One clause in `prompts/validation-system.md`: items under `Blocked by` are preconditions, not acceptance criteria, and are not judged under B2. B4 is still raised for an AC that depends on them. Dataset cases for the class are added under ADR-0031 (`source: "issue #332"` etc., reduced to the minimum, expected `valid: false` with `blockers: ["B4"]`, never copied into the prompt). `blocked` itself is code-derived and pinned by unit tests, not by the eval scorer.
9. **Consumer compatibility.** A consumer `config/labels.yaml` without `issue.blocked` keeps the two-label behaviour (the outcome is reported as `INVALID`). The key is documented in `docs/code-generation.md` and the workflow interface.

## Alternatives Considered

- **Let the validator ignore ACs placed under `Blocked by`, with no new state.** The issue could then reach `VALID` with an AC nobody can verify: fail-open, and the coder agent would be started on a missing dependency.
- **Reuse `needs-human`.** It means the automation ran and stopped (guardrail rejection, blocked generation). A blocked issue never ran; mixing both makes the label unreadable.
- **The model emits `blocked`.** The issue body is untrusted input that can steer the model. A code-side derivation from the blocker codes and a literal heading cannot be argued into a pass, and the worst a forged section does is change a label.
- **Auto-unblock by polling the referenced run or ADR.** Needs GitHub reads for arbitrary references, a scheduler, and a definition of "resolved". Decision 6 gives the same result at the next save for no infrastructure.
- **Process only: split every blocked issue into an operational task and an implementation issue.** Still worth doing, but the implementation issue is blocked by the first one and hits the same B4.

## Consequences

- ✅ `needs-refinement` regains its meaning (the author has something to fix); blocked work is visible in its own filter.
- ✅ No new path to `ready-for-dev`; the change is strictly fail-closed.
- ✅ Blocked issues stop receiving acceptance criteria they cannot use.
- ⚠️ The `Blocked by` heading becomes a contract of the issue templates (`.github/ISSUE_TEMPLATE/`), to document there.
- ⚠️ A `blocked` label goes stale when the precondition is met and nobody saves the issue, as `needs-refinement` does today. A trigger on the referenced event is the follow-up if the stale rate warrants it.
- ⚠️ An author can write a `Blocked by` section to avoid the `needs-refinement` label on an issue that is only under-specified for B4. The pipeline still does not start; the cost is a mislabelled issue.
- ⚠️ A third label touches `labels.yaml`, `manage_labels.mjs`, the validation workflow output, the journey/diagnostics decision keys and several docs.

## Rollout

Separate PRs, each with its own tests and docs (AGENTS.md → Review Hygiene):

1. This ADR (`Proposed`).
2. `issue_validator.mjs` (`isBlocked`, comment format), `validate_issue.mjs` output, prompt clause, dataset cases, `run_record` allowlist, unit tests.
3. `labels.yaml`, `manage_labels.mjs`, workflow wiring and interface, issue template, `pipeline_journey`, `docs/code-generation.md`, `docs/runbook.md`.

The ADR moves to `Accepted` with PR 2, once the owner has decided it.
