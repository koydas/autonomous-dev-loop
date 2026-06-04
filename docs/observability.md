# Observability

This document describes the structured observability system for the autonomous-dev-loop pipeline.

## Overview

Two complementary outputs are produced for every pipeline run:

1. **Structured JSON logs** — one JSON line per event written to stderr by each script.
2. **Run trace file** — one JSON file per GitHub Actions run, uploaded as an artifact.

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

### `issue_validation`

| Event                       | Level  | `duration_ms` | Key `meta` fields                               |
|-----------------------------|--------|---------------|-------------------------------------------------|
| `issue_validation.start`    | info   | —             | `issueNumber`, `issueTitle`, `model`            |
| `issue_validation.pass`     | info   | ✓             | `score`, `issueNumber`, `warnings_count`        |
| `issue_validation.fail`     | warn   | ✓             | `score`, `issueNumber`, `blockers_count`        |

> `fail` is `warn` for a rejected issue (expected business outcome) and `error` for an unexpected exception.

### `code_gen`

| Event                  | Level  | `duration_ms` | Key `meta` fields                         |
|------------------------|--------|---------------|-------------------------------------------|
| `code_gen.start`       | info   | —             | `issueNumber`, `model`                    |
| `code_gen.llm_request` | info   | —             | `model`, `input_tokens_est`               |
| `code_gen.llm_response`| info   | —             | `output_tokens_est`                       |
| `code_gen.complete`    | info   | ✓             | `changes_count`                           |
| `code_gen.error`       | error  | ✓             | `error`                                   |

### `pr_open`

| Event              | Level  | `duration_ms` | Key `meta` fields              |
|--------------------|--------|---------------|--------------------------------|
| `pr_open.start`    | info   | —             | `changes_count`                |
| `pr_open.complete` | info   | ✓             | `paths`                        |
| `pr_open.error`    | error  | ✓             | `error`                        |

> Emitted by `generate_issue_change.mjs` when files are written to disk.
> The actual GitHub PR creation is performed by the `peter-evans/create-pull-request` action in the subsequent CI step.

### `review`

| Event              | Level  | `duration_ms` | Key `meta` fields                                        |
|--------------------|--------|---------------|----------------------------------------------------------|
| `review.start`     | info   | —             | `prNumber`, `model`                                      |
| `review.llm_request` | info | —             | `model`, `input_tokens_est`, `prNumber`                  |
| `review.llm_response`| info | —             | `output_tokens_est`, `prNumber`                          |
| `review.verdict`   | info   | ✓             | `verdict` (`"APPROVE"` \| `"REQUEST_CHANGES"`), `attempt`, `prNumber` |
| `review.error`     | error  | —             | `error`                                                  |

### `autofix`

| Event                          | Level  | `duration_ms` | Key `meta` fields                         |
|--------------------------------|--------|---------------|-------------------------------------------|
| `autofix.start`                | info   | —             | `attempt`, `prNumber`                     |
| `autofix.llm_request`          | info   | —             | `model`, `input_tokens_est`, `attempt`, `prNumber` |
| `autofix.llm_response`         | info   | —             | `output_tokens_est`, `attempt`, `prNumber`|
| `autofix.push`                 | info   | ✓             | `paths`, `attempt`, `prNumber`            |
| `autofix.max_attempts_reached` | warn   | —             | `attempt`, `prNumber`                     |
| `autofix.error`                | error  | ✓             | `error`, `attempt`, `prNumber`            |

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
| `partial` | Completed but with a non-fatal outcome (e.g. validation failed, review requested changes). |
| `failed`  | Terminated due to an error.                                     |
| `skipped` | Stage was intentionally bypassed (e.g. max attempts reached).   |

### Artifact

Each participating workflow uploads the trace file as a GitHub Actions artifact named
`run-trace-<GITHUB_RUN_ID>` using `if: always()`, so the file is preserved even on failures.

> **Note on cancellation**: `if: always()` does not cover job cancellation in all
> versions of `actions/upload-artifact`. If a job is cancelled mid-run the artifact
> may not be uploaded. This is a known GitHub Actions limitation.

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
