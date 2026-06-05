# ADR-0018: Structured Observability — JSON Events to Stderr + Per-Run Trace Files

**Date:** 2026-06-04  
**Status:** Accepted

---

## Context

The pipeline (issue validation → code generation → PR open → PR review → auto-fix) runs across multiple GitHub Actions jobs and workflows. Until this ADR, operational visibility was limited to:

- `logger.mjs` info/error lines on stdout/stderr (unstructured JSON keyed by `msg`)
- Checkpoint JSON files (step-level state, not timing or outcome metadata)
- Metrics JSONL (aggregate per-run, not per-stage)

Diagnosing slowdowns, flaky LLM calls, or mid-pipeline failures required manually correlating step logs across jobs. There was no single artifact that told an operator "what happened, in which stage, with what timing."

Two requirements shaped the design:

1. **Per-event streaming** — operators need to see events as they happen, not only in aggregate. Stderr is the natural channel because it bypasses stdout buffering in most CI environments and does not interfere with GitHub Actions output protocol (`::set-output`/`GITHUB_OUTPUT` on stdout).

2. **Portable run summary** — a single JSON file per run that survives job boundaries and can be downloaded and inspected offline without reconstructing log order from timestamps.

---

## Decision

### 1. Shared instrumentation module: `scripts/lib/observability.mjs`

All instrumentation is routed through one module. Business logic files must not construct JSON log lines inline.

**`log({ stage, event, level, duration_ms, meta })`**

- Writes one JSON line to `process.stderr`.
- Schema: `{ ts, run_id, stage, event, level, duration_ms, meta }`.
- `run_id` = `GITHUB_RUN_ID` env var, or `"local"` when running outside CI.
- When `level === "error"` and `GITHUB_ACTIONS === "true"`, also writes a `::error file=...,line=...::` annotation.
- Never throws — catches all serialization and I/O errors silently.

**`createTracer({ runId, issueNumber, traceDir })`**

Returns `{ startSpan, endSpan, finalize }`.

- `startSpan(stage, meta)` — opens a span; writes the trace file immediately so it is always readable mid-run.
- `endSpan(stage, { outcome, meta })` — closes a span; records `duration_ms` and `completed_at`.
- `finalize(outcome)` — writes `completed_at` and top-level `outcome` to the trace root. Returns a Promise.

All three methods catch their own I/O errors and emit a `warn`-level log line on failure instead of throwing, so an observability failure never aborts pipeline work.

### 2. Trace file location

`observability/traces/<GITHUB_RUN_ID>.json`

Written in the Actions runner working directory. The `observability/traces/` directory is git-tracked (`.gitignore` ignores `*.json`), so the directory is present on every checkout without requiring a `mkdir` step.

### 3. Required events per stage

| Stage | Events |
|---|---|
| `issue_validation` | `start`, `pass`, `fail` |
| `code_gen` | `start`, `llm_request`, `llm_response`, `complete`, `error` |
| `pr_prepare` | `start`, `complete`, `error` |
| `review` | `start`, `llm_request`, `llm_response`, `verdict`, `error` |
| `autofix` | `start`, `llm_request`, `llm_response`, `push`, `max_attempts_reached`, `error` |

`duration_ms` is mandatory on `*.complete`, `*.pass`, `*.fail`, `*.verdict` events.

### 4. Trace artifact upload

Each participating workflow adds:

```yaml
- name: Upload run trace
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: run-trace-${{ github.run_id }}
    path: ./observability/traces/${{ github.run_id }}.json
    if-no-files-found: ignore
```

`if: always()` ensures the artifact is uploaded even on failure. Job cancellation is a known edge case where the upload may not complete — this is documented in `docs/observability.md`.

---

## Considered Alternatives

### A. OpenTelemetry / OTLP

Would provide industry-standard spans and integrate with Datadog, Grafana, Jaeger, etc. Rejected: requires an OTLP collector endpoint (out of scope for this repo), adds a production dependency, and is significantly heavier than needed for a single-repository pipeline. Not ruled out as a future migration path.

### B. Extend `logger.mjs` in place

The existing logger writes to stdout with a `msg` key. Extending it to handle trace files would conflate two concerns (debugging logs vs. operational traces) and pollute stdout, which GitHub Actions uses for `GITHUB_OUTPUT` writes. A separate module keeps the contracts clean.

### C. Write traces to stdout only

Rejected: stdout is reserved for `GITHUB_OUTPUT` protocol lines. Mixing JSON trace lines with output protocol lines would break `GITHUB_OUTPUT` parsing.

### D. Aggregate trace in a post-run step

Rejected: trace data would be lost if the job is killed or cancelled before the post-run step executes. The incremental write approach (`startSpan` writes immediately) ensures partial data is recoverable.

---

## Consequences

**Good:**
- Every pipeline run produces a machine-readable trace artifact (`run-trace-<id>`) downloadable from the Actions UI.
- Error-level events surface as GitHub Actions annotations in the PR checks UI.
- Trace files are incrementally valid — a killed job leaves a trace with complete data for all finished spans.
- Zero new production dependencies (uses only `node:fs`, `node:path`, `node:process`).
- Observability failures are non-fatal to business logic (error containment).

**Neutral:**
- Each workflow job writes its own trace file (one stage per file). There is no cross-job trace aggregation; operators download individual artifacts to reconstruct the full run. This is acceptable for MVP scale.

**Negative:**
- Job cancellation may prevent the upload-artifact step from running, leaving no trace artifact for that run. Documented in `docs/observability.md` as a known limitation.
- `observability/traces/*.json` files accumulate locally during test runs and must be excluded via `.gitignore`.
