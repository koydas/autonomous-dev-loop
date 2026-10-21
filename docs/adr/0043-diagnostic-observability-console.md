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

### Visual design (2026-10-20, from the design mockup in the README)

- Console shell (`dashboard_ui.mjs`): dark theme by default (light on demand, stored per browser, applied before paint), top tabs with icons, a sidebar with the sections and page filters (status, stage reached, LLM provider facets over the pipeline lists), a phone tab bar with a More menu, "Updated …" from the build time and the findings count on the Diagnostics link (both filled by `assembleSite`).
- Overview (`console_overview.mjs`): windowed indicators (`computeWindows`: 7 / 14 / 30 days ending on the latest recorded run, all precomputed; a select shows one) with change vs the previous window and sparklines, results / duration / provider charts, issue cards, recent pipelines.
- Pipelines rows (`flow_dashboard.mjs`): one table row per work item that opens into stage boxes and key information; the same rows serve the Overview.
- Trace page: tabs (Overview, Timeline, LLM calls, Events, GitHub Actions, Traces), progressive enhancement over plain sections.
- With pipeline views, the base and component CSS ships once in `pipeline/console.css` instead of inline on each of the ~120 pages (site 4.42 MB, was 4.33 MB before the console); an eval-only build keeps it inline.

Deviations from the mockup, by data: no **Running** status or count (records are written on completion); **Success rate** became the review approval rate (no run failed in the sample, so a job success rate reads 100 % and hides the withheld reviews); PR titles come from the GitHub API in the browser (titles are not in the public record); Groq shows "free tier" with its share of calls next to its 0 % share of cost; the status badge never says "healthy", only what the rules found.

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
- ⚠️ Dark by default: a reader who prefers light switches once per browser.
- ⚠️ Windows are relative to the latest recorded run, not to the build time: after a quiet week the "last 7 days" are the last 7 days with data, as the subtitle states.

## Amendment (2026-10-20): guardrail outcomes are not anomalies

On the first real data (`metrics` branch, October 2026) the two loudest warnings were guardrails doing their job: 66 of 80 verdicts WITHHELD, every one with code cut to the Groq review budget (ADR-0038), and 4 auto-fix attempts without a push, each stopped by a protected target (ADR-0021) or by files the budget withheld from the prompt (ADR-0029). A warning that fires on designed behaviour hides the real anomalies among them.

The `review-withheld` and `autofix-ineffective` rules now classify each case, and the share thresholds (`withheldShare`, `autofixNoPushShare`) apply to the **anomaly share**. The total share still decides whether the card is shown, so the volume stays visible; the severity is `warning` only above the threshold on anomalies, `info` otherwise, with the ADRs of the guardrails observed in the title.

- **Review** — each WITHHELD verdict keeps its cause from `withheldCause()` (`pipeline_health.mjs`, the Metrics page's split), the provider whose answer it is (the run's last non-failed review call) and the input budget its prompt was cut to (`review.prompt_truncated.max_input_tokens`). Guardrail: a code cut (`approve_cut`, `cut_unknown`, ADR-0038) or missing / stale CI evidence (ADR-0026). Anomaly: REQUEST_CHANGES withheld on unseen code (`rc_unseen`), an unknown cause (`other`), and a fallback answering a prompt cut to the primary's budget (a budget is set only by a budgeted provider: the fallback saw no more than Groq would have, cf. #242), unless missing / stale CI evidence withheld it, which stays a guardrail. Distinct heads are keyed by PR and SHA. The fact counts verdicts, distinct PR heads and PRs (WITHHELD does not dedup, ADR-0028), and lists responding providers and budgets.
- **Auto-fix** — an attempt is blocked by design when every rejected rule is `protected_path`, `unshown_file` or `withheld_file`; or when it proposed no change while `autofix.prompt_budget.hidden_files` was not empty. Anything else without a delivered push is an anomaly. Skip reasons and evidence come from the attempts only. A run stopped on an approved head (ADR-0028) or at the attempt limit (ADR-0034) exits before `autofix.start`: it is not an attempt and never counts as one, push or anomaly.

⚠️ The records do not name the files a `no_changes` attempt needed (the model returned `changes: []`): "files withheld by budget" is the closest observable cause, not proof that the needed files were among them. A `no_changes` on a false finding in a PR that also had hidden files reads as blocked by design. No producer or record change.

## Amendment (2026-10-21): findings have a lifecycle

A rule is evaluated over the whole retained window, so a problem fixed at the source stayed a `warning` until its history aged out (on the October 2026 data: "Review diffs are cut" at 88 % and "Same PR head reviewed more than once" after the review moved to Anthropic, with 11 clean reviews since). Every finding now carries `first_seen`, `last_seen` and a `status`: `active` while the pattern occurs in the last `RULES.activeWindow` (10) runs its rule could have fired on, `resolved` otherwise. A resolved finding is `info`, titled "… — resolved since <date of the first clean run>"; the historical numbers stay in `fact` and `evidence`, and a new occurrence makes it active again. The guardrail / anomaly split extends to `review-coverage` (cut + WITHHELD is ADR-0038; cut + APPROVE is impossible since ADR-0038 and `critical`) and `review-duplicates` (a second run after a WITHHELD verdict or as a manual re-run is ADR-0028; two runs on one head that the marker skipped neither is the push / pull_request race). The Overview "Issues requiring attention" lists active warning / critical findings only; resolved ones stay on the Diagnostics page. A finding is still computed over the whole window, so it leaves the list once the historical share falls under its threshold.
