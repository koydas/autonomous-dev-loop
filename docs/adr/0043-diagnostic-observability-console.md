# ADR-0043: Diagnostic observability console

- **Date:** 2026-10-20
- **Status:** Accepted

## Context

The dashboard (ADR-0027 amendment, ADR-0040, ADR-0041, ADR-0042) published every recorded fact — runs, events, spans, LLM calls, costs, eval runs — but organised by data source (activity feed, traces, health tables, flow map). Answering "is the system working, where and why not, what to fix first" took reading several pages and interpreting raw counts. Two presentation choices actively hid information:

- The flow map icon of a step was the outcome of its **latest** execution (`stageStatus()`): Review failed, failed, then succeeded showed ✓, with no trace of the two failures on the card.
- Execution status and business decision were conflated in one icon: a review span closed as `success` with a `WITHHELD` verdict showed ✓. On the retained sample (90 runs, 2026-10-16 → 20), 52 of 66 verdicts were `WITHHELD`, 64 of 66 reviews saw a cut diff, and 14 PR heads were reviewed twice (push + pull_request) — none of which was visible on the home page.

## Decision

Reorganise the static site into **Overview → Diagnostics → Pipelines → Investigation** (+ Metrics, the former Health page), with a strict data / diagnosis / presentation split. All pure modules, c8-gated:

- `scripts/lib/pipeline_journey.mjs` — per work item, every attempt of every canonical step (Validation, Code generation, PR preparation, Review, Auto-fix) with its **execution status** (stage span outcome: success / failed / skipped / not recorded) and its **decision** (the journal event: verdict, rejection, block, push, …) side by side; the final attempt, failure and adverse-decision counts, automatic recovery, escalations, and the item's *last recorded state*. Conditional steps say why they are absent (no linked issue; auto-fix not triggered without REQUEST_CHANGES). Running is not observable (records are written on completion) and merge is not journaled: neither is inferred.
- `scripts/lib/pipeline_kpis.mjs` — the overview indicators, each shipped with its definition (source, method, period, population, known limits). A missing population yields `null`, never a default.
- `scripts/lib/pipeline_diagnostics.mjs` — fixed, deterministic rules (no LLM) with named thresholds (`RULES`): failed runs, repeated stage failures, withheld reviews and cut diffs, duplicate reviews of one head, PRs stuck without approval, ineffective auto-fix, blocked generation, provider fallbacks, 429 waits, stage duration regressions, escalations. Each finding carries the observed `fact`, an optional `hypothesis` (rendered as "interpretation, not verified"), impact, frequency and capped evidence (run, event, summary, https source link). Telemetry gaps are listed as "insufficient data", never as health; the status is `no_data` without runs and "no problem detected" says it is not proof of health.
- `scripts/lib/console_views.mjs` — rendering of the overview block (home page), the Diagnostics page, the journey panel (trace page), key events and per-step status/decision (run page), a URL-synced filter bar and the browser-side PR state loader shared by Overview and Pipelines.

The Pipelines page (`flow_dashboard.mjs`, ADR-0042) lists **every recorded work item** (not only merged PRs), shows the final status icon per step plus ×N attempts, an amber ring when the step completed with an adverse decision, and the full attempt history on expansion. GitHub's PR state (`pulls?state=all`, ≤ 10 pages, 5-minute `sessionStorage` cache) is laid over it: `merged_at` → merged, closed without it → closed unmerged, open → open; a recorded PR number takes precedence over a branch/closing-reference hint, so one PR never lands on two items. Merged PRs without a recorded flow still get a card.

Navigation: Overview · Diagnostics · Pipelines · Investigation · Metrics. Every existing page, table and JSON file stays; the full event journal moves behind a disclosure on run pages, after the key events.

## Alternatives Considered

- **A front-end framework (React/Vue) or a hosted observability backend**: rejected — the site is a static Pages build from the `metrics` branch with no credential (ADR-0027, ADR-0042); a framework adds a build chain for no capability the inline scripts lack.
- **An LLM-written diagnosis**: rejected — every problem worth reporting is a deterministic pattern over recorded events, and a generated explanation could present a hypothesis as fact.
- **New producer-side fields** (separate execution status / decision, a merge journal): deferred — the producer change is tracked in `docs/dashboard-partial-diagnosis.md`; the console derives both from existing events without touching the pipeline.

## Consequences

- ✅ The home page answers "is it working" with a status, six indicators that each link to their explanation, the main problems and the items waiting on a person.
- ✅ Intermediate failures and adverse decisions are visible on the collapsed card and listed per attempt; execution status and decision are never conflated.
- ✅ Every indicator and finding is traceable to the runs and events it was computed from.
- ⚠️ "Last recorded state" can be stale: a person may already have acted (labels, merge). Overview and Pipelines re-check merges live; label state is not recorded.
- ⚠️ Rules have fixed thresholds: below them a pattern is not reported. Duration trends need ≥ 3 runs in each of the two latest 7-day periods; otherwise the gap is stated.
- ⚠️ Inline console CSS on every page adds about 1 MB to the deployed site at the current record count.
