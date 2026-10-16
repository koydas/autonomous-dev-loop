# Observability

This document describes the structured observability system for the autonomous-dev-loop pipeline.

## Overview

Three complementary outputs are produced for every pipeline run:

1. **Structured JSON logs** — one JSON line per event written to stderr by each script.
2. **Run trace file** — one JSON file per GitHub Actions run, uploaded as an artifact: the spans, the **run journal** (every event of the run) and the **run envelope** (ADR-0039).
3. **Public run record** — the trace after the redaction allowlist, committed to the `metrics` branch as `metrics/runs/<YYYY-MM>/<run_id>-<attempt>.json` by "Commit metrics" (ADR-0039, see [Run record](#public-run-record)).

## Structured JSON Logs

Every meaningful event writes a single JSON line to **stderr**. No plain-text log lines appear on the instrumented paths.

### Schema

```json
{
  "ts": "<ISO8601>",
  "run_id": "<GITHUB_RUN_ID or 'local'>",
  "stage": "<stage_name>",
  "event": "<event_name>",
  "level": "info|warn|error",
  "duration_ms": <number | null>,
  "meta": { }
}
```

| Field        | Type            | Description                                                   |
|--------------|-----------------|---------------------------------------------------------------|
| `ts`         | ISO8601 string  | Wall-clock timestamp at emission time.                        |
| `run_id`     | string          | `GITHUB_RUN_ID` env var, or `"local"` when running outside CI. |
| `stage`      | string          | Pipeline stage name (see table below).                        |
| `event`      | string          | Dot-namespaced event name, e.g. `code_gen.llm_request`.       |
| `level`      | enum            | `info`, `warn`, or `error`.                                   |
| `duration_ms`| number \| null  | Populated on `*.complete`, `*.pass`, `*.fail`, `*.verdict`.   |
| `meta`       | object          | Stage-specific fields (see per-stage tables below).           |

### GitHub Actions annotations

When `GITHUB_ACTIONS=true` and `level === "error"`, the logger also emits a
`::error file=...,line=...::` annotation so failures surface in the Actions UI.
If `meta.file` is absent, the annotation has no file reference.

---

## Events by Stage

Every literal event name emitted under `scripts/` (tests excluded) must have a row in one of the tables below: `scripts/check_event_docs.mjs` fails CI otherwise (#198). Dynamic names (`` `${stage}.error` `` in `generate_issue_change.mjs`) are not checked.

### `issue_validation`

| Event                       | Level  | `duration_ms` | Key `meta` fields                               |
|-----------------------------|--------|---------------|-------------------------------------------------|
| `issue_validation.start`    | info   | —             | `issueNumber`, `issueTitle`, `model`            |
| `issue_validation.pass`     | info   | ✓             | `score`, `issueNumber`, `warnings_count`        |
| `issue_validation.fail`     | warn   | ✓             | `score`, `issueNumber`, `blockers_count`        |
| `issue_validation.comment_posted` | info | —           | `issueNumber`, `action` (`created` \| `updated`), `url` (comment `html_url`) — `upsert_issue_validation_comment.mjs` |
| `issue_validation.labels_applied` | info | —           | `issueNumber`, `added`, `removed` — `manage_labels.mjs` |

> `fail` is `warn` for a rejected issue (expected business outcome) and `error` for an unexpected exception.
> The comment and label steps run as separate processes in the same job: they attach to the same trace (`GITHUB_RUN_ID`) so their events join the validation run journal.

### `code_gen`

| Event                  | Level  | `duration_ms` | Key `meta` fields                         |
|------------------------|--------|---------------|-------------------------------------------|
| `code_gen.start`       | info   | —             | `issueNumber`, `model`                    |
| `code_gen.context_built` | info | —             | `shown_files`, `hidden_files` (withheld from the prompt: over the file budget, ADR-0029), `deterministic_block` (boolean) |
| `code_gen.llm_request` | info   | —             | `model`, `input_tokens_est`               |
| `code_gen.llm_response`| info   | —             | `output_tokens_est`                       |
| `code_gen.complete`    | info   | ✓             | `changes_count`                           |
| `code_gen.error`       | error  | ✓             | `error`; `reason: "blocked"`, `source` when the blocked escalation's GitHub calls failed (exit 1) |
| `code_gen.escalated`   | warn   | —             | `during` (`code_gen` \| `pr_prepare`), `reason` (`guardrail_rejected` \| `blocked`), `rules` or `source`, `labels_added`, `labels_removed` (blocked: `ready-for-dev`), `url` (rejection comment) — the issue went back to a human |
| `code_gen.skipped`     | warn   | ✓             | `reason: "guardrail_rejected"`, `rules`, `error` — `validateAiOutput()` rejected the patch (protected or unsafe path): issue commented, `needs-human`, `codegen_skip` metric, exit 0 with `rejected=true` (ADR-0019). `reason: "blocked"`, `source` (`denylist` \| `model` \| `notes_only`), `detail` — the issue cannot be implemented: no write, no PR, `ready-for-dev` → `needs-human`, issue commented with the reason and planned fix, `codegen_skip` metric (`reason: "blocked"`, `source`), exit 0 with `blocked=true` (ADR-0029 amendment) |

### `pr_prepare`

| Event              | Level  | `duration_ms` | Key `meta` fields              |
|--------------------|--------|---------------|--------------------------------|
| `pr_prepare.start`    | info   | —             | `changes_count`                |
| `pr_prepare.complete` | info   | ✓             | `paths`                        |
| `pr_prepare.error`    | error  | ✓             | `error`                        |
| `pr_prepare.skipped`  | warn   | ✓             | `reason: "guardrail_rejected"`, `rules`, `error` — the write guard, a static rule, the shrink guard or a symlink check (`unsafe_path`) rejected the patch before any write; same escalation as `code_gen.skipped` (ADR-0019) |

> Emitted by `generate_issue_change.mjs` when files are written to disk.
> The actual GitHub PR creation is performed by the `peter-evans/create-pull-request` action in the subsequent CI step.

### `review`

| Event              | Level  | `duration_ms` | Key `meta` fields                                        |
|--------------------|--------|---------------|----------------------------------------------------------|
| `review.start`     | info   | —             | `prNumber`, `model`                                      |
| `review.llm_request` | info | —             | `model`, `input_tokens_est`, `prNumber`                  |
| `review.llm_response`| info | —             | `output_tokens_est`, `prNumber`                          |
| `review.verdict`   | info   | ✓             | `verdict` (`"APPROVE"` \| `"REQUEST_CHANGES"` \| `"WITHHELD"`), `attempt`, `prNumber`, `evidence_state` (`available` \| `missing` \| `stale`), `evidence_override`, `unreviewed_code_files` (count of code files cut from the reviewed diff; > 0 turns an approval into `WITHHELD`, ADR-0038) |
| `review.skipped`   | info   | ✓             | `reason` (`already_reviewed` \| `superseded`), `prNumber`, `headSha` — no LLM call (ADR-0028) |
| `review.evidence_assessed` | info | —           | `prNumber`, `state` (`available` \| `missing` \| `stale`), `reason`, `failing`, `unverified` (check names) — the CI evidence read (ADR-0024, ADR-0026) |
| `review.prompt_truncated` | warn | —            | `prNumber`, `diff_truncated`, `body_truncated`, `unreviewed_code_files`, `adrs_shown`, `adrs_found`, `max_input_tokens` — the token budget cut the prompt (ADR-0028, ADR-0036, ADR-0038) |
| `review.comment_posted` | info  | —             | `prNumber`, `action` (`created` \| `updated`), `headSha`, `url` |
| `review.review_submitted` | info / warn | —     | `prNumber`, `review_event` (`APPROVE` \| `REQUEST_CHANGES` \| `COMMENT`), `url`; warn with `skipped: "own_pull_request"` when GitHub refused the review on the actor's own PR |
| `review.labels_applied` | info  | —             | `prNumber`, `added`, `removed`, `repulse_skipped` (auto-fix already running) |
| `review.error`     | error  | —             | `error`                                                  |
| `review.stale_refs_error` | warn | — | `error` — file listing or read failed; the review continues without stale references (ADR-0035) |
| `review.related_adrs_error` | warn | — | `error` — file listing or ADR read failed; the review continues without related ADRs (ADR-0036) |
| `review.prompt_budget_error` | warn | — | `error` — base (`git show`) or head read of a changed prompt failed; the review continues without the prompt budget block (ADR-0037) |
| `review.models_config_ignored` | warn | — | `path`, `error` — the PR tree's `config/models.yaml` is not a regular file (symlink, FIFO, …) or cannot be read; the prompt budget uses the trusted defaults and the review continues (ADR-0023, ADR-0037) |

### `review_evidence`

Emitted by `run_review_evidence.mjs` in the `evidence` job of `pr-review.yml` (ADR-0024).

| Event                       | Level | `duration_ms` | Key `meta` fields                                  |
|-----------------------------|-------|---------------|----------------------------------------------------|
| `review_evidence.start`     | info  | —             | `configPath`                                       |
| `review_evidence.complete`  | info  | ✓             | `headSha`, `checks` (map of check name → status)   |
| `review_evidence.error`     | error | ✓             | `error`                                            |

The `evidence` and `review` jobs share one `GITHUB_RUN_ID`, so the evidence trace is written to `observability/traces/<GITHUB_RUN_ID>-evidence.json` and uploaded as `run-trace-<GITHUB_RUN_ID>-evidence` to avoid overwriting the review trace.

### `autofix`

| Event                          | Level  | `duration_ms` | Key `meta` fields                         |
|--------------------------------|--------|---------------|-------------------------------------------|
| `autofix.start`                | info   | —             | `attempt`, `prNumber`                     |
| `autofix.reset`                | info   | —             | `prNumber`, `removed_labels`, `removed_checkpoints` — trusted checkbox rerun |
| `autofix.prompt_budget`        | info / warn | —        | `prNumber`, `attempt`, `input_budget`, `shown_files`, `hidden_files`, `skipped_files` (over `MAX_FILES`), `diff_truncated`, `feedback_truncated`; warn when anything was cut |
| `autofix.llm_request`          | info   | —             | `model`, `input_tokens_est`, `attempt`, `prNumber` |
| `autofix.llm_response`         | info   | —             | `output_tokens_est`, `attempt`, `prNumber`|
| `autofix.push`                 | info   | ✓             | `paths`, `attempt`, `prNumber` — files written; the git push is the workflow's (`workflow.push`) |
| `autofix.attempt_labeled`      | info   | —             | `prNumber`, `attempt`, `label`            |
| `autofix.escalated`            | warn   | —             | `prNumber`, `attempt`, `reason` (`no_changes` \| `guardrail_rejected`), `labels_added`, `url` (escalation comment) |
| `autofix.max_attempts_reached` | warn   | —             | `attempt`, `prNumber`, `url` (exhausted comment) |
| `autofix.skipped`              | info / warn | ✓        | `reason` (`untrusted_comment`, info: before the tracer, stderr only \| `self_modification`, warn: the PR changes `auto_fix_pr.mjs`, comment posted (`url`) \| `approved`, info: no LLM call \| `no_changes`, warn: attempt consumed, `needs-human` applied, summary commented, `autofix_skip` metric \| `guardrail_rejected`, warn: same, with the rejection reason commented — write denylist, shrink guard, ADR-0029 write guard or ADR-0019 static rules; `rules` lists them), `attempt`, `prNumber`, `headSha` (approved only) — exit 0, nothing pushed (ADR-0028) |
| `autofix.error`                | error  | ✓             | `error`, `attempt`, `prNumber`            |

### `eval`

Emitted by `run_evals.mjs` (ADR-0027).

| Event           | Level | `duration_ms` | Key `meta` fields |
|-----------------|-------|---------------|-------------------|
| `eval.start`    | info  | —             | `suite`, `repeats`, `replay`; once the dataset is loaded also `cases`, `tokens_est`, `tokens_est_per_run`, `tokens_est_source` |
| `eval.complete` | info  | ✓             | `suite`, `passed`, `resultsFile` |
| `eval.error`    | error | ✓             | `error`; on a circuit-breaker abort also `reason: "provider_quota"`, the breaker fields and `resultsFile` |

### `eval_replay`

Emitted by `replay_evals_ci.mjs`.

| Event                  | Level | `duration_ms` | Key `meta` fields |
|------------------------|-------|---------------|-------------------|
| `eval_replay.start`    | info  | —             | `suites`, `source` (site URL or directory) |
| `eval_replay.complete` | info  | ✓             | `status`, `suites` (map of suite → status) |
| `eval_replay.error`    | error | ✓             | `error` |

### `pr_evals`

Emitted by `plan_pr_evals.mjs` (ADR-0030).

| Event               | Level | `duration_ms` | Key `meta` fields |
|---------------------|-------|---------------|-------------------|
| `pr_evals.start`    | info  | —             | `mode` (`plan` \| `apply`), `pr` |
| `pr_evals.complete` | info  | ✓             | `mode`; plan: `status`, `suites`, `prompts`; apply: `applied` |
| `pr_evals.error`    | error | ✓             | `mode`, `error` |

### `pr_evals_report`

Emitted by `report_pr_evals.mjs` (ADR-0030).

| Event                      | Level | `duration_ms` | Key `meta` fields |
|----------------------------|-------|---------------|-------------------|
| `pr_evals_report.start`    | info  | —             | `source` (site URL or directory) |
| `pr_evals_report.complete` | info  | ✓             | `status`, `suites` |
| `pr_evals_report.error`    | error | ✓             | `error` |

### LLM provider

Emitted by `llm_client.mjs` and `config.mjs` (ADR-0032). `stage` is the calling stage for the LLM events and `config` for `provider_config_fallback`.

| Event                      | Level         | `duration_ms` | Key `meta` fields |
|----------------------------|---------------|---------------|-------------------|
| `llm_call`                 | info          | ✓             | `provider`, `model`, `fallback` — the provider and model that answered (ADR-0039); `stage` is the calling stage. Feeds `envelope.llm_calls` |
| `llm_call_failed`          | warn          | ✓             | `providers` (`<provider>:<status \| skip reason>`) — no provider answered; the caller gets the error |
| `llm_fallback`             | warn / error  | —             | `from`, `to`, `error_type`, `error` — the primary failed and the call goes to the other provider; `error` level when the primary's key or config is wrong (`PERMANENT`, 401/403) |
| `llm_fallback_disabled`    | warn          | —             | `from`, `error_type`, `error` — the primary failed and the caller passed `fallback: false` (live evals) |
| `provider_config_fallback` | warn          | —             | `message`, `ai_provider`, `provider` — `AI_PROVIDER` is unknown or names a provider without a key; logged once per process |

### `retry`

Emitted by `retry.mjs` before each wait of `retryWithBackoff` (GitHub API calls and LLM clients, ADR-0022).

| Event        | Level | `duration_ms` | Key `meta` fields |
|--------------|-------|---------------|-------------------|
| `retry.wait` | warn  | —             | `attempt`, `wait_ms`, `status` (HTTP, or null), `error` |

### `workflow`

Emitted by `commit_run_record.mjs` ("Commit metrics") for what a workflow step did, not a script (ADR-0039).

| Event                   | Level       | `duration_ms` | Key `meta` fields |
|-------------------------|-------------|---------------|-------------------|
| `workflow.pr_operation` | info        | —             | `prNumber`, `operation` (`created` \| `updated` \| `closed` \| `none`), `url` — `peter-evans/create-pull-request` outputs (code-generation) |
| `workflow.push`         | info / warn | —             | `prNumber`, `outcome` (`success` \| `failure` \| `skipped`) — the auto-fix "Commit and push fixes" step; warn on failure |

### `dependency_manifest`

Emitted by `dependency_manifest.mjs` (#195, ADR-0023) in the review, code generation and auto-fix stages. The stage continues with no manifest.

| Event                                     | Level | `duration_ms` | Key `meta` fields |
|-------------------------------------------|-------|---------------|-------------------|
| `dependency_manifest.package_json_ignored` | warn  | —             | `path`, `reason` (`not_regular_file` or an error code) — `package.json` in the working tree is not a regular file (symlink, directory, FIFO, …; never followed) or cannot be read; it is treated as missing |

### `observability`

Emitted by `observability.mjs` itself when a trace operation fails. The business logic continues.

| Event                   | Level | `duration_ms` | Key `meta` fields |
|-------------------------|-------|---------------|-------------------|
| `trace_write_failed`    | warn  | —             | `error` |
| `start_span_failed`     | warn  | —             | `error`, `stage` |
| `end_span_failed`       | warn  | —             | `error`, `stage` |
| `trace_finalize_failed` | warn  | —             | `error` |

---

## Run Trace File

### Location

`observability/traces/<GITHUB_RUN_ID>.json`

Created incrementally as each stage starts and ends. Finalized (with `completed_at` and `outcome`) at the end of each script.

### Schema

```json
{
  "run_id": "<GITHUB_RUN_ID>",
  "issue_number": <number | null>,
  "started_at": "<ISO8601>",
  "completed_at": "<ISO8601 | null>",
  "outcome": "success|partial|failed|null",
  "schema_version": 1,
  "envelope": { "workflow": "…", "run_id": "…", "run_attempt": 1, "event_name": "…", "actor": "…", "actor_type": "bot|human|null",
                "repository": "owner/repo", "issue_number": null, "pr_number": 12, "head_sha": "<sha | null>",
                "run_url": "…", "issue_url": null, "pr_url": "…",
                "links": [{ "event": "review.comment_posted", "url": "…" }],
                "llm_calls": [{ "stage": "review", "provider": "groq", "model": "…", "fallback": false, "outcome": "answered|failed", "duration_ms": 900 }] },
  "events": [ { "ts": "…", "run_id": "…", "stage": "…", "event": "…", "level": "…", "duration_ms": null, "meta": { } } ],
  "events_overflow": { "count": 0, "bytes": 0 },
  "spans": [
    {
      "stage": "<stage_name>",
      "started_at": "<ISO8601>",
      "completed_at": "<ISO8601 | null>",
      "duration_ms": <number | null>,
      "outcome": "success|failed|skipped|null",
      "meta": { }
    }
  ]
}
```

`outcome` values:

| Value     | Meaning                                                         |
|-----------|-----------------------------------------------------------------|
| `success` | All expected work completed without errors.                     |
| `partial` | Script work completed, but with a non-fatal or pending outcome. Examples: issue validation rejected, review requested changes, or autofix files were written and outputs set but the downstream git push CI step has not yet run. |
| `failed`  | Terminated due to an error.                                     |
| `skipped` | Stage was intentionally bypassed (e.g. max attempts reached).   |

> **`autofix` stage and `partial`**: `auto_fix_pr.mjs` finalizes as `partial` (not `success`) because the git commit and push are performed by the CI step that runs *after* the script exits. The trace accurately records script-level completion; the workflow artifact upload (which runs after the push step) reflects whether the overall job succeeded.

### Run journal and envelope (ADR-0039)

`scripts/lib/run_journal.mjs`, fed by `observability.mjs`: `log()` records each event it writes to stderr, `createTracer()` points the journal at `<traceDir>/<runId>.json`.

- **Journal** — `events[]`: every `log()` event of the run, in emission order, written to the trace file on each event (a killed job keeps them). Events logged before the tracer exists are adopted by it. Meta strings are scrubbed in the logging process (its non-public env values of 12+ characters, credential shapes; not truncated) before they reach the trace: the stderr line is unchanged. A later process of the same job (the validation comment and label steps) appends to the events already in the file.
- **Caps** — at most 500 events and 256 KiB of events per trace; past either, an event is counted in `events_overflow` (`count`, `bytes`), never kept and never silently lost; the counter reaches the file with the next tracer write (`endSpan`, `finalize`), not on each overflowed event. An event over 8 KiB keeps its name, level and timing; its meta becomes `{ "_meta_dropped_bytes": n }`.
- **Envelope** — derived from the Actions env (`GITHUB_WORKFLOW`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_EVENT_NAME`, `GITHUB_ACTOR`, `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`), the event payload (`GITHUB_EVENT_PATH`: PR/issue number, head SHA, sender type) and the journal (numbers the payload lacks from the first `prNumber` / `issueNumber` / `headSha` meta; `links` from every `meta.url`; `llm_calls` from `llm_call` / `llm_call_failed`). `actor_type` is `bot` for a `Bot` sender or a `[bot]` login.
- **Failure containment** — a journal write failure is one `trace_write_failed` warn per process; a missing directory or a half-written trace is skipped (the next tracer write carries the events). stdout is never written.

### Artifact

Each participating workflow uploads the trace file as a GitHub Actions artifact named
`run-trace-<GITHUB_RUN_ID>` using `if: always()`, so the file is preserved even on failures.

> **Note on cancellation**: `if: always()` does not cover job cancellation in all
> versions of `actions/upload-artifact`. If a job is cancelled mid-run the artifact
> may not be uploaded. This is a known GitHub Actions limitation.

---

## Public Run Record

`metrics/runs/<YYYY-MM>/<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>.json` on the `metrics` branch: the dashboard's source. Written by `scripts/commit_run_record.mjs` (the "Commit metrics" step of `validate-issue`, `code-generation`, `pr-review` and `auto-fix-pr`) in **the same commit** as the run's `metrics/runs.jsonl` lines, with the same 3-attempt retry (ADR-0013, ADR-0039).

### Redaction contract

`redactTrace()` in `scripts/lib/run_record.mjs` is the only path from a trace to the store. The site is public:

| Rule | Detail |
|---|---|
| Allowlist, not denylist | Event meta keeps only the keys listed for that event in `EVENT_META_ALLOWLIST`; an unlisted event keeps its name, level and timing with `meta: {}`. Span meta keeps `SPAN_META_ALLOWLIST`. Unknown top-level and envelope keys are dropped. |
| Never stored | Prompts, raw model output, file contents, issue/PR titles and bodies, previews, stack traces, stderr tails, env, local paths. |
| Strings | Already scrubbed against the producing step's env by the journal; scrubbed again against the committing step's env, then cut to 200 characters: every env value of 12+ characters except public run metadata (`GITHUB_REPOSITORY`, `GITHUB_SHA`, …, `*_MODEL`, `*_EFFORT`, `*_PROVIDER`, `RUN_RECORD_*`), and credential shapes (`ghp_…`, `github_pat_…`, `sk-ant-…`, `gsk_…`, `Bearer …`, JWTs, AWS keys). |
| Values | Numbers, booleans, null; arrays of primitives (≤ 50 items); one level of flat map. Nested objects are dropped. |
| URLs | Kept whole only on `GITHUB_SERVER_URL`, URL-safe characters, nothing to scrub; otherwise null. |
| Size | ≤ 256 KiB per record; events past it are added to `events_overflow`. |

### Schema (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "trace_schema_version": 1,
  "run_id": "<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>",
  "envelope": { "...": "as in the trace, validated" },
  "started_at": "<ISO8601 | null>", "completed_at": "<ISO8601 | null>", "outcome": "<string | null>",
  "spans": [{ "stage": "…", "started_at": "…", "completed_at": "…", "duration_ms": 0, "outcome": "…", "meta": { } }],
  "events": [{ "ts": "…", "stage": "…", "event": "…", "level": "info|warn|error", "duration_ms": null, "meta": { } }],
  "events_overflow": { "count": 0, "bytes": 0 }
}
```

A consumer must ignore unknown fields and branch on `schema_version`. `run_id` matches the `run_id` of the run's `runs.jsonl` records (ADR-0013).

### Dedup and retention

- The first record for a `run_id` (run + attempt) wins: a record already on the branch is not rewritten; the `runs.jsonl` lines are still appended (report-time dedup, ADR-0013).
- A run that never created a tracer (an untrusted auto-fix comment, a review with no open PR) writes no record. The `pr-review` evidence job's trace stays an artifact only.
- Size: ~3–10 KB per record (10–40 events), ~600 runs/month at the current activity → **≈ 2–6 MB/month**; hard ceiling 256 KiB × runs. Records are kept 12 months; older `metrics/runs/<YYYY-MM>/` directories are removed by hand on the `metrics` branch (no automated pruning yet).

---

## Reading a Trace Locally

```bash
# After downloading the artifact (unzip run-trace-<id>.zip first):
cat observability/traces/<run_id>.json | jq .

# Show only stages and outcomes:
cat observability/traces/<run_id>.json | jq '[.spans[] | {stage, outcome, duration_ms}]'

# Filter failed spans:
cat observability/traces/<run_id>.json | jq '[.spans[] | select(.outcome == "failed")]'

# Show overall pipeline outcome:
cat observability/traces/<run_id>.json | jq '{run_id, outcome, completed_at}'
```

---

## Implementation Reference

All instrumentation goes through `scripts/lib/observability.mjs`. Do not construct
JSON log lines inline in business logic files.

```javascript
import { log, createTracer } from './lib/observability.mjs';
import path from 'node:path';

// Emit a structured event
log({ stage: 'code_gen', event: 'code_gen.start', level: 'info', meta: { model } });

// Manage a run trace
const tracer = createTracer({
  runId: process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`,
  issueNumber: 42,
  traceDir: path.join(process.cwd(), 'observability', 'traces'),
});

tracer.startSpan('code_gen', { model });
// ... do work ...
tracer.endSpan('code_gen', { outcome: 'success', meta: { changes_count: 3 } });
await tracer.finalize('success');
```

### API

#### `log(options)`

| Option       | Type            | Default  | Description                        |
|--------------|-----------------|----------|------------------------------------|
| `stage`      | string          | required | Pipeline stage name.               |
| `event`      | string          | required | Dot-namespaced event name.         |
| `level`      | string          | `'info'` | `'info'`, `'warn'`, or `'error'`.  |
| `duration_ms`| number \| null  | `null`   | Elapsed time in milliseconds.      |
| `meta`       | object          | `{}`     | Stage-specific metadata.           |

Writes one JSON line to `process.stderr`. Never throws.

#### `createTracer(options)`

| Option        | Type          | Default  | Description                                  |
|---------------|---------------|----------|----------------------------------------------|
| `runId`       | string        | required | Used as the trace filename (`<runId>.json`).  |
| `issueNumber` | number \| null| `null`   | Written to `trace.issue_number`.              |
| `traceDir`    | string        | required | Directory where trace files are written.      |

Returns an object with:

- **`startSpan(stage, meta?)`** — Opens a span, writes the trace file. Idempotent (re-opening a stage replaces the existing span).
- **`endSpan(stage, { outcome?, meta? }?)`** — Closes a span, records `duration_ms` and `completed_at`.
- **`finalize(outcome)`** — Writes `completed_at` and `outcome` to the trace root. Returns a Promise. Should be `await`ed before process exit.

All three methods are safe to call from any context — they catch their own errors and emit a `warn`-level log on failure rather than throwing.
