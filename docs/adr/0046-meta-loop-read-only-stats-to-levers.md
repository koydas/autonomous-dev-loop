# ADR-0046: Meta-loop: a read-only function from run statistics to suggested levers

- **Date:** 2026-10-22
- **Status:** Proposed

## Context

The loop records what it does (run journal, ADR-0040), diagnoses it (deterministic rules with a finding lifecycle, ADR-0043) and gates changes to its own LLM stages on evals that only tighten (ADR-0031). What closes the circuit is a person who reads the Diagnostics page, guesses which setting or prompt is involved, and writes the change. A **meta-loop** is the missing step: observe the statistics and propose changes to the loop itself.

Two properties of the existing system constrain how it can emit those proposals:

- **A GitHub object created by the meta-loop re-enters the loop it observes.** `validate-issue.yml` fires on every `issues: opened/edited`, so an issue opened by the meta-loop is validated by an LLM and, if well formed, labelled `ready-for-dev`; `code-generation` then runs against targets that are on the write denylist (ADR-0021, ADR-0044) and ends in a blocked generation and `needs-human`. The issue is a work item in the Pipelines page and in the KPIs; a pull request triggers `pr-review`. Registry state (which finding was already proposed, which was rejected) would live in issue bodies, edited by the same workflows.
- **The public record holds no model output, prompt or diff** (ADR-0040). Any component that reads it sees aggregates and allowlisted metadata, which is enough to point at a lever and not enough to write a patch.

## Decision

1. **The meta-loop is a pure, read-only function** `statistics → findings with a lever`. It has three layers, each usable without the next:
   1. **Contract.** The Diagnostics findings are exported as `findings.json` ([ADR-0047](0047-findings-export-and-lever-table.md)).
   2. **Levers.** A fixed, versioned table maps a finding to the setting, prompt or workflow that governs it (ADR-0047). The Diagnostics card shows it as a *suggestion, not verified*, next to the existing labelled hypothesis.
   3. **Drafting.** An on-demand command in `ai-dev-tools` (`/loop-insights`, its ADR-017) reads the export and drafts proposals in the session of the person who invoked it.
2. **No write on GitHub, from any layer.** No issue, pull request, comment, label, Discussion, review or workflow dispatch is created by the meta-loop, and no workflow with a new write scope is added for it. Layers 1 and 2 are computed by the existing `pipeline-site.yml` build from the `metrics` branch (no new permission); layer 3 runs on a developer machine with no GitHub write tool.
3. **No LLM in the build.** Export and lever lookup are deterministic (the ADR-0043 rule: a generated diagnosis could present a hypothesis as a fact). The only LLM use is layer 3, started by a human, reading only the published export.
4. **A lever is advice; applying it is an ordinary change.** A person edits the file or setting under every existing gate: protected paths for the model, evals for prompts (ADR-0031 §1, live `evals.yml` on the branch), docs and tests in the same PR (`AGENTS.md`, Review Hygiene), human merge. The meta-loop never edits `prompts/`, `config/`, `scripts/` or `docs/`.
5. **Forbidden levers.** The table has no entry, and a drafting agent may not invent one, that: lowers a threshold, raises a `max`, marks a metric `optional`, removes or relabels a dataset case or runs a filtered subset (ADR-0031 §5); weakens the protected-paths floor or its config (ADR-0044); changes `.github/`, token scopes or secrets; or raises the auto-fix attempt cap (ADR-0034).
6. **Only what is actionable yields a lever.** A finding gets a lever only while it is `active`, of severity `warning` or `critical` (so a guardrail doing its job, ADR-0043 amendments, never does), and from a rule that appears in the table. A `resolved` finding, an `info` finding, a telemetry gap ("insufficient data") and a finding without an entry have `lever: null`: an observation, not a proposal. The thresholds are the existing `RULES`; the meta-loop adds none of its own.
7. **No state.** There is no proposal registry and no accepted / rejected tracking. The feedback signal is the one that exists: a finding turns `resolved` when its pattern leaves the last `RULES.activeWindow` runs.
8. **Status of this ADR.** Proposed. Nothing is implemented; ADR-0047 and the ai-dev-tools ADR-017 are proposed with it. Accepting them is the go for the first implementation step in [`docs/meta-loop.md`](../meta-loop.md#implementation-steps).

## Alternatives Considered

- **One issue per finding** (the first design): rejected for the re-entry above, plus the registry-in-issue-body state, one more object to triage per recurring finding, and the pollution of the work-item KPIs. An opt-out label honoured by `validate_issue.mjs` would fix the first point only by changing that workflow's contract for this feature.
- **A single rolling issue edited in place:** `issues: edited` triggers validation on every refresh.
- **A draft pull request with a report or the patch:** triggers `pr-review` and the evidence job on text nobody asked to review; a patch would also have to cross the denylist.
- **A GitHub Discussion or a digest comment:** no re-entry, but a new write permission and a place nobody is subscribed to; deferred until the dashboard suggestions have shown the levers are relevant.
- **A workflow that applies the lever** (config or prompt edit, opened as a PR): contradicts the denylist (ADR-0021, ADR-0044) and moves the decision from the person to the loop; ADR-0001 and ADR-0031 keep it with the person.
- **LLM-written suggestions inside the site build:** rejected with ADR-0043. The drafting layer exists, but outside the build and on invocation.
- **Optimising a prompt against its dataset automatically:** would need a holdout set the loop never sees (ADR-0031 §6 only catches verbatim copies). Out of scope while no layer edits prompts.

## Consequences

- ✅ The meta-loop cannot loop on itself: it creates no event the pipeline reacts to, and adds no KPI population.
- ✅ No new secret, token scope or workflow permission; the trust model of ADR-0023 and ADR-0040 is unchanged.
- ✅ Layers 1 and 2 are deterministic and unit-testable (pure modules under the c8 gate); only layer 3 is non-deterministic, and it is outside the pipeline.
- ✅ The same export serves the dashboard, `/loop-insights` and any MCP host.
- ⚠️ Pull, not push: a suggestion is seen only by someone who opens Diagnostics or runs the command. The existing findings count on the navigation link is the only nudge.
- ⚠️ No memory of a rejected suggestion: it is shown again while its finding is active.
- ⚠️ The suggestions are as good as the table: a rule without an entry gets none, and the table is maintained by hand with the rules (a test pins that every rule id is either mapped or explicitly listed as having no lever).
- ⚠️ Three of the five LLM stages have no eval suite (generation, PR preparation, auto-fix): a lever on their prompts names that gap instead of a gate (ADR-0047, `gate: null`).
- ⚠️ The data in the public record is thin (a few days, mostly guardrail verdicts at the time of writing): the first levers will be few, which is the intended behavior.

## Revisit

If, after several weeks, the levers shown on active findings are acted on, a push channel (a digest in a place people already read) can be decided in a new ADR that supersedes point 2. Applying a lever through a pull request is a different decision and needs its own ADR against ADR-0021.
