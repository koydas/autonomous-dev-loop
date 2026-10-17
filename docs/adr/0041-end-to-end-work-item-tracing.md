# ADR-0041: End-to-end tracing per work item

- **Date:** 2026-10-17
- **Status:** Accepted

## Context

ADR-0018 gave each run a trace file with flat stage spans; ADR-0040 added the run journal (every event), the run envelope and a redacted public record per run attempt on the `metrics` branch. A work item still has no trace: an issue goes through validate-issue → code-generation → pr-review (each cycle) → auto-fix (each attempt) → reset-auto-fix, each a separate workflow run with its own record and no link between them beyond issue/PR numbers in the envelope. Inside a run there is no parent/child structure below the stage: an LLM call, its retries and its provider fallback are unrelated events.

Constraints: no external service, no new secret, no prompt/output content (AGENTS.md observability rules), no context passed between workflows (they are triggered by GitHub events and dispatches, not by each other's outputs), observability never aborts business logic and never writes stdout.

## Decision

### 1. Trace identity: derived from the work item, never passed

`trace_id` = the first 128 bits (32 hex, W3C trace-context `trace-id`) of SHA-256 of the item key `<owner>/<repo>#issue-<n>`; a PR without an issue is `#pr-<n>`; a run with no item at all (scheduled evals, local runs) is its own trace, `#run-<run_id>`. An all-zero id (invalid in W3C) is replaced by `…01`. Every run computes it from its own payload, so no workflow needs another's output.

`resolveWorkItem()` (`scripts/lib/trace_context.mjs`, pure) takes hints — the payload first, then `trace.work_item` events — and the first match wins:

1. **issue event** — an `issues` payload whose issue is not a PR, or `workflow_dispatch` `inputs.issue_number` (code-generation);
2. **branch** — head ref `ai/issue-<n>` (`pull_request.head.ref`, push `ref`);
3. **closes** — the first issue the PR body closes;
4. **pr** — the PR number;
5. **run** — the run alone.

**Several issues in a PR body: the first closing reference in body order.** Appending a reference (the common edit) keeps the trace; "lowest number" would move it whenever a lower one is added. The branch outranks the body, so a pipeline PR (`ai/issue-<n>`) stays on its issue whatever its body says.

The PR body is untrusted: closing keywords (`close[sd]`, `fix(e[sd])`, `resolve[sd]`) followed by a same-repository `#<1–9 digits>` only (`owner/repo#n` and URLs do not count), in the first 64 KiB, at most 20 references, with a linear regex. It is parsed when the payload is read (`readPayload`), and only the numbers are kept.

Runs whose payload lacks the PR body or head ref log a `trace.work_item` event (numbers only: `prNumber`, `branchIssue`, `closingIssues`) from the PR they fetch: the push-triggered review (`pr_review.mjs`) and reset-auto-fix. The issue_comment auto-fix rerun reads the PR body from `issue.body`.

### 2. Span tree per run

- **Root span** `run`: one per trace file (`root_span_id`, 16 random hex). A later process of the same job (validation comment and label steps, "Commit metrics") adopts it with the trace (same rule as ADR-0040 §2: only a trace naming this run and attempt), and remaps the events it logged before attaching.
- **Stage spans**: `createTracer().startSpan/endSpan` (API unchanged) give each stage a `span_id` and `parent_span_id` = root; a restarted stage keeps its id.
- **Child spans**: `withSpan(name, attributes, fn)` (new export of `observability.mjs`) runs `fn` in an `AsyncLocalStorage` context; it ends `ok`, or `error` with `error.type` when `fn` throws (rethrown unchanged). `callLLM()` wraps every call in an `llm_call` span — its signature is unchanged, the body moved to an internal `callProviders()`. `runSuite()` wraps each case × repeat in an `eval.case` span (§7).
- **Events**: every journal event carries the `span_id` of its enclosing span — `withSpan()` context, else the innermost open stage, else the root. `AsyncLocalStorage` keeps concurrent eval workers apart.
- **Retries and fallback** are span events of the LLM call span: `retry.wait`, `llm_fallback`, `llm_fallback_disabled` and `llm_call` are logged inside it.
- **GitHub side effects** already journaled as events (ADR-0040 §1: comment, review, labels, attempt label, escalation, push, PR operation, reset) become child spans of their enclosing span when the record is built (`SIDE_EFFECT_EVENTS`, start = `ts − duration_ms`); every other event is a span event.

Child spans are kept in the trace file (`child_spans`), capped at 500 per trace like events; past the cap a span is counted in `spans_overflow`, still runs, and its events attach to the root. Trace file `schema_version: 2`.

### 3. LLM call attributes: OpenTelemetry GenAI names

`gen_ai.operation.name` (`chat`), `gen_ai.system` (the provider that answered; the primary when none did), `gen_ai.request.model`, `gen_ai.response.model` (model of the answering provider's config — the clients return text only, the API's echoed model is not parsed), `gen_ai.request.max_tokens`, `gen_ai.usage.input_tokens` / `output_tokens` (**estimates**, `estimateTokens`, flagged by `adl.usage.estimated: true`), `error.type`; project attributes `adl.stage`, `adl.llm.fallback`, `adl.llm.fallback_from`, `adl.llm.providers` (per-provider outcome), `adl.llm.input_budget_skipped`, `adl.llm.max_input_tokens`. Never a prompt, completion, file content, title or body. Real token usage would need the clients to return it (an exported return type change): follow-up.

### 4. Storage: OTLP-JSON-compatible record, trace index

Record `schema_version: 2` = v1 fields plus `trace_id`, `item`, `root_span_id`, `span_id` on spans and events, `spans_overflow`, and `otlp`: an OTLP/JSON `ExportTraceServiceRequest` body (`resourceSpans → scopeSpans → spans`, `{ key, value: AnyValue }` attributes, decimal-string nanosecond timestamps, hex ids, OTLP `SpanKind` / `Status` codes). `scripts/lib/otlp_trace.mjs` builds the tree (`buildSpanTree`, pure) and encodes it; `scripts/tests/otlp_trace.test.mjs` validates the output against a minimal OTLP JSON fixture, so a later export to any OTLP backend is a POST of `record.otlp`, no remodeling. `readRunRecord()` reads v1 and v2 (a v1 record's trace id is derived from its envelope; `otlp: null`). A v1 trace file still converts: span ids derived from run id + stage.

`metrics/traces/<trace_id>.json` lists the runs of a trace (`run_id`, record path, workflow, event, root span, start/end, outcome), sorted by start time, ≤ 500 (`runs_overflow`), with `lead_time_ms` (first start → last end). `commitRunRecord()` writes it **in the same commit** as the record, read raw from the same parent, same 3-attempt retry, same first-wins dedup on `run_id`. An index that cannot be parsed or names another trace is left untouched (warning), never rebuilt from one run. reset-auto-fix gains a "Commit metrics" step (record only, no `runs.jsonl` line; `contents: write` for the `metrics` branch) — its inline workflow script moves to `scripts/reset_auto_fix.mjs`, instrumented like the other stages.

### 5. Redaction

Span attributes go through `redactTrace()` like event meta (ADR-0040 §4): `SPAN_ATTRIBUTE_ALLOWLIST` per span name — `run`, `llm_call`, `eval.case`, each stage (its `SPAN_META_ALLOWLIST` keys as `adl.<snake_case>`), each side-effect span (its event's `EVENT_META_ALLOWLIST` keys). Span events keep their event's allowlist. Unknown attributes and every attribute of an unlisted span name are dropped; strings are scrubbed (env values, credential shapes) then cut to 200 characters; child-span attributes are also scrubbed by the journal in the producing process. The trace id and item key are recomputed from the redacted repository, kind and number, never copied from the file. Tests plant a secret, an env value and a prompt body in span attributes and prove none survive.

### 6. Clock and size

Spans from different runners are ordered by start time only; no duration is computed across runs except the item lead time of the index. The 500 events / 256 KiB journal caps and the 256 KiB record cap are unchanged; the OTLP block takes at most 128 KiB of it. Spans are added parents first; once one does not fit, it and every later span are counted in `spans_overflow.count` (so no kept span loses its parent), span events that do not fit in `spans_overflow.events`.

### 7. Eval runs

Cheap, so done: a scheduled or dispatched eval run resolves to its own `#run-<run_id>` trace; each case × repeat is an `eval.case` span (suite, case id, repeat) whose LLM calls are children. One span per case × repeat rather than case → repeat, because repeats of one case run in different workers. Eval traces stay artifacts (no "Commit metrics" step). A `pr-evals` run resolves to the PR's work item and joins its trace file-side; it commits no record either.

## Alternatives Considered

- **Pass a W3C `traceparent` between workflows** (dispatch inputs, PR body marker, labels) — rejected: needs context passing, breaks for events GitHub sends (push, labeled, comment), and a body marker is user-editable.
- **Random trace id per issue stored on the `metrics` branch** — rejected: every run would read the branch before its first event, a lookup that can fail or race.
- **Lowest-numbered closing issue** — rejected: adding a lower reference moves the trace; first-in-body is stable under appends.
- **OpenTelemetry SDK + exporter** — rejected again (ADR-0018 §A, ADR-0040): a dependency and a collector. The OTLP JSON shape keeps that door open at no cost.
- **LLM spans from the `llm_call` event alone** (`ts − duration_ms`) — rejected: retries and the fallback happen before that event and could not be placed inside the call without a live context.
- **Case → repeat → LLM call for evals** — rejected: repeats of a case run concurrently in different workers; a case span would have to outlive them.

## Consequences

- ✅ One trace per issue (or PR without an issue) across every workflow, with no new secret, service or workflow input; `git show origin/metrics:metrics/traces/<id>.json` lists its runs.
- ✅ Every LLM call is a span with its provider, models, fallback, budget cut and error class; its retries are inside it.
- ✅ `record.otlp` is an OTLP/JSON export body: any OTLP backend can ingest the history later.
- ✅ `log()`, `createTracer()` and `callLLM()` signatures unchanged; stdout untouched; tracing failures contained.
- ⚠️ Editing a PR body to close another issue moves later runs to that issue's trace; earlier records stay in the old one.
- ⚠️ Token counts are estimates (chars / 4), and `gen_ai.response.model` is the configured model of the provider that answered, not the API's echo.
- ⚠️ Cross-run durations other than lead time are not computed: runner clocks are not synchronized.
- ⚠️ Records grow (spans + span events duplicate the events list): bounded by the unchanged 256 KiB cap.
- ⚠️ Runs that exit before their tracer still leave no record (ADR-0040), so the index can miss them.
