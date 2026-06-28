# observability-contract

## When to Apply

When adding a new pipeline stage script, modifying an existing stage script in `scripts/`, or adding a new GitHub Actions workflow that runs an instrumented script.

## Expected Behavior

### All pipeline event logging must go through `scripts/lib/observability.mjs`

Never construct JSON log lines inline in business logic. Import and use the two exported APIs:

```js
import { log, createTracer } from './lib/observability.mjs';
```

**`log({ stage, event, level, duration_ms, meta })`**
- Writes one JSON line to `process.stderr`.
- Schema: `{ ts, run_id, stage, event, level, duration_ms, meta }`.
- When `level === "error"`, also emits a `::error::` GitHub Actions annotation.
- Never throws — do not wrap calls in try/catch.

**`createTracer({ runId, issueNumber, traceDir })`** — returns `{ startSpan, endSpan, finalize }`.
- Call `startSpan(stage, meta)` at stage entry; it writes the trace file immediately.
- Call `endSpan(stage, { outcome, meta })` at stage exit; records `duration_ms`.
- Call `finalize(outcome)` at script exit.

### Minimum required events per stage

Every new pipeline stage script must emit at minimum:
- A `<stage>.start` event at entry
- A `<stage>.complete` or `<stage>.error` event at exit, with `duration_ms` populated

Full event requirements per existing stage (for reference):

| Stage | Required events |
|---|---|
| `issue_validation` | `start`, `pass`, `fail` |
| `code_gen` | `start`, `llm_request`, `llm_response`, `complete`, `error` |
| `pr_prepare` | `start`, `complete`, `error` |
| `review` | `start`, `llm_request`, `llm_response`, `verdict`, `error` |
| `autofix` | `start`, `llm_request`, `llm_response`, `push`, `max_attempts_reached`, `error` |

`duration_ms` is mandatory on all terminal events (`*.complete`, `*.pass`, `*.fail`, `*.verdict`).

### New workflows must include these two steps

```yaml
- name: Run <stage> script
  env:
    GITHUB_RUN_ID: ${{ github.run_id }}
    # ... other env vars

- name: Upload run trace
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: run-trace-${{ github.run_id }}
    path: ./observability/traces/${{ github.run_id }}.json
    if-no-files-found: ignore
    overwrite: true
```

`if: always()` is required so the trace is uploaded even on failure. `GITHUB_RUN_ID` must be passed as an env var to the script step.

### Trace file location

`observability/traces/<GITHUB_RUN_ID>.json` — directory is git-tracked; `*.json` files are git-ignored. Do not commit trace files.

## Constraints

- Observability failures must never abort business logic. `log()` and tracer methods already catch their own errors — do not add extra try/catch around them.
- Never write to stdout for observability events — stdout is reserved for `GITHUB_OUTPUT` protocol lines and GitHub Actions output-parsing.
- Do not commit `.json` files from `observability/traces/`.

## References

- `scripts/lib/observability.mjs` — the shared instrumentation module
- `docs/observability.md` — full schema reference and event tables
- `docs/adr/0018-structured-observability.md` — design rationale
- `AGENTS.md` — "Observability Rules" section
- Any existing workflow (e.g., `.github/workflows/code-generation.yml`) — shows the `GITHUB_RUN_ID` env + `upload-artifact` pattern
