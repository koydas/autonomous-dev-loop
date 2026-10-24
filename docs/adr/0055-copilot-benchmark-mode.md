# ADR-0055: Benchmark mode: Copilot runs against an isolated sandbox, never `main`

- **Date:** 2026-10-24
- **Status:** Proposed

## Context

A provider that does not meet [ADR-0054](./0054-provider-admission-invariants.md) is confined to an isolated benchmark sandbox. Copilot is such a provider today ([ADR-0053](./0053-copilot-opt-in-codegen-provider.md)). Confinement is only worth its cost if it produces something: the first outcome numbers on identical issues, under the same validator, evidence, review and caps, from an agent this repository did not write. The loop has eval suites for its own stages ([ADR-0027](./0027-offline-eval-harness.md), [ADR-0030](./0030-live-pr-prompt-evals.md), [ADR-0031](./0031-eval-gates-are-a-ratchet.md)); it has no measure of its own end-to-end outcomes against a reference.

The sandbox is also the only place where the open questions of the register (O1 to O13) can be answered, and where skipping workflow approval (F9) is defensible ([`copilot-integration.md`](../copilot-integration.md), finding 2).

## Decision

1. **Isolated repository.** Copilot runs only against a dedicated sandbox repository, user-owned, containing either the fixed fixture tree or, for observed cases (decision 3), a snapshot of production `main` at a recorded SHA. Nothing in it can reach production `main`: no shared Actions secret, no token valid on production, no deploy, no write path to the `metrics` branch of production. LLM keys in the sandbox are separate, with a spend cap set at the provider. The sandbox's `main` is not this repository's `main`; a PR there is merged by no one or by the maintainer, as a test artifact.
2. **Same pipeline, one variable.** The sandbox adopts the reusable workflows ([ADR-0045](./0045-reusable-pipeline-workflows.md)) pinned to the same pipeline SHA for both arms: the same validator and threshold, the same evidence checks, the same review (including [ADR-0026](./0026-withhold-approval-on-unverified-evidence.md), [ADR-0038](./0038-withhold-approval-on-unreviewed-code.md), [ADR-0049](./0049-adversarial-review-protocol.md)), the same 3-round cap and circuit breaker ([ADR-0034](./0034-review-fix-loop-converges.md), [ADR-0050](./0050-circuit-breaker-review-loop.md)). The only difference between arms is the provider of the patch and of the iteration ([ADR-0053](./0053-copilot-opt-in-codegen-provider.md) decision 3).
3. **Two sources of cases, both paired, both after the validated-issue label.**
   - **Fixed set.** A versioned list of issues with the fixture commit they apply to; each case is run on both arms. Cases are Level-2-simple ([`autonomy-levels.md`](../autonomy-levels.md)): the validator passes them and no needed file is protected. Arm order is randomised per case; repeats per arm are fixed in advance.
   - **Observed real issues.** A real production issue that carries the validated-issue label (`issue.valid.name` of the production `labels.yaml`) **and** the opt-in label (`provider.copilot.name`) ([ADR-0053](./0053-copilot-opt-in-codegen-provider.md) decisions 1 and 2) is mirrored by a *scheduled workflow in the sandbox* that reads production's public issues, with no credential held by production. The mirror copies title, body and the labels the validator set, records `mirror_of` (production issue, label time, base SHA), and snapshots production `main` at that SHA into a sandbox branch so the paths the issue names exist. Production's own flow on the issue is untouched and is the control arm; its base SHA is recorded so drift between the two arms is visible. Both names are read from the production repository's `labels.yaml` at the label SHA, never hard-coded in the sandbox. Nothing is mirrored before the validated-issue label, and a mirror is cancelled if it is withdrawn first. The Copilot arm's lead time starts at the mirror's creation; the sync lag is reported separately.
   - A case never enters a prompt of ours (the spirit of [ADR-0031](./0031-eval-gates-are-a-ratchet.md)): the set tunes nothing. Observed cases are self-selected by the label, so they are reported as a separate series from the fixed set and are not pooled with it.
4. **The caps are measured, not enforced, on the Copilot arm.** The 6-file cap, the protected paths and the write rules cannot be enforced before the write (ADR-0054). They are **replayed read-only** over each Copilot PR with the same functions the stages use (`findGuardrailViolations` and the writer's checks), and recorded as *would have been rejected* with the rule. This is a metric about the provider, not a control.
5. **Workflow approval is skipped in the sandbox only** (F9), so lead time is not dominated by a person's click. The sandbox holds no secret of value; test T7 confirms the exposure of finding 2 there on purpose.
6. **Metrics**, per arm and per case, then aggregated:

   | Metric | Definition | Comparable across arms? |
   |---|---|---|
   | Approval rate | Share of cases whose head reaches `APPROVE` within the cap | Yes |
   | Review rounds per PR | Reviews until `APPROVE`, or until the cap | Yes |
   | Escalations | `needs-human`, circuit open, blocked, patch rejected (own arm); cap reached or timeout (Copilot arm) | Partly: the causes differ, the count is comparable |
   | Lead time | Issue labelled → first PR head; and → first `APPROVE` | Yes, with the approval setting identical |
   | Would-have-been-rejected | Replay of the guard over the final diff | Copilot arm only (own arm is 0 by construction) |
   | Cost | Own arm: list-price USD of LLM calls from the run record ([ADR-0040](./0040-run-journal-and-public-run-record.md)). Copilot arm: AI credits and Actions minutes as billed (F30) | **No**: tokens at list price versus credits; the credit-to-currency rate is not documented (O12); seat licence excluded from both. Shown side by side, never summed or divided |

   Any figure that is unknown is `null`, never a default ([ADR-0043](./0043-diagnostic-observability-console.md)). The Copilot arm's token usage is not available per call (finding 6) and is not estimated.
7. **Reporting.** Results are published as a *benchmark* series with `n`, the pipeline SHA, the fixture commit and the dates; never mixed into the production KPIs of the overview. No claim is made with a sample too small to separate the arms; the page says "no difference detected at n=…" rather than a ranking. A benchmark result never changes a gate, a threshold or an admission state by itself ([ADR-0031](./0031-eval-gates-are-a-ratchet.md), [ADR-0054](./0054-provider-admission-invariants.md)).
8. **Exit.** The sandbox is deleted, or the allow-list entry ([ADR-0053](./0053-copilot-opt-in-codegen-provider.md) decision 2) removed, when the maintainer says so; nothing in production depends on it.

## Alternatives Considered

- **A branch of this repository as the sandbox.** Shares secrets, workflows and the `metrics` branch with production; the workflow-approval skip would apply to the real repository. Rejected: not isolated.
- **An organization-owned sandbox.** Would allow push rulesets (F22) and a second human reviewer, but adds an organization and a plan for a measurement. Revisit with [ADR-0057](./0057-push-rulesets-as-platform-guard.md).
- **Use the existing eval suites.** They score a stage's decision or text; the executable suites ([ADR-0052](./0052-isolated-grader-for-executable-evals.md)) score a patch against hidden tests but not review rounds, escalations or lead time. Complementary, not a substitute; a benchmark case may later carry a grader.
- **Replay recorded Copilot output offline.** Cheap, but a recording is one session of a non-deterministic agent and cannot say how it iterates under our review.
- **Compare on public benchmarks.** Not our axes and not our issues; the point is the same validated issues under the same governance.
- **Count Copilot tokens from the invoice.** Not per task, not per call, and a different unit; rejected as a basis for the cost comparison.

## Consequences

- ✅ Answers, with data, how much the governance layer is worth against an agent that has its own safeguards: approval rate and rounds under identical review, plus how often Copilot would have been stopped by our guard.
- ✅ Real issues can be observed under Copilot with no effect on production, and each one is a paired case by construction.
- ✅ The sandbox is where the register's OPEN items are closed (T1 to T7), before any ADR here is accepted.
- ✅ Nothing reaches production; deleting the sandbox undoes everything.
- ⚠️ Cost and effort: a second repository, a seat, a machine user, a case set, a replay adapter. Not free for a single maintainer.
- ⚠️ Observed cases are selected by a person's label, not drawn at random: the series says what Copilot does on the issues someone chose to observe, not on issues in general.
- ⚠️ A snapshot of production `main` copies the workflows and tree into the sandbox; the sandbox runs them with sandbox-only secrets. The snapshot is the property to review if the production tree ever carries something that must not leave it (it is public today).
- ⚠️ Small samples. A fixed set of Level-2-simple issues measures a corner of the problem; it cannot say Copilot is better or worse in general, and the page must not.
- ⚠️ Non-comparable cost is shown, not resolved; a reader may still compare the two numbers. The definition (above) and the dashboard limit text ([ADR-0056](./0056-dashboard-writer-and-not-traced.md)) say why they should not.
- ⚠️ Preview APIs (F1, F6) may change under the benchmark; each run records the API version it used.
- ⚠️ Nothing is implemented by this ADR; it needs the router and allow-list of [ADR-0053](./0053-copilot-opt-in-codegen-provider.md), a replay adapter, and the dashboard work of [ADR-0056](./0056-dashboard-writer-and-not-traced.md).

## Invariants check

| Invariant | Status |
|---|---|
| 1. Write guard preventive on any path that can reach `main` | **Preserved**: the sandbox has no path to `main` (decision 1); observation reads public production data and writes nothing back (decision 3); the Copilot arm's guard is explicitly detective and labelled as a measurement (decision 4). The own arm keeps the preventive guard unchanged. |
| 2. Every stage on such a path fully traced | **Preserved**: no Copilot stage is on a path to `main`; the boundaries are traced, the interior is declared "not traced" ([ADR-0056](./0056-dashboard-writer-and-not-traced.md)). |

**Related:** [ADR-0023](./0023-trusted-pipeline-execution.md), [ADR-0027](./0027-offline-eval-harness.md), [ADR-0030](./0030-live-pr-prompt-evals.md), [ADR-0031](./0031-eval-gates-are-a-ratchet.md), [ADR-0040](./0040-run-journal-and-public-run-record.md), [ADR-0041](./0041-end-to-end-work-item-tracing.md), [ADR-0045](./0045-reusable-pipeline-workflows.md), [ADR-0052](./0052-isolated-grader-for-executable-evals.md), [ADR-0053](./0053-copilot-opt-in-codegen-provider.md), [ADR-0054](./0054-provider-admission-invariants.md).
