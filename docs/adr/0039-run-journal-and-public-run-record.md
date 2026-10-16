# ADR-0039: Run journal in the trace and a redacted public run record on the `metrics` branch

- **Date:** 2026-10-15
- **Status:** Accepted

## Context

A dashboard must show every action the pipeline agent takes (validation, code generation, review, auto-fix): LLM calls with the provider and model that answered, labels, comments, pushes, PRs, guardrail decisions, budget cuts, fallbacks, retries, skips. What existed:

- `log()` (ADR-0018) writes JSON events to stderr only: they live in the job log, which expires and is not machine-readable across runs.
- The trace file (`observability/traces/<run>.json`, ADR-0018) holds stage spans only, as an artifact with a retention limit.
- `metrics/runs.jsonl` on the `metrics` branch (ADR-0013) holds one coarse summary per issue/PR, and only for some outcomes.
- Several side effects emitted no event at all (validation comment and labels, review comment/review/labels, auto-fix attempt label, escalations, self-modification skip, budget cuts, retries), and none recorded the provider that actually answered a fallback call.

The dashboard site is public, so whatever is persisted must be safe to publish: no prompts, model output, file contents, secrets or environment.

## Decision

### 1. Every side effect is an event

Missing events are added through `scripts/lib/observability.mjs` only (inventory in the pull request that introduced this ADR; event tables in `docs/observability.md`): `issue_validation.comment_posted` / `labels_applied`, `code_gen.context_built` / `escalated`, `review.evidence_assessed` / `prompt_truncated` / `comment_posted` / `review_submitted` / `labels_applied`, `autofix.reset` / `prompt_budget` / `attempt_labeled` / `escalated`, `autofix.skipped` reasons `untrusted_comment` and `self_modification`, `retry.wait`, and `llm_call` / `llm_call_failed` emitted by `callLLM()` next to `onAnswer` (#192) so every stage records the provider and model that answered without its callers changing. What a workflow step does (the PR opened by `create-pull-request`, the auto-fix `git push`) is journaled by the "Commit metrics" step as `workflow.pr_operation` / `workflow.push` from the step outputs.

### 2. Run journal in the trace file (`scripts/lib/run_journal.mjs`)

`log()` hands each serialized line to the journal; `createTracer()` points it at the trace file. The trace gains `schema_version: 1`, `events[]` (every event, in order), `events_overflow { count, bytes }` and `envelope`.

- Written on each event, so a killed job keeps what happened before the kill (same reasoning as ADR-0018 §D).
- Process-wide: events logged before the tracer are adopted; a later process of the same job (validation comment and label steps) appends to the events already in the file. A trace already at the path is adopted only when its `envelope` names this run id and attempt; any other file there (e.g. one committed in the PR head that `pr-review` / `auto-fix` check out) is replaced by a fresh trace, so it can inject neither events nor spans.
- `finalize()` writes synchronously: an event logged while an async write was pending would be overwritten by the older content.
- Capped at 500 events and 256 KiB; past a cap an event is counted, never kept and never dropped silently. A single event over 8 KiB keeps name, level and timing, its meta replaced by its size.
- Failures stay contained: one `trace_write_failed` warn per process, no recursion, no throw; stdout untouched.

### 3. Run envelope

Built from the Actions env, the event payload (only the fields it needs are read) and the journal: workflow, run id/attempt, trigger event, actor and actor type (`bot` for a `Bot` sender or a `[bot]` login), repository, issue/PR number, head SHA, run/issue/PR URLs, the `html_url` of every comment and review the GitHub API returned (`links`), and one `llm_calls` entry per LLM call.

### 4. Public-safety contract (`redactTrace()` in `scripts/lib/run_record.mjs`)

The only path from a trace to the store. Allowlist of meta keys **per event** (`EVENT_META_ALLOWLIST`), and per span; an unlisted event keeps name/level/timing with empty meta; unknown keys are dropped. Strings are scrubbed (every non-public env value of 12+ characters, credential shapes) **then** cut to 200 characters, so a secret at the cut cannot survive partially. The env scrub runs twice: in the journal, against the env of the process that writes the trace (the step holding the LLM keys) — event meta and span meta alike, since every tracer write goes through the journal — and in `redactTrace()`, against the env of the "Commit metrics" step — which does not hold those keys, so a scrub there alone would not cover them. Nested objects are dropped; arrays ≤ 50 primitives; URLs are kept whole only on `GITHUB_SERVER_URL` with nothing to scrub. Records are capped at 256 KiB. A new event's meta is unpublished until its keys are added to the allowlist — the safe default.

### 5. Storage layout and persistence

`metrics/runs/<YYYY-MM>/<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>.json` (record `schema_version: 1`; `run_id` = the ADR-0013 composite) on the `metrics` branch. `scripts/commit_run_record.mjs` replaces the shell of each "Commit metrics" step: it writes the run's `runs.jsonl` lines **and** the record in **one commit** through the Git Data API (tree on `base_tree`, commit, fast-forward-only ref update), retried 3 times with 2 s / 4 s backoff from a fresh read — the Contents API wrote one file per commit and capped reads at 1 MB. `runs.jsonl` is read raw. Dedup: the first record for a `run_id` + attempt wins (an existing file is not rewritten). Pipelines checked out from a PR run the trusted copy of the script (ADR-0023); the trace is read only as a regular file (no symlink, ADR-0021).

Retention: a record is ~3–10 KB (measured 5.5 KB for a 16-event review); at ~600 runs/month (assumption) that is 2–6 MB/month, ceiling 256 KiB × runs. Records are kept 12 months; older month directories are removed by hand on the `metrics` branch.

## Alternatives Considered

- **Persist raw stderr / full traces** — rejected: prompts, model output, file contents and error tails would reach a public site; a denylist cannot be proven complete.
- **Redact at `log()` time** — rejected: the artifact trace is the operator's debugging copy; redaction belongs at the publication boundary, in one function with one test suite.
- **A file per event, or JSONL per day** — rejected: concurrent jobs would conflict on the same file; one file per run attempt is conflict-free and dedups by name.
- **Keep the Contents API, two PUTs** — rejected: two commits, and a crash between them leaves the metrics and the record out of step.
- **OpenTelemetry exporter** (ADR-0018 §A) — still out of scope: needs a collector and a dependency.

## Consequences

- ✅ Each run leaves a durable, public-safe, machine-readable record of every action, the provider/model per LLM call, and links back to GitHub.
- ✅ `observability.mjs` keeps its API (`log`, `createTracer` unchanged); entrypoints only add `log()` calls.
- ✅ One commit per run on `metrics`: metrics and record never diverge.
- ⚠️ Over-redaction by design: a public value that happens to equal a non-public env value is replaced by `[redacted]`; a new event publishes no meta until allowlisted.
- ⚠️ Free-text fields (`error`, `reason`, `detail`) are published, scrubbed and cut to 200 characters: an error message quoting content would leak at most that much per field.
- ⚠️ The `metrics` branch grows without automated pruning; same integrity caveat as the ADR-0013 amendment (any `contents: write` token can rewrite it).
- ⚠️ Runs that exit before their tracer (untrusted auto-fix comment, review with no open PR) and the `pr-review` evidence job leave no record; the step after "Commit metrics" in `validate-issue` (dispatching code generation) is not journaled — the code-generation run records itself.
