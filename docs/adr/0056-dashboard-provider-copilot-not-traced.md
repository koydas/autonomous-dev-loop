# ADR-0056: Dashboard: `provider=copilot` on runs, and an opaque stage is "not traced"

- **Date:** 2026-10-24
- **Status:** Proposed

## Context

The console ([ADR-0043](./0043-diagnostic-observability-console.md)) renders what the run records and traces contain, and its rule is that a missing population yields `null`, never a default. It has one word for "no data": **not recorded** (`TONE_WORD.unknown` in `console_views.mjs`; a step whose span outcome is missing or unknown in the journey, `pipeline_journey.mjs`). That word means *something should have been recorded and was not*: a crashed tracer, a skipped upload, a closing journal that predates `item-closed.yml`. Diagnostics reads it as a defect.

A Copilot-provided stage ([ADR-0055](./0055-copilot-benchmark-mode.md), benchmark only) is different. Its interior is absent **by design**: no per-call usage, no tool calls, no model identity, no prompt composition (finding 6 of [`copilot-integration.md`](../copilot-integration.md)). Showing it as "not recorded" would raise a false defect; showing it as a gap with a zero would invent data; showing nothing would let a reader compare a traced stage with an untraced one as if the two were the same kind of number.

The word `provider` is also already taken: `llm_call` spans carry `provider` (`groq`, `anthropic`) and `providerBreakdown` in `pipeline_kpis.mjs` groups by it. Reusing the key for the code-generation provider would merge two different things.

## Decision

1. **A run-level provider field, distinct from the LLM provider.** The run envelope ([ADR-0040](./0040-run-journal-and-public-run-record.md)) gains an optional `codegen_provider` (`adl` when absent, `copilot`). The console displays it as **`provider=copilot`** on the run card, the journey step and the work-item header; the key name is a field of the record, the label is what a reader sees. `llm_call.provider` keeps its meaning. Whether the record key should be `codegen_provider` or something else is a naming decision for the maintainer (see the PR); the rest of this ADR does not depend on it. The field is added to the redaction allow-list ([ADR-0040](./0040-run-journal-and-public-run-record.md) `EVENT_META_ALLOWLIST` rule: a new key stays unpublished until listed); its value is a closed enum, never free text.
2. **A distinct status, "not traced".** A stage whose provider is opaque by design renders as **not traced**, separate from *not recorded*. It is a different tone (neutral, not warning), carries the tooltip "interior not observable for this provider (see metric definitions)", and is excluded from the Diagnostics rules that treat a missing span as a defect (failed runs, repeated failures, duration regressions). The *boundaries* that our own pipeline observes are shown normally: assignment request and status, task id, PR opened, each push, each review, each `@copilot` post, elapsed time.
3. **Opaque metrics are `null`, never `0`.** For a `provider=copilot` stage: LLM calls, tokens, list-price cost and per-call duration are `null` and render as "not traced". They are excluded from both numerator and denominator of KPIs that average over calls or sum cost. Credits and Actions minutes, where obtainable (F30), appear in a separate row with their own unit, **not** added to `llm_cost`.
4. **Metric definitions list the limit.** The "Metric definitions" table (`pipeline_kpis.mjs`) gets, for each affected indicator, a *Known limits* sentence: `llm_cost`, `providers`, `run_duration`, `lead_time`, `review_runs_per_pr`, `approve_rate`, and a new row for the benchmark series ([ADR-0055](./0055-copilot-benchmark-mode.md)). For example: *"Excludes the code-generation stage of runs with `provider=copilot`: its LLM calls, tokens and cost are not traced (ADR-0054 invariant 2); credits billed by GitHub are a different unit and are not summed."*
5. **Benchmark data stays out of the production overview.** The sandbox's records are published as a separate series with its own page section; the overview KPIs of the production repository never include them. Arms are shown side by side with `n` ([ADR-0055](./0055-copilot-benchmark-mode.md) decision 7), never as a single combined figure.
6. **Ingestion is boundary-only.** From Copilot we ingest ids, statuses, timestamps and counts (task id, session ids, status transitions), never session logs, prompts, model output or file contents ([ADR-0040](./0040-run-journal-and-public-run-record.md): none of these is ever allow-listed). New events (for example `copilot.assign`, `copilot.task_status`, `copilot.round_posted`) follow [ADR-0018](./0018-structured-observability.md) naming and are documented in `docs/observability.md` in the implementing change (`check_event_docs.mjs` enforces it).
7. **Nothing is implemented by this ADR.** It specifies the rendering and the field; the change touches `run_record.mjs`, `pipeline_kpis.mjs`, `console_views.mjs`, `pipeline_journey.mjs` and `docs/observability.md`, under their c8 gates, in a separate PR after [ADR-0053](./0053-copilot-opt-in-codegen-provider.md) is accepted.

## Alternatives Considered

- **Reuse "not recorded".** Raises a false defect on every Copilot run and trains readers to ignore the word. Rejected.
- **Show zeros for tokens and cost.** A `$0` already means "Groq free tier" in this console (`providers` limit text); a second meaning would corrupt the first. ADR-0043's rule forbids a default for a missing population. Rejected.
- **Estimate Copilot tokens from the diff size (chars/4), as the console does for LLM calls without usage.** That estimate is for a call we made and can measure the size of; here neither the prompt nor the context the agent read is visible. Rejected.
- **Overwrite `llm_call.provider` with `copilot`.** Merges the LLM that answered with the agent that produced the PR; breaks `providerBreakdown` and the fallback diagnostics. Rejected.
- **Hide the benchmark series from the dashboard.** Defeats the point of measuring; published results are the product of the exercise, with their limits attached. Rejected.
- **Ingest session logs for a full trace.** Not available by API as far as found (O11); and logs may contain secrets and model output, which the public record never carries. Rejected on both counts.

## Consequences

- ✅ A reader sees, per run, which provider wrote the patch and which stages are observable; opacity is stated, not hidden.
- ✅ No false defects, no invented numbers, no merged units.
- ✅ The known limits are in the definition table, where the metric is read, not only in an ADR.
- ⚠️ One more status and one more tone to maintain and test; every KPI with a call-based denominator needs a test that an untraced stage is excluded (not counted as zero).
- ⚠️ "Not traced" is permanent for the interior unless the vendor exposes more; the distinction between *not traced* and *not recorded* must stay clear in the code, or the first leaks into the second.
- ⚠️ Readers may still compare approval rates across arms without reading the limits; the page must place the limit text beside the figure, not below the fold.
- ⚠️ The field name is a public-record schema change (additive, optional); older records have no value and read as `adl`.

## Invariants check

| Invariant | Status |
|---|---|
| 1. Write guard preventive on any path that can reach `main` | Not affected: a rendering change. |
| 2. Every stage on such a path fully traced | **Upheld by making the violation visible**: an opaque stage is labelled "not traced" and is only present for the sandbox. It does not make such a stage admissible on a path to `main` ([ADR-0054](./0054-provider-admission-invariants.md)): the label documents the gap, it does not close it. |

**Related:** [ADR-0018](./0018-structured-observability.md), [ADR-0040](./0040-run-journal-and-public-run-record.md), [ADR-0041](./0041-end-to-end-work-item-tracing.md), [ADR-0043](./0043-diagnostic-observability-console.md), [ADR-0054](./0054-provider-admission-invariants.md), [ADR-0055](./0055-copilot-benchmark-mode.md).
