# Operator Runbook — Failure Triage

## Reading the dashboard

The site follows **Overview → Diagnostics → Pipelines → Investigation** (ADR-0043); **Metrics** keeps the detailed tables.

Layout (design mockup in the README): top tabs, a left sidebar with the sections and — on Overview and Pipelines — filters by status, stage reached and LLM provider (they filter the pipeline lists, not the indicators), a bottom tab bar on phones. The system's theme by default (dark without a preference); **Light** / **Dark** in the header switches and is remembered per browser. The phone tab bar ends with **Tools**, the ai-dev-tools dashboard. "Updated …" is the build time.

- **Overview** (home page, one phone screen — ADR-0043 amendment 2026-10-24):
  - a status line from the diagnostic rules (critical / issues / "no problem detected", which is never proof of health) naming the most severe active problem and opening its Diagnostics card;
  - four rows over the last 7 days, each opening its page, each chip a filtered view: **Flows** (runs by class in the bar; approval rate; work items needing a person / changes requested / approved / merged → Pipelines filtered by that state over the same 7 days, so a chip's count is the number of rows it opens), **Cost** (list price, per stage → Metrics → cost), **Quality** (eval gates passing, one chip per suite with its headline score and trend → that suite on Evals), **Waiting on you** (count and the three oldest items → Pipelines → Waiting on you);
  - a change appears only when the previous 7 days hold at least 10 runs (or verdicts); amounts have 2 decimals here, 4 on the detail pages;
  - the 7 / 14 / 30-day indicators, charts and metric definitions are at the top of **Metrics** ("Trends, 14 / 30 days and definitions →").
- **Diagnostics** — severity chips (All / Critical / Warning / Info with counts) and a category filter over problems found by fixed rules (`RULES` in `scripts/lib/pipeline_diagnostics.mjs`, no LLM): each card gives what was **observed**, its impact and frequency, an optional **hypothesis** marked "interpretation, not verified", the evidence (runs, events, GitHub links) and an **Investigate** link. An active `warning` / `critical` finding of a mapped rule also shows a **Suggested lever** (where to look, never a diagnosis); every rule and its lever, or the reason it has none, is on **Rules and levers** (`pipeline/levers.html`). How to read the severities, the lifecycle and the rules that need care: [Diagnostics in detail](#diagnostics-in-detail).
- **Pipelines**:
  - status chips with counts, then one row per recorded work item: title (the PR title is fetched live), last recorded state, stage icons, duration (lead time), attempts (runs), cost and last update;
  - the stage icons are: the **final** attempt's execution status (✓ success, ✗ failed, ⊘ skipped, ○ not recorded — never a failure), ×N when the step ran several times, an amber ring when the step completed but decided not to move the item forward (WITHHELD, REQUEST_CHANGES, blocked, no change). The icon's label names earlier failed or adverse attempts. Below: the last recorded state (approved, approval withheld, escalated, failed, rejected, …);
  - open a row for its detail: one box per stage (total duration, final decision, executions, cost, the attempts in order with status, decision, run outcome, duration and a link to the run) and the key information (issue, PR, workflows, start, lead time, executions, cost, last recorded state, merge);
  - filters (search, state — including live merged / open / closed —, step with problems, kind, provider, period) are kept in the URL, so a link from the Overview opens the page pre-filtered.
- **Investigation** — the execution list (search, result filter) and the technical journal (every action, month pages). A **run page** starts with what each step executed and decided, then the key events (decisions, warnings, errors, side effects, with their GitHub links); the full event journal (with meta) is behind **All events**. A **trace page** (pipeline detail) has tabs: Overview (journey per step, interventions, key information), Timeline (flow history), LLM calls (cost per stage and run), Events (key events of each run, linked to the run journal), GitHub Actions (every run with its workflow-run link) and Traces (waterfall); the open tab is kept in the URL hash. Without JavaScript every section shows.
- **Metrics** (`pipeline/health.html`) — funnel, review decisions, auto-fix outcomes, providers, latency and critical path, token usage, operational LLM cost per stage, workflow, day, run and work item, and the eval LLM cost (per suite, from the scorecard) in its own panel. **Models** cross-links provider:model usage with eval runs.
- **Evaluations** presents the latest suite results as cards. Expand a suite for all metrics, thresholds, trends and history. Open a run to filter its cases and inspect parsed and raw model outputs; its results JSON remains unchanged. Case attention flags (error or score below 1) are separate from suite gates and do not change excluded-case policy.
- **LLM cost** is shown per flow, step, execution and call (Pipelines), per call on each run page, per stage and run on each trace page, and for the window on Metrics. Amounts are list prices on provider-measured tokens (thinking and prompt cache included) for records written since the ADR-0041 amendment, chars/4 estimates for older ones — each amount says which; Groq calls are $0 (free tier), unknown models are counted as unpriced. An unexpected jump: open the run from Metrics → Most expensive runs and compare its input / cache reads / output per call.

Triage path: **symptom** (Overview indicator or Diagnostics card) → **step** (Pipelines card, problem steps) → **event** (run page key events) → **observable cause** (event meta, full journal) → **GitHub source** (comment, PR, workflow run links). On small screens ordinary tables become labelled rows; timing waterfalls and confusion matrices keep their axes and scroll within their panels.

The site remains a static build using the existing `build_eval_site.mjs` command and Pages workflows. No new service or credential is required. Recorded information uses the existing retention window; the generation timestamp and retention notes are available in the overview's “About these results & retention” panel. Publishing still preserves `scorecard.json` and retained `runs/*.json` as its history store.

### Diagnostics in detail

**Guardrail vs anomaly** (ADR-0043 amendment). A guardrail doing its job is `info`, still with the full volume (verdicts, distinct PR heads, PRs, responding provider, input budget); only an anomaly counts against `withheldShare` / `autofixNoPushShare`, and above them the card is a `warning`.

| Situation | Reading |
|---|---|
| A WITHHELD verdict on a code cut (ADR-0038) | Guardrail, `info` |
| A WITHHELD verdict on missing CI evidence (ADR-0026) | Guardrail, `info` |
| An auto-fix attempt stopped by a protected / unshown / withheld target, or by files the budget withheld from the prompt | Guardrail, `info`. A `no_changes` attempt counts as blocked by design when the budget hid files: the records do not name the files it needed |
| A code-generation run whose patch was rejected only on protected / unshown / withheld targets (`code_gen.skipped`, `reason: guardrail_rejected`, every rule in the design set), or blocked by the deterministic check (`reason: blocked`, `source: denylist`) | Guardrail, `info` (`codegen-blocked`, "Code generation blocked by design"). A `reason: blocked` run with `source: model` or `notes_only` is an anomaly: the records cannot tell a guardrail from a defect there |
| REQUEST_CHANGES withheld on unseen code; a WITHHELD verdict of unknown cause; a fallback that answered a prompt already cut to the primary's budget; any other auto-fix attempt without a push; any generation run that produced no patch for another reason | Anomaly: counts against the share, `warning` above it |
| A run stopped on an approved head or at the attempt limit | Not an attempt (it exits before `autofix.start`): not counted |

The lever for an `info` withheld card is the provider or its input budget (`review_max_input_tokens`, `AI_PROVIDER=anthropic`), not the review rule.

**Active vs resolved.** Every finding computes `first_seen` / `last_seen`. It is `active` while the pattern occurs in the last `RULES.activeWindow` (10) runs its rule could have fired on (reviews for the review rules, auto-fix attempts for auto-fix, …; fewer runs than that: all of them), otherwise `resolved`: `info`, titled "… — resolved since <date of the first clean run>", with the historical numbers kept in the observed fact and evidence. It turns active again at its next occurrence. The Overview "Issues requiring attention" lists active `warning` / `critical` findings only.

**Rules with a reading of their own**

| Finding | When it is raised, and how severe |
|---|---|
| **Review diffs are cut** (`review-coverage`) | Cut + WITHHELD is the ADR-0038 guardrail (`info`), and so is a cut of tests / docs only (`unreviewed_code_files: 0`) whatever the verdict; cut code + APPROVE (or an APPROVE whose record has no count) cannot happen since ADR-0038 and is `critical`; any other verdict on cut code is a `warning` |
| **Same PR head reviewed more than once** (`review-duplicates`) | A second run after a WITHHELD verdict (never deduplicated) or a manual re-run is by design (ADR-0028, `info`). Two runs on one head where the marker skipped neither is the push / pull_request race (`warning`) |
| **Escalations the design does not explain** (`escalations`, `warning`) | Only for an *open* item escalated for a reason the guardrails do not explain: `no_changes` although a file was shown that is not protected (the repository's `config/protected-paths.yaml` ∪ the hard floor, read at build time); a patch rejected for its content (a write-guard rule other than `protected_path` / `unshown_file` / `withheld_file`); an error of the stage before the escalation; or a reason (or prompt budget) the record does not give. A protected or withheld target, a blocked generation and the attempt limit are queue rows (**Waiting on you**), not findings |

**Data gaps** lists what the records cannot tell (merge and closing before `item-closed.yml`, running state, missing records, estimated tokens, too few runs for a trend): a gap is not an absence of problem.

## Metrics System

Pipeline performance is recorded to `metrics/runs.jsonl` (append-only JSONL, one record per completed run). Each record is committed to the `metrics` branch (not the default branch: `main` only takes changes through a pull request) by the "Commit metrics" step (`scripts/commit_run_record.mjs`, ADR-0013 amendments), in one commit with the run's redacted record `metrics/runs/<YYYY-MM>/<run_id>.json` (ADR-0040). Scripts write the run's records to `$RUNNER_TEMP/pipeline-metrics.jsonl` (`METRICS_FILE`), outside the checkout, and "Commit metrics" appends only those lines, so a `metrics/runs.jsonl` in the checked-out branch is never uploaded (ADR-0021).

**Record types:**

| `type` | Written by | When |
|--------|-----------|------|
| `issue` | `validate-issue.yml` | After every issue validation (APPROVE or MANUAL) |
| `pr` | `pr-review.yml` | When PR verdict is APPROVE |
| `pr` | `auto-fix-pr.yml` | When auto-fix attempt limit is exhausted (verdict MANUAL) |
| `autofix_skip` / `codegen_skip` | `auto-fix-pr.yml` / `code-generation.yml` | A patch rejected by the output guardrails (`reason: guardrail_rejected`, `rules`) or a blocked generation; `rules` feeds the active lessons (ADR-0051) |
| `review_signal` | `pr-review.yml` | A REQUEST_CHANGES whose High / Medium findings carry an `Axis:` tag: `pr_number`, `verdict`, `axes` (closed ids, ADR-0049), `ts`. Read by the active lessons (ADR-0051); no model text |

**Key fields — issue records:** `run_id` (`{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}`; `local-<timestamp>` for local runs), `issue_number`, `verdict` (APPROVE/MANUAL), `score`, `started_at`, `ended_at`, `duration_ms`, `input_tokens_est`, `output_tokens_est`.

**Key fields — PR records:** `run_id` (`{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}`; `local-<timestamp>` for local runs), `pr_number`, `issue_number`, `final_verdict`, `review_cycles`, `request_changes_count`, `auto_fix_pushes`, `started_at`, `ended_at`, `total_input_tokens_est`, `total_output_tokens_est`, and `external_review` (`{rounds, threads, p0p1}`: the Codex review's distinct reviewed commits, root inline threads and P0/P1 ones on the PR when the approving run read GitHub, ADR-0040 public data only; a lower bound because the bot answers a head after the run; absent when GitHub could not be read, never 0). `review_cycles` counts the internal review only: read both to see the back-and-forth.

> **`run_id` field:** Composite of `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` (e.g. `12345678-1`), unique per workflow execution *and* per operator re-run. `deduplicateMetrics` in `metrics-report.mjs` uses it to drop records written more than once within the exact same attempt (belt-and-suspenders guard). It does **not** deduplicate records from two *different* concurrent runs — those have distinct `GITHUB_RUN_ID` values. Cross-run duplicates remain possible and should be removed manually from `metrics/runs.jsonl` if they occur (see troubleshooting table below). Records without `run_id` are always included (backward-compatible).

**Run records (ADR-0040):** one JSON file per run attempt under `metrics/runs/<YYYY-MM>/`: run envelope (workflow, trigger, actor type, issue/PR, head SHA, provider and model per LLM call, GitHub links), spans and every event of the run after the redaction allowlist (`docs/observability.md` → Public Run Record). Read one with `git show origin/metrics:metrics/runs/2026-10/<run_id>.json | jq '.events[] | {event, meta}'`. Retention: ≈ 2–6 MB/month; remove month directories older than 12 months by hand on the `metrics` branch.

**Generate a markdown summary report:**
```bash
git fetch origin metrics
git show origin/metrics:metrics/runs.jsonl > /tmp/runs.jsonl
METRICS_FILE=/tmp/runs.jsonl node scripts/metrics-report.mjs
```
`metrics/runs.jsonl` on `main` is not the store and stays empty.

**Re-redact the stored records (one-shot, ADR-0040 amendment 2026-10-20):** records published before the amendment can hold a provider error body (`llm_fallback.error`, `retry.wait.error`, stage `error`: a Groq organization id and service tier, audit F01) or the model's `blocked_reason` (`code_gen.skipped.detail`, F06). `scripts/redact_metrics_records.mjs` re-applies the current allowlists and sanitizer to every `metrics/runs/**/*.json` and `metrics/runs.jsonl` line of a local checkout. It never runs git or the network and never prints the redacted content. From an up-to-date `main` checkout:

```bash
TMP=$(mktemp -d)
git fetch origin metrics
git worktree add -b redact-metrics "$TMP/metrics" origin/metrics           # the metrics branch in a temp dir
node scripts/redact_metrics_records.mjs "$TMP/metrics"                       # dry run: files to rewrite, redacted-string counts, skipped files
node scripts/redact_metrics_records.mjs "$TMP/metrics" --write               # rewrite in place
git -C "$TMP/metrics" grep -n 'org_[a-z0-9]' -- metrics/ || echo "no organization id left"
git -C "$TMP/metrics" commit -am "chore(metrics): re-redact run records (ADR-0040 amendment)"
git -C "$TMP/metrics" push origin HEAD:metrics                               # fast-forward only, never --force
git worktree remove "$TMP/metrics" && git branch -D redact-metrics
```

- A rejected push means a run committed to `metrics` meanwhile: remove the worktree and branch, and start over from `git fetch` (the script is idempotent).
- Skipped files (invalid JSON, not a record, a symlink or a file reached through a symlinked directory) are listed and left untouched; nothing outside the checkout is read or written. Fix them by hand if needed.
- Only the tip is cleaned: the branch history keeps the old blobs, so the organization id stays reachable in earlier commits (and in old job logs). Rewriting `metrics` history is not part of this procedure.
- Nothing to rotate: an organization id is an account identifier, not a credential.
- Idempotent: a second dry run reports `0 to rewrite`.

**Metrics troubleshooting:**

| Symptom | Probable Cause |
|---------|----------------|
| `metrics/runs.jsonl` not updating after runs | Read it on the `metrics` branch, not on `main`. Otherwise: the `metrics` branch is missing (`Failed to commit metrics … (branch metrics not found)`; create it from `main` in the UI) or covered by a ruleset (`ref update failed (422)` three times); workflow `contents: write` permission missing; or a Git Data API call failed — the warning names the step that failed (`tree create`, `commit create`, `ref update`, a read) |
| `commit_run_record.mjs is not on the default branch yet` warning | `pr-review` / `auto-fix-pr` run the default-branch copy of the script (ADR-0023); a PR that adds or renames it runs before `main` has it. Nothing is committed for that run; it stops once the PR is merged. |
| No run record for a run | The run exited before its tracer (untrusted auto-fix comment, review with no open PR) or its trace was unreadable (`unreadable trace … ; committing metrics only` warning). A record already stored for that `run_id` + attempt is never rewritten (`record already stored`). |
| A value shows `[redacted]` in a run record | Over-redaction by design (ADR-0040): it equals a non-public env value of 12+ characters or a credential shape. Public run metadata is listed in `PUBLIC_ENV` (`scripts/lib/run_record.mjs`). An event whose meta is `{}` has no allowlist entry yet: add its keys to `EVENT_META_ALLOWLIST`. |
| A PR or issue shows twice on Pipelines (one row with its review runs, one with its closing) and its trace key reads `[redacted]#pr-N` | Records written before `ADL_PIPELINE_REPOSITORY` joined `PUBLIC_ENV`: the reusable workflows' `pipeline_repository` input was scrubbed, so the repository — and with it the trace key and id — was `[redacted]` and never matched the item's `item.closed` run. Fixed for new records; the older ones keep their split trace until they leave the retained window. |
| Cost/token totals seem too low | PR records use `total_input_tokens_est` / `total_output_tokens_est`; verify the report script is picking up both field names |
| MANUAL verdict recorded but PR was actually approved | Auto-fix exhaustion ran in the same session as a later manual approval — the MANUAL record is correct for that snapshot; future APPROVE records will appear separately |
| `metrics/runs.jsonl` has duplicate lines | Two concurrent workflow runs both succeeded in pushing. Because each run has a distinct `GITHUB_RUN_ID`, the in-process deduplication in `metrics-report.mjs` does not catch cross-run duplicates — safe to remove manually: identify lines with identical content (same `type`, `issue_number`/`pr_number`, `verdict`/`final_verdict`) and delete the extras directly in the file. |

---

## Run Trace Artifacts

Every pipeline run uploads a `run-trace-<GITHUB_RUN_ID>` artifact (JSON) via `if: always()`. Download it from **Actions → \<Run\> → Artifacts** to inspect stage-level timing and outcomes without reading raw log lines.

```bash
# After unzipping the artifact:
# Overall outcome and timing
cat <run_id>.json | jq '{run_id, outcome, started_at, completed_at}'

# All spans with outcome + duration
cat <run_id>.json | jq '[.spans[] | {stage, outcome, duration_ms}]'

# Only failed spans
cat <run_id>.json | jq '[.spans[] | select(.outcome == "failed")]'
```

**Trace field quick reference:**

| Field | Description |
|-------|-------------|
| `outcome` | `success` — all work done; `partial` — non-fatal outcome (e.g. issue rejected, review requested changes); `failed` — terminated by error; `skipped` — stage bypassed (e.g. max attempts) |
| `duration_ms` | Wall-clock time for the span; `null` if the stage was killed before `endSpan` ran |
| `meta` | Stage-specific fields — e.g. `score`, `verdict`, `attempt`, `paths`, `changes_count` |

**Trace troubleshooting:**

| Symptom | Probable Cause |
|---------|----------------|
| No trace artifact for a run | Job was cancelled before the `Upload run trace` step ran (known GitHub Actions limitation with `if: always()` + cancellation) |
| Trace file exists but `completed_at` is null | Script was killed after `startSpan` but before `finalize()` — the spans present are still valid |
| Trace `outcome: "partial"` for a review run | Expected: verdict was `REQUEST_CHANGES`; auto-fix loop continues |
| `duration_ms: null` on a span | `endSpan` was never called for that stage — check the step log for an uncaught exception before the terminal event |

### An item shows as "Waiting on you" but was merged or closed (ADR-0043 amendment)

The dashboard moves an item out of the queue only on an `item.closed` event, written by `item-closed.yml` (`issues: closed`, `pull_request: closed`) as a run record on the `metrics` branch (`merged` for a pull request, `state_reason` for an issue; nothing else is published). Check in this order:

1. **Closed before the workflow existed** — there is no event and none is inferred (Diagnostics → data gaps, "Closings before the closing journal are not recorded"). The row stays; it is a telemetry gap, not a pipeline fault. No backfill: closing the item again does not help (reopen + close writes an event, which is the only way).
2. **Closed after** — look for the **Item Closed** run of that issue or PR in the Actions tab. No run: the workflow file is not on the default branch yet. Run failed or its *Commit metrics* step warned: a pull request from a fork has a read-only token, or the `metrics` commit lost 3 attempts (same retry as the other runs, ADR-0013); the closing is lost, nothing retries it.
3. **Reopened and run again** — a step that starts after the closing reactivates the item (it is live again); a PR closed unmerged while a newer PR of the same issue exists does not close the issue.

The Pipelines page still lays GitHub's live PR state over each row, so a merged PR shows as merged there either way. `item-closed.yml` belongs to this repository: a target repository (ADR-0045) has no closing journal until a reusable version exists.

### Find the trace of an issue (ADR-0041)

Every run touching a work item (issue, or PR without an issue) writes its record into one trace on the `metrics` branch: validate-issue, code-generation, every pr-review cycle, every auto-fix attempt, reset-auto-fix, and the closing of the item (`item-closed.yml`, this repository only).

```bash
git fetch origin metrics
TRACE=$(node -e "import('./scripts/lib/trace_context.mjs').then(m => console.log(m.traceIdFor('<owner>/<repo>#issue-<n>')))")
# a PR that closes no issue and is not on ai/issue-<n>: '<owner>/<repo>#pr-<n>'
git show "origin/metrics:metrics/traces/$TRACE.json" | jq '{lead_time_ms, runs: [.runs[] | {run_id, workflow, outcome, started_at, record_path}]}'
# then one run's span tree:
git show "origin/metrics:<record_path>" | jq '.otlp.resourceSpans[0].scopeSpans[0].spans[] | {name, parentSpanId, status: .status.code}'
```

| Symptom | Probable Cause |
|---------|----------------|
| A PR's runs are in `#pr-<n>`, not the issue's trace | Its branch is not `ai/issue-<n>` and its body closes no issue (`Closes #<n>`): add the keyword — later runs join the issue trace |
| A run is missing from the index | It wrote no record (exit before its tracer: untrusted comment, no open PR), or "Commit metrics" warned (`Failed to commit metrics`); the record path is still `metrics/runs/<YYYY-MM>/<run>-<attempt>.json` |
| `::warning::commit_run_record: the trace index is unreadable` | `metrics/traces/<id>.json` was edited by hand into invalid JSON: fix or delete it on `metrics`; the next run recreates it (earlier runs are re-listed only by hand) |
| `spans_overflow.count > 0` in a record | Over 500 child spans in the run or the 128 KiB OTLP budget: the spans kept are the parents first; the event journal still has every event up to its own cap |

---

## Symptom → Probable Cause Mapping

| Symptom | Probable Cause |
|---------|----------------|
| The `Check coverage gates` step of `test.yml` fails | The log names the module (`::error::coverage gate failed: <module>`) and the command that reproduces it: `node scripts/coverage_gates.mjs --only <module>`. Every gate runs, so several can fail at once. A module is gated by `config/coverage-gates.json` (not by a step of `test.yml`); after adding one, `node scripts/coverage_gates.mjs --sync` refreshes the list in the review prompt, and `workflow_gates.test.mjs` fails until it is done |
| `changelog-check` fails on a PR | PR modifies an entrypoint (`scripts/*.mjs`) or ADR (`docs/adr/NNNN-*.md`) without adding a line under `## [Unreleased]` in `CHANGELOG.md` — add the entry and push |
| `changelog-check` fails with "Failed to get changed files" | Checkout step is missing `fetch-depth: 0`; ensure `changelog-check.yml` has `fetch-depth: 0` on the `actions/checkout` step |
| Pipeline views (`pipeline/` on the dashboard) do not show the latest run | The run exited before its tracer (no record, ADR-0040), or `pipeline-site.yml` is still queued behind a deploy (`pages-site-<repo>` group). Check that the record is on the `metrics` branch, then **Actions → Pipeline site → Run workflow** |
| `pipeline-site` or the `evals` publish job fails on "No metrics/ directory" or the `metrics` checkout | The `metrics` branch is missing (fresh fork or setup): "Commit metrics" never creates it (`branch metrics not found`). Create it once (`git push origin HEAD:refs/heads/metrics`); until then neither the eval publish nor `pipeline-site` deploys |
| A Diagnostics card has a "Suggested lever" block, or none | The block names where to look (a `config/models.yaml` key, a repository variable, a prompt) for an **active** `warning` / `critical` finding of a mapped rule; each target says "run the live evals.yml (suite …)" (ADR-0031: run it on the branch) or "no eval suite measures it: verify by hand and say so in the PR", and every change needs docs and tests in the same PR. It is not a diagnosis: read the observed fact above it. No block: the finding is resolved, `info` (a guardrail working), unmapped or has no lever (`NO_LEVER` in `scripts/lib/meta_levers.mjs`, with the reason), or the window is too thin for the rule to have fired. Every rule and its lever, or the reason it has none: the **Rules and levers** page (`pipeline/levers.html`), linked from the block and from the navigation |
| `findings.json` is missing from the site, or its `generated_at` is old (the Diagnostics page shows the build time next to its link to the file) | Missing: the build had no pipeline records (an eval-only build publishes none) or `pipeline-site.yml` failed. Old: the site rebuilds when a record lands, not on a schedule; a quiet week leaves an old `generated_at`. Neither means "no finding": read `status` and `gaps` (`docs/observability.md`) |
| A run page says "Schema 1 record … flat" | Record written before ADR-0041: no span tree; its events are complete |
| `validate-issue` never starts after issue open/edit | Missing `issues: write` permission on `GITHUB_TOKEN`; workflow file syntax error; branch protection blocking Actions |
| Issue stays unlabelled after validation run | LLM API key missing or invalid; `manage_labels.mjs` failed to create labels (check for 403/404 in logs) |
| `ready-for-dev` applied but `code-generation` never triggers | Workflow trigger mismatch (label name drift vs `config/labels.yaml`); `AI_PR_TOKEN` / `GITHUB_TOKEN` lacks `contents: write` |
| Generation run completes but no PR is created | Empty LLM output (no valid JSON patch); the patch was rejected by a guardrail (`rejected=true`; see the "Code Generation: Patch Rejected" row); the issue was blocked (`blocked=true`; see the "Code Generation: Blocked" row); `AI_PR_TOKEN` scope too narrow; **Allow GitHub Actions to create pull requests** disabled |
| PR opens but files are wrong or empty | A template, JSON or guardrail problem; both stages escalate instead of failing (ADR-0019). A documentation-only issue always ends here: edit `README.md`/`docs/` by hand. Details: [PR opens but files are wrong or empty](#pr-opens-but-files-are-wrong-or-empty) |
| Generation or auto-fix crashes at startup with `config/protected-paths.yaml: protected_paths[<i>] …` (or `unknown key`, `missing required key`) | Invalid per-repository protected-path list (ADR-0044), parsed at import of `output_writer.mjs`. The message names the field: fix the entry (relative path, `dir/`, exact `a/b.json` or a file name with at most one quoted `*`), or restore the file from the default branch. A missing file is not an error (floor only). Fix it on the default branch: that is where the pipeline reads it (ADR-0023). |
| Issue loses `ready-for-dev`, gets `needs-human` and a "Code Generation: Blocked" comment, no PR | Generation could not implement the issue (ADR-0029 amendment; `code_gen.skipped` with `reason: "blocked"`, `codegen_skip` metric, `blocked=true`); the comment names the source (`denylist`, `model`, `notes_only`). Details: [Code Generation: Blocked comment](#code-generation-blocked-comment) |
| Issue gets `needs-human` and a "Code Generation: Patch Rejected" comment, no PR | The generated patch broke a guardrail (ADR-0019); the comment lists `rules` and the reason per file. Details: [Code Generation: Patch Rejected comment](#code-generation-patch-rejected-comment) |
| `pr-review` never posts a comment | No open PR found for the push branch (exits silently by design); LLM API error; `pull-requests: write` permission missing |
| `pr-review` run succeeds in seconds without a new comment or review (log: `Skipping review`, event `review.skipped`) | Expected (ADR-0028): `already_reviewed` — the newest trusted review comment's `<!-- adl-review sha=… -->` marker already names the PR head with `APPROVE`/`REQUEST_CHANGES` (the `push` and `pull_request: opened` runs of a new PR; `WITHHELD` never dedups; comments by non-members are ignored); `superseded` — the PR head moved past the run's commit, and the newer push's run reviews it. Use **Re-run jobs** to force a review of the same head |
| An LLM step is slow, log shows `retry` with `waitMs: 60000` and Groq 429 or 413 `rate_limit_exceeded` | Expected (ADR-0028 amendment): the 8K TPM is shared by every PR and stage of the org, so a run queues behind the others. A 429, or a 413 whose body has `"code":"rate_limit_exceeded"`, is retried; without a `try again in Xs` / `Retry-After` hint it waits one full TPM window (60 s). Each LLM step allows `GROQ_MAX_RETRIES` such waits (review and validation 12, auto-fix and generation 15, evals 20) inside its job `timeout-minutes` (15 / 15 / 20 / 20 / 120). Nothing to do |
| An LLM job fails with `All providers failed: groq: Groq API HTTP error 429` (or 413 `rate_limit_exceeded`) after many `retry` lines, or hits its `timeout-minutes` | Groq stayed saturated or down for longer than the job's retry budget (≈ `GROQ_MAX_RETRIES` minutes). Check https://groqstatus.com and the org's other runs (an eval run with many repeats holds the TPM). Once Groq is healthy, re-run the failed jobs (pr-review: **Re-run jobs**; auto-fix: checkbox rerun; generation/validation: re-apply the label or edit the issue). Do not add a global `concurrency` group to serialize LLM calls: GitHub keeps one pending run per group and cancels the others, which drops reviews |
| An eval run fails fast with `::error::eval/eval.error` … `aborted by the circuit breaker` | A daily provider quota is spent (Groq `tokens per day (TPD)`, 200k shared with the production pipeline) or every provider refused (401/403/429, e.g. an invalid `ANTHROPIC_API_KEY`). The run is not published (`error_rate` 1). Do not re-run before the `retry after` it names; production stages fail the same way until then. Fix an invalid key; for repeated TPD exhaustion see [docs/evals.md#token-budget](./evals.md#token-budget) |
| An LLM job fails before any LLM call with `… prompt is ~N estimated input tokens, over <stage>_max_input_tokens` | The input cannot fit one 8K TPM request even after truncation (review: the diff, then the PR body are cut first; the title, prompts and contexts are not). Groq would answer 413 forever, so the job stops. Shorten the issue/PR title or body, or the cited files (generation), or raise the budget on a higher Groq tier / use `AI_PROVIDER=anthropic` (ADR-0028 amendment) |
| Review comment shows **Approval withheld — the diff was cut to the token budget** (`review-withheld`) | Expected (ADR-0038): the PR's code does not fit the review input budget, so the model approved without seeing the listed files. Auto-fix is not triggered and a re-run gives the same result. Review the listed files by hand, split the PR, or run the review on a provider with a larger budget (`AI_PROVIDER=anthropic`, ADR-0032) |
| REQUEST_CHANGES on a cut diff: a finding about a line at the cutoff ("stray `- n`", broken YAML) or a step / test / doc "missing" past it | Before the ADR-0038 amendment (#219), the diff was cut mid-line and the model took the cut for content. The cut now ends on a whole line with a `… [diff cut: N more lines not shown, in <files>]` marker; such a concern is a Low "Not verified" note at most, and a REQUEST_CHANGES whose findings all cite only cut code files is posted as **Changes not requested** (`WITHHELD`, `review-withheld`, no auto-fix). If one still gets through (a finding also cites a shown file), check the named lines in the PR itself, answer the thread as a false positive, and rerun the review or remove `changes-requested`. Persistent: split the PR or use `AI_PROVIDER=anthropic` (ADR-0032). A production misjudgment gets an eval case (AGENTS.md → Eval Gates) |
| Review comment shows **Approval withheld — the review approved without the adversarial analysis** (`review-withheld`, `review.verdict` with `withheld_for: protocol`) | Expected (ADR-0049): an APPROVED review must name a risk on at least 2 of the 4 axes (robustness, side effects, type integrity, issue fit) under `### 🔬 Adversarial Analysis`; the note lists which axes did. No defect was reported and auto-fix is not triggered. Read the diff yourself and approve, or push / re-run the review (**Re-run jobs**). A high share of these in Diagnostics (`review-withheld`, "adversarial protocol not met") is the model not following the format: the lever is `prompts/pr-review-system.md`, run through the live `review` eval (ADR-0031), never `MIN_CRITICAL_POINTS` |
| Review comment shows **🚨 ESCALATED** and the PR has `needs-human`, no auto-fix runs (`review.escalated`, `autofix.skipped` with `reason: circuit_open`) | The circuit breaker (ADR-0050): 3 consecutive automated reviews reported the same failure (same failing checks and same cited files), so the fixes changed nothing. Read the findings: a fix by hand usually ends it (a different failure, or an APPROVE, resets the count). To let auto-fix try once more anyway, post a comment containing `- [x] Rerun auto-fix` (a rerun by an owner, member or collaborator overrides the breaker, like it overrides an approved head). The count is in the marker at the end of the review comment (`streak=N sig=…`) |
| Review comment shows **Verdict overridden to REQUEST_CHANGES** | A check in `config/review-evidence.yaml` exited non-zero on the PR head (ADR-0024) — expand the failing check's output tail in the `🧪 Tool Evidence` section; the fix belongs in the PR, not the review |
| `🧪 Tool Evidence` says *missing* | The default branch has no `config/review-evidence.yaml` or no evidence runner yet (expected: evidence is opt-in and read from the default branch, the job logs `skipped: "no config"` or fails to find the script), the `evidence` job crashed (invalid config, see `review_evidence.error` in its log), or the artifact upload/download failed — review ran without evidence |
| A check reports `ERROR (exit 127)` or `(exit 126)` | The command could not be executed: typo, binary not installed in the evidence job, or quotes/inline comment in `config/review-evidence.yaml` — fix the config; never forces `REQUEST_CHANGES` |
| `🧪 Tool Evidence` says passing results are *not authoritative* | The PR modifies `package.json`, `pr-review.yml` or `adl-pr-review.yml`, which still control what the evidence job runs — review those changes manually before trusting the PASS rows |
| The review is `review-withheld` with `withheld_for: unreadable_verdict` and a note "the review has no readable verdict line" | The model answered without `### 🚀 Verdict` followed by `APPROVED` or `REQUEST_CHANGES` (another layout, a verdict at the top, a truncated answer), so the comment cannot be read as an approval or a request (ADR-0064). Nothing failed and auto-fix did not run: read the comment (it may well say APPROVED) and merge or request changes yourself, or push to review again. Repeated on several PRs, the model is drifting from the prompt's layout: look at the `review.llm_response` size and the raw answer. A failing check or a guardrail finding still requests changes, whatever the layout |
| The review is `review-withheld` with `withheld_for: unproven_findings` and an `### 🔎 Evidence Check` section | Every blocking finding is unsubstantiated (ADR-0061, ADR-0063): it concerns code outside the diff and quotes nothing the PR tree holds (`⚠️ unverified`, or `❌ refuted` when a quote is not where it says), or it points at lines the diff does not show. Changes are not requested and auto-fix does not run. Read the finding: if it is right, request the change yourself; if the model misquoted or miscounted lines, re-run the review. A requested-changes review may also carry a `### 🔎 Unsubstantiated Findings` section: those findings are not sent to auto-fix, only the rest of the review is |
| The review is REQUEST_CHANGES with `guardrail_override: true` and a `🛡️ Guardrail Findings` section although the model approved | A hard guardrail is broken in code (rule and file are listed). Fix it, or name the removed test / the changed function in the PR description when that is the request (the check re-runs on the next push). A wrong finding (e.g. a test case counted as removed) is a bug of `guardrail_review.mjs`: add the diff as a unit test. `review.guardrail_error` means the check was skipped, not passed (`guardrail checks timed out`: a PR file made the parser overrun its 60 s deadline; the review is unaffected otherwise) |
| The review has no `## Impact analysis` block, or the log shows `review.impact_error` | The block only exists when the diff edits a JS/TS export and the PR tree references it from outside the diff (`review.impact_context` carries the counts). It is the first context dropped after the related ADRs when the prompt does not fit (`included: false`), and a listing or read error skips it without failing the review. Not a verdict input |
| The review has no `## Documents that mention what this diff changes` block, or the log shows `review.doc_mentions_error` | The block only exists when a document outside the diff names an export or file the diff changes, renames or removes (`review.doc_mentions` carries the counts). It is part of the Impact analysis's optional block: dropped with it when the prompt does not fit (`included: false`), and a listing or read error skips it without failing the review. A finding about a document must quote it (`Evidence:`), else the review is withheld (`unproven_findings`). Not a verdict input |
| `🧪 Tool Evidence` says *stale* | A push landed between the evidence run and the review's PR fetch; the review of the newer push will carry fresh evidence |
| Review verdict is always `REQUEST_CHANGES` loop never resolves | AI prompt regression; issue body too vague for the generated code to satisfy review criteria; consider manual review |
| `auto-fix-pr` does not trigger after `changes-requested` label | Label name mismatch (`config/labels.yaml` `review.changes.name` vs actual label); `AI_PR_TOKEN` cannot emit `labeled` events; auto-fix workflow not enabled |
| Checkbox rerun (`- [x] Relancer Auto Fixer`) posted but no auto-fix triggered | Comment does not contain the exact text (case-insensitive alternatives: `rerun auto-fix`, `rerun auto fixer`); comment is on an issue that is **not** a PR; comment author's `author_association` is not `OWNER`, `MEMBER` or `COLLABORATOR` (untrusted commenters are ignored by both the workflow `if:` and `auto_fix_pr.mjs`); `issue_comment` trigger not present in `auto-fix-pr.yml` |
| Auto-fix triggered via checkbox but fails at checkout | "Resolve PR payload for issue_comment" step failed — check that `AI_PR_TOKEN` or `GITHUB_TOKEN` has `pull-requests: read` and `contents: read`; `jq` parse error indicates malformed API response |
| A PR changing `scripts/`, `prompts/` or `config/` is reviewed/auto-fixed with the old behavior | Expected: `pr-review` and `auto-fix-pr` run the pipeline from the default branch (ADR-0023); changes take effect after merge |
| Auto-fix, PR review or reset run shows as *Queued* / *Pending*, or an earlier pending run shows *Cancelled* | Expected: the three share one concurrency group per PR branch, `pr-pipeline-<head ref>` (ADR-0020). One of them runs per PR at a time; only the latest pending run is kept. A cancelled pending review is re-triggered by the next push |
| Auto-fix loop stops at attempt 3 | Expected: 3-attempt hard limit reached — manual intervention required (see below) |
| Auto-fix posts "Auto-Fix Skipped" comment and stops | PR modifies `scripts/auto_fix_pr.mjs` — self-modification guard triggered (expected) |
| Auto-fix prompt has `File withheld (not a regular file in the PR tree): <path>`, `autofix.file_withheld` warn event, or a `Patch Rejected` comment with rule `non_regular_target` | The PR branch holds a symlink, directory, FIFO or device at a changed or targeted path (`reason`: `symlink`, `not_regular_file`, `outside_tree`). It is never followed nor read (ADR-0023, F02 of the 2026-10-19 audit), so its target never reaches the LLM. If the link is intended (rare in this repo), fix the review findings on that path by hand and remove `needs-human`. If it is not, treat it as a possible exfiltration attempt: check who pushed the link and where it points (`git ls-files -s <path>` shows mode `120000`; `git cat-file -p :<path>` the target, e.g. `.git/config`, `/proc/self/environ`), remove it from the branch, and rotate `AI_PR_TOKEN` only if an earlier run (before this guard) could have read it |
| Auto-fix workflow succeeds but pushes nothing | A checkpoint resume, or `autofix.skipped` with `approved`, `no_changes` or `guardrail_rejected` (ADR-0028, ADR-0029). Details: [Auto-fix workflow succeeds but pushes nothing](#auto-fix-workflow-succeeds-but-pushes-nothing) |
| Provider outage (Anthropic or Groq) | With both keys set, calls fall back to the other provider automatically, live evals excepted (pinned to the primary: they error, `llm_fallback_disabled`) (`llm_fallback` event, ADR-0032; `error` level on 401/403 = the primary's key is wrong or revoked, fix the secret; on 400/404 = the primary rejects the request itself: unknown `ANTHROPIC_MODEL`/`GROQ_MODEL`, or effort sent to a model without effort support, set `ANTHROPIC_EFFORT=off`; a stage default in `config/models.yaml` (`anthropic_<stage>`) that the account cannot use: set it back to `claude-opus-5-5`). With one key, or both down: workflows fail with HTTP 5xx or timeout (`All providers failed: …`); add the other key or switch provider via `AI_PROVIDER` |
| Groq primary fails with `400 … json_validate_failed`, the answer comes from Anthropic | Groq's model produced output that failed `response_format` JSON validation (generation defaults to `json_object`). Non-retryable: one Groq request, then the ADR-0032 fallback. Diagnose from the `llm_provider_error` event (`provider: groq`, `error_type: json_validate_failed`, `status: 400`, logged before `llm_fallback`; no response body). Recurring on one stage: check its prompt still asks for JSON, or lower `GROQ_<STAGE>_MAX_TOKENS` truncation (a cut answer is invalid JSON). Without an Anthropic key the run fails with `All providers failed: groq: Groq API HTTP error 400: …, anthropic: skipped (no API key configured)` |
| `provider_config_fallback` warn event in the job log | `meta.variable` (`AI_PROVIDER` or `AI_PROVIDER_<STAGE>`) is not `groq`/`anthropic` (`AI_PROVIDER`: the key-based default was used; a per-stage variable: `AI_PROVIDER` was used), or it names a provider whose key is not set (the other provider was used). Fix that variable or add the missing secret (ADR-0032) |
| One stage runs on a different provider than the others | Expected when `AI_PROVIDER_<STAGE>` is set (ADR-0032 amendment 2026-10-17): it overrides `AI_PROVIDER` for that stage. Unset it to follow `AI_PROVIDER` again |
| `Invalid anthropic effort for stage "<stage>": ANTHROPIC_EFFORT=off is not supported by claude-opus-5-5` (or `config/models.yaml anthropic_<stage>_effort=off`, or `claude-sonnet-5-5`) | Opus 5.5 and Sonnet 5.5 cannot disable thinking; `off` would run their default effort. Set the named variable or key to `low` (or another level). `off` stays valid for models that reject effort (Sonnet 4.5, Haiku 4.5) |
| An eval dispatch fails with `EVAL_ANTHROPIC_MODEL / EVAL_ANTHROPIC_EFFORT set, but the <stage> stage runs on groq` | The `anthropic_model` / `anthropic_effort` inputs only apply to an Anthropic run: re-dispatch with `provider: anthropic` |
| `Anthropic API refused the request (stop_reason: refusal, category: …)` | A safety classifier declined the prompt, even after the server-side fallback (`fallbacks: "default"`) when the model supports it. The Groq fallback runs if `GROQ_API_KEY` is set. Recurring on a category: rephrase the prompt or issue (e.g. `cyber` on security-heavy diffs) |
| The `evals` publish job fails with `model changed on the configured provider (<run_id>)` | The suite's published series is another model than the one the configured provider now runs (a `GROQ_MODEL` bump, a stage moved, or a series started by a measurement dispatch). Either restore the previous model, or accept the new one: [re-baseline](#evals) the suite |
| The `evals` publish job fails with `rebaseline refused (<suite>: run <id>)` | The `::error::rebaseline <suite> refused …` line lists the reasons (failed threshold, provider errors, mixed models, partial run, stale dataset). Nothing was reset or deployed. Fix the cause (wait for the quota, fix the stage) and dispatch again |
| Token permission drift | Workflows fail with 403; audit PAT/App token scopes and repository secret values |

---

### Symptom details

The rows of the table above that need more than a line.

#### PR opens but files are wrong or empty

- Prompt template issue (`generation-user.md` placeholders not resolved).
- The model returned malformed JSON.
- `output_writer.mjs` rejected paths (absolute, `..` traversal, or a protected path — the hard-coded floor (`.github/`, `.git/`, manifests, lock files, `.npmrc`/`.yarnrc*`, `*.csproj`, `requirements*.txt`, …) plus `config/protected-paths.yaml` (here `scripts/`, `config/`, `prompts/`, `checkpoints/`, `metrics/`, `observability/`, `docs/`, `README.md`, `.claude/`, `AGENTS.md`, `CLAUDE.md`); see ADR-0021, ADR-0044).
- A rewrite that would cut an existing file of 20+ lines by more than half (`would shrink from N to M lines`, also raised when more than half of the non-whitespace content goes).
- Both stages escalate instead of failing (ADR-0019): generation posts `Code Generation: Patch Rejected` on the issue, applies `needs-human` and opens no PR (`code_gen.skipped` / `pr_prepare.skipped`, `codegen_skip` metric); auto-fix: `reason: "guardrail_rejected"`, below.
- A documentation-only issue always ends here: edit `README.md`/`docs/` by hand.

#### Code Generation: Blocked comment

Generation could not implement the issue (ADR-0029 amendment; `code_gen.skipped` with `reason: "blocked"`, `codegen_skip` metric, `blocked=true`). The comment names the source:

- `denylist` — every file the issue names is protected (`scripts/`, `config/`, `package.json`, …) or above 8,000 chars; implement by hand, or name a writable file if the issue was mis-scoped.
- `model` — the model returned `blocked: true` (typically "blocked by an unmerged PR"); merge the dependency first. A `model` block whose reason says the files are protected or withheld means the deterministic check did not see the issue's paths (before 2026-10-23 prose like `old/new` hid them): name the files with their full path.
- `notes_only` — a `bug`/`feature` issue got only new Markdown notes; check whether the target is protected, otherwise make the issue name the code file.

The planned fix in the comment is the model's proposal, not a written change. Then remove `needs-human` and re-apply `ready-for-dev`. `code_gen.error` with `reason: "blocked"`: the escalation itself failed (GitHub API); the labels may be half-applied, fix them by hand.

#### Code Generation: Patch Rejected comment

The generated patch broke a guardrail (ADR-0019); the comment lists `rules` and the reason per file.

- `module_system`: `require(` in an `.mjs` file or a CommonJS file turned ESM.
- `exported_signature`: an exported function removed or reshaped — for an intended signature change, name the function in the issue body; a removal is never unlocked and is done by hand.
- `unresolved_import`: an import that is neither a builtin, an existing relative file, nor a `package.json` dependency — declare the package by hand first, or ask for the built-in.
- `unshown_file` / `withheld_file`: the model edited a file the issue did not name, or one above 8,000 chars — name the file, or split it.
- `mass_deletion` / `test_count_drop` / `destructive_shrink`: the model rewrote instead of editing.

Then remove `needs-human` and re-apply `ready-for-dev`.

#### Auto-fix workflow succeeds but pushes nothing

- Checkpoint resume: attempt was already completed in a previous run.
- `autofix.skipped` (ADR-0028) with `reason: "approved"` — the latest automated review approved the current head, so a stale `changes-requested` label was ignored without an LLM call (no attempt consumed).
- `reason: "no_changes"` — the model returned `changes: []`: attempt consumed, `needs-human` applied and the summary commented.
- `reason: "guardrail_rejected"` — the patch hit the write denylist, the shrink guard, the write guard or an ADR-0019 static rule (`module_system`, `exported_signature`, `unresolved_import`; listed in `rules`): attempt consumed, `needs-human` applied and the rejection reason commented, nothing written. A signature change the review asks for is allowed when the review names the function.
- ADR-0029 write guard reasons: `file was withheld` / `not shown` — the file is above 8,000 bytes or the budget (raise `autofix_max_input_tokens` or switch to Anthropic), or it was not in the PR diff; `removes N of M lines` / `test count drops` — the fix was destructive, apply the review findings manually.

## Log Locations

For every workflow run, navigate to:

**Actions → \<Workflow Name\> → \<Run\> → Artifacts** to download the `run-trace-<run_id>` JSON file for structured stage-level data.

**Actions → \<Workflow Name\> → \<Run\> → \<Job\> → Step logs** for raw line-by-line output.

Key steps to expand per workflow:

### `validate-issue` (`validate-issue.yml` calling `adl-validate-issue.yml`)
- **Validate issue** — LLM call result, score, verdict
- **Manage labels** — label create/apply/remove HTTP status
- **Upsert issue comment** — comment POST/PATCH result

### `code-generation` (`code-generation.yml` calling `adl-code-generation.yml`)
- **Generate issue change** — prompt construction, LLM response, file write results
- **Create Pull Request** — PR number or error from `peter-evans/create-pull-request`

### `pr-review` (`pr-review.yml` calling `adl-pr-review.yml`)
- **Run PR review** — PR resolution, LLM call, comment upsert, review submit, label swap, re-pulse guard result

### `changelog-check` (`changelog-check.yml`)
- **Verify CHANGELOG.md updated for entrypoint or ADR changes** — exits 0 (skipped) when no entrypoints or ADRs changed; exits 1 with a plain-text error message describing which trigger files were found and what is missing

### `evals` (`evals.yml`)
- **eval (one matrix job per suite) → Run eval suite** — the Markdown report; `eval-results-<run_id>-<suite>` and `run-trace-<run_id>-<suite>` artifacts. Weekly runs, one suite each, repeats 3: `validation` Mondays, `review` Wednesdays, 06:23 UTC (one suite × 3 fills most of the Groq TPD); `autofix` Wednesdays 06:47 UTC runs in the `autofix-model` → `autofix-grade` → `autofix-score` jobs instead (below), queued behind `review`; a manual run's failed suite does not cancel the next
- **publish → Build eval dashboard** — history read back from the site, the runs added (`<run_id>-<suite>`), runs skipped on `error_rate` as warnings; `eval-site-<run_id>` backup, then one Pages deploy. A 404 on `scorecard.json` fails a weekly run: it never sets `init_site`; re-run manually with `init_site` (first deploy) or `restore_run_id`. With `rebaseline`: `rebaseline <suite>: new series <old> → <new>, started by run <id>; displaced run(s): …` (`::notice::`), `rebaseline <suite>: no-op (…)`, or `::error::rebaseline <suite> refused … : <reasons>` and the job fails

### `pipeline-site` (`pipeline-site.yml`)
- **publish → Build the dashboard** — after each pipeline workflow completes (`workflow_run`), a push to `metrics` or a dispatch: `Pipeline views: <n> record(s), <n> trace index(es), <n> page(s), <MB>` and the total site size (also in the step summary); a malformed record or index is a `Warning:` line and on the activity page, never a failure. A 404 on `scorecard.json` fails the job like an eval publish: dispatch with `init_site` only for a site that never had evals.

**Run or triage the `autofix` eval** (EV-03, ADR-0052; `evals.yml`, cron `47 6 * * 3`, or dispatch `suite: autofix`). Three jobs, read in order; a red job names its layer.

| Symptom | Layer | Cause and next step |
|---|---|---|
| The run fails at `plan` with "autofix is measured on Anthropic" | dispatch | Provider `groq` was chosen: use `repo-variable` or `anthropic`. |
| `autofix-model` fails, `circuit_breaker` in its output | provider | Anthropic quota or outage (`eval.error` with `reason: provider_quota`); nothing is published, the next Wednesday retries. |
| `autofix-model` succeeds, `autofix-grade` is skipped | model | Never happens by itself: grade runs only after a successful model job; look at the model job's result. |
| `autofix-grade` fails | grader | `grade_autofix_eval.mjs` could not produce verdicts (file missing, malformed, over 500 runs, golden set not loading): the message names the cause (see "Grade a model-results file"). A failing patch does not fail the job. |
| `autofix-score` has errored runs with "no verdict for …" | wiring | The recording and the verdicts are not from the same run: re-run the whole workflow, never one job. |
| … "could not be graded (FIXTURE_DIGEST_MISMATCH / GRADER_DIGEST_MISMATCH / GRADER_ERROR / TIMEOUT)" | grader | A pinned tree drifted (re-pin with `autofix_dataset.test.mjs`'s printed digests, in a PR) or the grader itself crashed or timed out; the case is an errored run, not a model failure. |
| … "is NO_CHANGES here but was graded as a patch" (or the reverse) | config | The score job rebuilt another outcome than the grader saw: `ANTHROPIC_MODEL` / provider variables differ between the jobs, or a re-run changed them in between. Re-run the workflow. |
| The run is green, no `autofix` card on the dashboard | publish | The score job did not upload `eval-results-<run_id>-autofix` (it did not run: look at the earlier jobs), or the run was a dispatch with another model (kept off the history, ADR-0032). |

The model job's recording (`autofix-model-<run_id>`, 90-day default retention) and the verdicts (`autofix-grader-<run_id>`) are the evidence of a run: download both to see what the model wrote and why a patch failed (`checks`, `failure`).

### `eval-replay` (`eval-replay.yml`)
- **Replay published eval runs** — reads the eval dashboard, replays the last live run of each suite against the PR's code (no LLM call, no secret), writes the per-metric Δ and the cases that change verdict to the job summary. Exits 1 when a threshold the published numbers meet breaks (PR thresholds on both sides), or when the PR's code cannot run the replay (malformed dataset, suite crash); an unreachable dashboard, an unpublished suite or a changed dataset only warns
- **When it runs** — on `pull_request` when the PR touches a prompt, a dataset, the replay scripts, `config/models.yaml` or a module the eval suites load: `review_prompt.mjs`, `review_evidence.mjs`, `review_decision.mjs`, `adversarial_review.mjs`, `review_findings.mjs`, `issue_validator.mjs`, `output_writer.mjs`, `eval_*.mjs` and the rest of their import graph (`workflow_gates.test.mjs` fails on an uncovered module). A PR that only changes docs does not run it. The full list is in `docs/evals.md` → PR replay gate.

### `pr-evals` (`pr-evals.yml`)
- **plan → Resolve PR and trigger / Plan** — labeler permission, pinned head SHA, the plan (`run`, `refused` with the reason, `nothing`) and the suites; `pr-evals-plan-<run_id>` artifact
- **eval → Apply PR prompts / Run eval suites** — the prompts written over the default-branch checkout, then one `run_evals.mjs` report per suite; `pr-evals-results-<run_id>` artifact
- **comment → Compare with the published run / Post PR comment / Remove run-evals label**
- Traces: `run-trace-<run_id>-plan`, `-eval`, `-comment` (one per job, they share the run ID)

### `auto-fix-pr` (`auto-fix-pr.yml` calling `adl-auto-fix-pr.yml`)
- **Resolve PR payload for issue_comment** _(only for checkbox-rerun triggers)_ — GitHub PR API call; extracts `head.ref` branch name needed for the checkout step. Failure here means the checkout will not have the correct branch ref.
- **Checkout PR branch** — verifies the correct PR branch is checked out (uses `head_ref` from the resolve step for `issue_comment` events, `pull_request.head.ref` for label events)
- **Apply AI fixes** — attempt count read, LLM call, file writes, attempt label apply
- **Commit and push fixes** — commit push to PR branch

---

## Installing or Updating the Callers in Another Repository (ADR-0045)

From a clone of the pipeline checked out at a release tag: `node scripts/install_consumer.mjs --target <repo> --dry-run`, then without `--dry-run` (details: [installation.md](installation.md#from-a-clone)). To update, check the clone out at the new tag and rerun with `--force`; read the CHANGELOG's `### Breaking` entries first. Its refusals (exit 1, nothing written):

| Message | Fix |
|---|---|
| `HEAD <sha> carries no vMAJOR.MINOR.PATCH tag` | `git checkout <tag>` in the clone; `--allow-untagged` only for a commit that exists on GitHub |
| `templates/consumer/ has local changes` | `git checkout -- templates/consumer` in the clone |
| `N existing caller(s) differ` | The listed `conflict` files were edited in the target: diff them, then `--force` |
| `--target is the pipeline repository itself` | This repository's callers are maintained by hand |
| `git <args> failed in <dir>: …` | The clone is not a git checkout (an archive download): clone it |

**ADL Install** (`install.yml`, from the browser) runs the same installer on the runner. Its own failures, in the `Check inputs` step unless stated:

| Message | Fix |
|---|---|
| `version: expected vMAJOR.MINOR.PATCH` | Rerun with a release tag (`v0.1.0`), not a branch or a SHA |
| `AI_PR_TOKEN is not set` | Add the secret (Contents, Pull requests, Workflows: read and write); `dry_run` works without it |
| `The pipeline repository maintains its own callers by hand` | Not for this repository |
| `Remote branch v… not found` (`Clone the pipeline at the release`) | The tag does not exist: list them at `https://github.com/koydas/autonomous-dev-loop/tags` |
| `refusing to allow a … to create or update workflow` (`Open the pull request`) | The token lacks **Workflows: write** |

## Checking Which Configuration a Run Resolves (ADR-0045)

When a run behaves as if it read the wrong `models.yaml`, `labels.yaml`, protected-paths list or review-evidence file (a repository that uses the pipeline from another repository, or `ADL_CONFIG_DIR` / `ADL_CONFIG_PATH` set by hand), run from the repository under work:

```bash
ADL_CONFIG_DIR=/path/to/trusted/config ADL_CONFIG_PATH=.autonomous-dev-loop node /path/to/pipeline/scripts/print_resolved_config.mjs
```

`roots.mode` is `target` when `ADL_CONFIG_DIR` is set and `pipeline-repo` otherwise; `files` shows the default and the layer actually found; `modelsOverridden` lists the keys the target changed; `protectedPaths` is the effective denylist. Startup errors name the file and the key (`models.yaml (<file>): unknown key "…"`, `protected_paths[0] …`, `ADL_CONFIG_PATH "…" must be a relative path …`, `ADL_CONFIG_DIR "…" must be an absolute path`): fix the target's file, the defaults are never edited for a target.

## A Reusable Workflow Fails Before Any Stage Script (ADR-0045)

validate-issue, code-generation and reset-auto-fix are jobs of the form `<caller job> / <called job>`. If the first steps fail, read the message of **Resolve pipeline version**:

| Message | Cause | Fix |
|---|---|---|
| `pipeline_ref must be the default branch (…) when the pipeline repository calls itself` | A self-call passes another `pipeline_ref` | Pass `${{ github.event.repository.default_branch }}` or nothing |
| `This run does not reference a reusable workflow of <repository>` | The caller job is not a call to `<repository>/.github/workflows/adl-*.yml@…`, or `pipeline_repository` names the wrong repository | Fix `pipeline_repository` or the `uses:` line |
| `The reusable workflow is pinned to "…": pin a commit SHA or a vMAJOR.MINOR.PATCH tag, never a branch` | The `uses:` ref is a branch or a floating tag | Pin a SHA (recommended) or an exact tag |
| `The run reports the reusable workflow at "…" but its path pins "…"` / `does not give the commit` | The run data is inconsistent | Re-run once; if it persists, pin a SHA |
| `The pipeline does not run on pull_request_target` | A caller was triggered by `pull_request_target` | Use `pull_request` or `push`; never `pull_request_target` |

A later `models.yaml (…): unknown key` or `ADL_CONFIG_DIR … must be an absolute path` is a configuration error: see *Checking Which Configuration a Run Resolves*.

## Recovery Actions per Workflow

### `validate-issue`

| Failure | Recovery |
|---------|----------|
| API key missing | Add `ANTHROPIC_API_KEY` or `GROQ_API_KEY` in **Settings → Secrets → Actions**, re-run workflow |
| Label creation 403 | Ensure `GITHUB_TOKEN` or `AI_PR_TOKEN` has `issues: write`; re-run workflow |
| Workflow never triggered | Check **Settings → Actions → General → Actions permissions**; confirm `issues` trigger in `validate-issue.yml` |
| Manual label override needed | Apply `ready-for-dev` or `needs-refinement` directly from the issue Labels panel; `code-generation` will trigger on the next `labeled` event |

### `code-generation`

| Failure | Recovery |
|---------|----------|
| Empty generation output | Improve the issue body (title + clear acceptance criteria), remove and re-apply `ready-for-dev` |
| PR creation forbidden | Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** or set `AI_PR_TOKEN` with `pull-requests: write` |
| Branch `ai/issue-<N>` already exists with conflicts | Delete the stale branch manually via **Code → Branches**, then re-apply `ready-for-dev` (a PR already open on a branch that conflicts is `conflicts-fix`'s: see below) |
| Provider outage | Set `AI_PROVIDER=groq` in **Settings → Variables → Actions** (or swap to `anthropic`) and re-run |

### `pr-review`

| Failure | Recovery |
|---------|----------|
| No PR found for branch | Expected for non-PR branches; if unexpected, verify branch name matches the open PR head |
| Review submit 422 warning | Enable **Allow GitHub Actions to create and approve pull requests**; comment and labels still apply — auto-fix can still trigger via the `changes-requested` label |
| Review submit 500 | Transient GitHub API issue; re-push an empty commit to re-trigger: `git commit --allow-empty -m "re-trigger review" && git push` |
| Re-pulse skipped (auto-fix already running) | Expected guard behavior; wait for the running auto-fix job to complete |
| Review skipped (`already_reviewed`) but a fresh review is needed (e.g. the previous one was `WITHHELD` after an evidence crash) | **Actions → PR Review → the run → Re-run jobs**: a re-run (`GITHUB_RUN_ATTEMPT > 1`) bypasses the per-SHA dedup. A `superseded` run is never re-reviewed; push or re-run the head's own run instead (ADR-0028) |
| `evidence` job fails with `checks.<name>.command` / `timeout_seconds` error | Fix `config/review-evidence.yaml` (each check needs a `command`; `timeout_seconds` must be a positive integer) and push |
| A check reports `TIMEOUT` on every run | Raise `checks.<name>.timeout_seconds` or investigate the hang — timeouts never force `REQUEST_CHANGES`, so auto-fix will not address them |
| Override persists although the check passes locally | Evidence runs with credential-like env vars, `GIT_CONFIG_*` and `ADL_CONFIG_DIR` / `ADL_CONFIG_PATH` stripped — a check that depends on one of them will fail in CI only; make it independent of those variables |

### `conflicts-fix`

| Failure | Recovery |
|---------|----------|
| The sweep log says `refused (#N: 403)` | `dispatch_conflicts.mjs` could not start the run of a PR: the token lacks `actions: write` (the caller grants it, a fork-owned workflow token cannot). The next sweep dispatches it again |
| A PR is labelled `merge-conflict` and nothing happens | The run is triggered by a push to the default branch, by the schedule (every 6 h) or by hand: dispatch **Conflicts Fix** with the PR number. `conflicts_detect.classified` with `state: unknown` means GitHub had not computed `mergeable` yet; the next run reads it again |
| Comment "Merge conflict … cannot push to its head branch" | A fork PR without **Allow edits from maintainers**: tick it, or merge the base by hand. The label clears itself once the PR is mergeable |
| `needs-human` + "Merge conflicts: a human needs to decide", reason `protected_path` | A conflicted file is on the protected list (ADR-0021) and no resolver may write it (`scripts/`, `config/`, `prompts/`, `.github/`, `docs/` outside the changelog and the ADR files). Merge the base by hand |
| Reason `model_rejected` / `guard_rejected` / `syntax_error` (`rules` in the comment) | The model's resolution failed a post-check (`entry_dropped`, `invented_content`, `marker_left`: a conflict marker, or a bare `=======` / `|||||||` line none of the sides had) or a write guard: nothing was pushed, the merge was aborted. Resolve by hand, or fix the cause and dispatch **Conflicts Fix** (a manual run bypasses the cap and the breaker) |
| Reason `too_many_files` / `too_large` / `unsupported_conflict` / `binary_file` | More than 3 conflicted files, hunks past the model's input budget (`conflicts_max_input_tokens`), a deleted/renamed/symlinked file or a binary: by hand |
| Reason `lockfile_failed` / `lockfile_unsafe` | `npm install --package-lock-only` failed, or the PR changes `.npmrc` (the registry is the PR's to choose, so the pipeline does not install from it). Regenerate the lockfile by hand |
| Reason `workflow_scope` / `push_failed` | The merge brings changes to `.github/workflows/` and `AI_PR_TOKEN` lacks the `workflow` scope, or the branch protection refused the push |
| Skipped with `attempts_exhausted` / `circuit_open` | 2 attempts per conflict, or the same conflict twice: resolve by hand, or dispatch **Conflicts Fix** with the PR number to run once more |
| The merge commit is pushed but the review does not run | The push was made with `GITHUB_TOKEN`: set `AI_PR_TOKEN` (a `GITHUB_TOKEN` push triggers no workflow) |
| The merge commit looks wrong | The guards bound size and shape, not meaning: the merge commit is the PR's `fix(ai): resolve merge conflicts with …`; revert it and merge by hand, then review the cause in the trace (`conflicts.resolved`: rung, hunks) |

---

### `evals`

**Re-baseline a suite on a new model** (#209, ADR-0032 amendment 2026-10-19; rules in [docs/evals.md](evals.md#re-baseline)).

Current case (2026-10-19): the `review` series is `anthropic:claude-opus-5-5` (runs 38994398984, 39000563980, both manual dispatches) while production review runs on Groq, so every Wednesday `review` cron fails its publish on the model change.

1. **Which run to re-baseline with: a fresh dispatch on the configuration production uses**, not a past run (the publish only reads this dispatch's results). **Actions → Evals → Run workflow** on the default branch: `suite: review`, `provider: repo-variable`, `anthropic_model` empty, `anthropic_effort: models-yaml`, `repeats: 3`, `publish` on, `rebaseline` on, `init_site` off, `restore_run_id` empty. Run it on a day the Groq TPD is free (not the day of another suite's cron). First check `gh run list --workflow evals.yml`: with one run in progress and one pending, wait — a dispatch then cancels the pending run, which may be that week's cron ([docs/evals.md](evals.md)).
2. **Before the publish, read the eval job:** green (every threshold passed) and an `error_rate` of 0 in the report. A red job, a provider error, a circuit breaker or a mixed-model run is refused: the publish fails with `::error::rebaseline review refused …`, nothing is reset or deployed, the live series stays. Fix the cause, then dispatch again.
3. **Read the publish log:** `rebaseline review: new series anthropic:claude-opus-5-5 → groq:<model>, started by run <run_id>-review; displaced run(s): …`. Record the displaced run IDs and the run ID of the **last deploy before this one** (the newest earlier `evals` run with an `eval-site-<run_id>` artifact): that backup is the pre-rebaseline site. `validation` is untouched (`rebaseline validation: no-op …`).
4. The next Wednesday cron appends to the new series. The replay gate and PR evals compare with it from now on.

No-ops: `rebaseline` on a run of the series' own model is appended as usual; a dispatch whose eval job produced no results publishes nothing; `rebaseline` with `publish` off, or off the default branch, does nothing (no publish job).

**Rollback** (within the 90-day retention of `eval-site-*`): dispatch with `restore_run_id: <last deploy before the rebaseline>` and `rebaseline` off. The history comes from that backup and the dispatch's own run is added on top, so pick a suite and provider whose model matches the restored series: e.g. `suite: validation`, `provider: repo-variable` (a `review` run on Groq would mismatch the restored Opus series and fail on `--fail-on-model-change`). Runs published after that backup leave the site (they stay in their own `eval-results-*` artifacts). After 90 days the displaced runs are gone; a rollback then means re-running the old model and re-baselining back.


**Grade a model-results file of the `autofix` suite** (EV-03, ADR-0052; `scripts/grade_autofix_eval.mjs`, the middle job of the model → grader → score flow). `evals.yml` runs it as the `autofix-grade` job; by hand, run it only for a results file you trust to come from the model job.

1. **Where.** A job or machine with **no secret in its environment** (no provider key, no `GITHUB_TOKEN`) and no write access: it runs `node --test` on code the model wrote, on a copy of the case's fixture. Never in the eval job that holds the provider keys, never on a runner that pushes. Checkout the default branch: the golden set, the hidden tests and the grader code are pinned data of that checkout.
2. **Run.** `node scripts/grade_autofix_eval.mjs --results evals/results/autofix-<run_id>.json [--out evals/grader-results.json]`. The input is the results file of the model job (`results[].case_id`, `repeat`, `output`, `error`); it is read as data and only each run's `status` and patch are used, the model's text never is. A file over 64 MB is refused before it is read.
3. **Output.** One entry per run in `--out`: `graded: true` with `outcome` (`PASS` / `FAIL` / `ERROR`), a `failure` code (`HIDDEN_TESTS_FAILED`, `EXISTING_TESTS_FAILED`, `GRADER_TAMPERING`, `PATH_NOT_ALLOWED`, `TIMEOUT`, `TESTS_INCOMPLETE`, `GRADER_ERROR`, `FIXTURE_DIGEST_MISMATCH`, `GRADER_DIGEST_MISMATCH`, …) and the checks; or `graded: false` with a `reason` (`RUN_ERRORED`, `NO_PATCH`, `NO_GRADER`, `UNKNOWN_CASE`). The last line printed is the count: `Graded <n> of <runs> runs (<passed> passed, <errored> errored)`.
4. **Exit status.** `0` once every run has a verdict, **whatever the verdicts**: a failing patch is a result, not an error. `1` with the reason on stderr and no `--out` file when it cannot produce them: missing `--results`, invalid JSON, a run without `case_id` / `repeat` (the message names its index), a repeated run, more than 500 runs, a golden set that does not load.
5. **Reading the verdicts.** `FIXTURE_DIGEST_MISMATCH` / `GRADER_DIGEST_MISMATCH` mean the checkout's fixture or grader tree is not the one pinned in `evals/datasets/autofix.jsonl`: a stale checkout or an edit without re-pinning, never a model failure (`autofix_dataset.test.mjs` prints the new digests). `GRADER_TAMPERING` is the patch touching an existing test, the manifest or the hidden tests. An `ERROR` is never a pass: look at `failure` before re-running.

### `eval-replay`

| Failure | Recovery |
|---------|----------|
| ❌ `Thresholds broken by this PR`, verdict flips to `error` | The PR changed how recorded responses are parsed or scored (`parseReviewVerdict`, `validateIssue` parsing, `decideVerdict`, a scorer). Fix the regression; the "change verdict" table lists the cases to reproduce with `npm run eval -- --suite <s> --replay <runs/<id>.json from the dashboard>` |
| A threshold change alone | Never blocks: both sides use the PR's thresholds, a published value that misses the new rule is reported under "Already failing". Run **Actions → Evals** on the PR branch to check the new rule live |
| `eval_replay.error`, job red without a report | The PR's code cannot run the replay: malformed `evals/datasets/*.jsonl` (the error names file and line) or a suite module that throws on import. Run `node scripts/replay_evals_ci.mjs --site-url …` locally |
| ⚪ "dashboard unreachable" or "not replayed" | Neutral (green job). Check the Pages site and the `EVAL_SITE_URL` repository variable; a suite with no live run yet needs one **Actions → Evals** run on `main` |
| ⚠️ "Dataset changed since the run" | Expected after a dataset edit: thresholds are advisory until the next live run on `main` records the new hash |
| Local `--replay` of a circuit-breaker run: no ⛔ section, `circuit_breaker` null, runs that were skipped live are executed | A results file recorded before #211: its failed calls carry no `provider_errors`, so replay is message-only. A daily quota (TPD/RPD) still re-trips (its message names it); "every provider refused" (401/403/429 on every provider) does not, and `error_rate` stays 1. Not a regression: re-record with a live run to get the breaker back on replay. Since #211 a failed call records `provider_errors` and `createReplayLLM` reattaches it, so the breaker trips at the same run with the same runs skipped ([details](evals.md#swallowed-llm-errors)). `eval-replay.yml` never meets one (a breaker run is never published) |

### `pr-evals`

| Failure | Recovery |
|---------|----------|
| Labelled `run-evals`, no run, or run with every job skipped | Only `run-evals` passes the `plan` gate. Labels added by `GITHUB_TOKEN` trigger no workflow: add it as a person |
| ⛔ "`<user>` has `triage`/`read`/`unknown` permission" | The labeler needs write access. `unknown`: the permission API failed — add the label again |
| ⛔ "the PR head moved since the trigger" | A push landed between the label and the plan. Add the label again |
| ⛔ "the PR changes files this run cannot take from it" | The PR touches `scripts/` or `config/` (or ships a non-regular prompt). Move the prompt change to its own PR, or measure after merge with **Actions → Evals** on `main` |
| ⚪ "nothing to run" | No changed prompt maps to a suite (`validation-*`, `pr-review-*`) |
| ❌ suite "Not measured: no results file" | `run_evals.mjs` crashed or the job hit `timeout-minutes` (150). Check the **Run eval suites** log: provider error (keys, `AI_PROVIDER`), or a prompt the default-branch code cannot load (empty file, deleted prompt) |
| ❌ "Live eval failed before planning" | The `plan` job failed (PR not found or closed for a dispatch, fetch of `refs/pull/<n>/head` failed). Check its log and re-run |
| Comment says "no baseline" | Dashboard unreachable or the suite was never published: check `EVAL_SITE_URL` and run **Actions → Evals** on `main` once |
| Δ of one case between two runs | Expected noise with `repeats: 1`; dispatch with `repeats: 3` |
| ❌ suite "Not measured: no results file" right after another run on the same PR | Three triggers queued on one PR: GitHub keeps one pending `eval` job per concurrency group and cancelled the waiting one. Trigger again once the running eval is done |
| Label still on the PR after a run | The run was cancelled (the removal step runs on every other outcome). Remove it by hand |

### `auto-fix-pr`

| Failure | Recovery |
|---------|----------|
| Attempt limit reached (3/3) | Review the PR manually; apply fixes, push, then remove `changes-requested` and apply `review-approved` if satisfied, or leave for human merge decision |
| Groq API 400 — `reasoning_effort` not supported / invalid | `GROQ_MODEL` points at a non-reasoning model while `<stage>_reasoning_effort` is set. Set the `GROQ_REASONING_EFFORT` repository variable to `off` (ADR-0025) |
| Groq API 404 `model_not_found` | The configured Groq model was retired. Check https://console.groq.com/docs/deprecations, then update `config/models.yaml` or set the `GROQ_MODEL` repository variable (ADR-0025) |
| Groq API 413 — Request too large (`Limit 8000, Requested …`) | With `"code":"rate_limit_exceeded"` the 413 is transient and retried (see above). If the same request is rejected on every retry, the estimate under-counted: every stage budget is `<stage>_max_input_tokens` × 1.10 + `<stage>_max_tokens` ≤ 8000 in `config/models.yaml` (ADR-0028 amendment); lower the stage's `max_input_tokens` (or check it was not raised). Any other 413 is not retried. Alternatively upgrade to Groq Dev Tier (higher limit) or set `AI_PROVIDER=anthropic`. |
| Anthropic API 401 — Invalid API Key | `ANTHROPIC_API_KEY` secret is expired or incorrect. Generate a new key at [console.anthropic.com](https://console.anthropic.com) and update it in **Settings → Secrets and variables → Actions → `ANTHROPIC_API_KEY`**. |
| LLM returns invalid JSON | Check `auto-fix-system.md` for prompt integrity; re-trigger by removing and re-applying `changes-requested` label |
| Commit push fails (branch protection) | Ensure `AI_PR_TOKEN` has `contents: write` and branch protection allows bot pushes |
| `auto-fix-attempt-N` label missing | Labels are auto-created on first use; if creation fails (403), grant `issues: write` to the token used |
| Auto-fix skipped on a PR that modifies `auto_fix_pr.mjs` | Expected — self-modification guard is active. Fix the script manually and push directly. |
| Workflow re-run completes immediately with no commit | No files changed by the model output for that run (`autofix.skipped`, `reason: "no_changes"`), or the head is already approved (`reason: "approved"`); inspect logs and review feedback context. |
| PR gets `needs-human` and a "No Changes Proposed" comment | The fixer found nothing to change for the `REQUEST_CHANGES` feedback (ADR-0028). Read the model summary in the comment: either the review is wrong (fix by hand or push; the next APPROVE removes `needs-human` and the attempt labels, ADR-0034) or the fixer missed it (apply the fix or re-trigger via the checkbox; the attempt was counted) |
| Auto-fix ran although the PR is approved | Expected when a trusted member ticked "Relancer Auto Fixer": a manual rerun overrides the bot's approval (ADR-0028) |
| `AI response missing non-empty changes array` | The model's JSON has no `changes` array at all (malformed answer, still an error). An explicit `changes: []` is a no-op since ADR-0028; re-trigger via the checkbox if the review feedback is actionable |
| Need to restart auto-fix from attempt 1 | Post or edit a PR comment with `- [x] Relancer Auto Fixer`; this clears existing `auto-fix-attempt-N` labels and the `checkpoints/pr-<N>/autofix.json` checkpoint automatically before rerun (`review.json` is kept: it is the auto-fix prerequisite). |
| Checkbox rerun fails at "Resolve PR payload" step | Confirm the token (`AI_PR_TOKEN` or `GITHUB_TOKEN`) has `pull-requests: read`; inspect the curl output in the step log for HTTP errors |
| Checkbox rerun triggers but commits to wrong branch | Indicates an older workflow version without the step-ordering fix — ensure `auto-fix-pr.yml` has "Resolve PR payload for issue_comment" listed **before** "Checkout PR branch" |

---

## Escalation Criteria

Escalate to a human maintainer when:

1. Auto-fix loop has exhausted 3 attempts — check the PR comment from the bot for a summary of remaining issues.
2. LLM output is consistently off-target or empty for multiple issues — review prompt files in `prompts/` and `config/models.yaml`.
3. A provider (Anthropic / Groq) reports prolonged outage (> 30 min) — switch provider and notify team.
4. Secret or token rotation is needed — rotate in **Settings → Secrets**, coordinate with the team to avoid mid-run failures.
5. A generated PR touches unexpected files or paths — close the PR immediately, audit `output_writer.mjs` path-safety logic, and open a bug report.

---

## Manual Override Path

### Skip AI validation and force label

```bash
# From the issue page → Labels → apply directly
# Or via GitHub CLI:
gh issue edit <issue-number> --add-label ready-for-dev
```

### Re-trigger code generation after fixing the issue body

1. Remove the `ready-for-dev` label from the issue.
2. Edit the issue body with clearer acceptance criteria.
3. Re-apply `ready-for-dev` — the generation workflow triggers on the fresh `labeled` event.

### Force a new PR review cycle

```bash
git commit --allow-empty -m "re-trigger pr-review" && git push
```

### Reset the auto-fix attempt counter

Add or edit a PR comment with `- [x] Relancer Auto Fixer` to automatically reset attempt labels and the `autofix` checkpoint, then start a fresh run from attempt 1.

Or dispatch **Reset Auto-Fix Counter** (`reset-auto-fix.yml`, calling `adl-reset-auto-fix.yml`; `pr_number`, `retrigger`): `scripts/reset_auto_fix.mjs` removes the `auto-fix-attempt-N` labels and, with `retrigger`, re-applies `changes-requested`. The run uploads its trace and commits its record (and the trace index of the PR's work item) to `metrics` (ADR-0041).

### Resolve a PR's merge conflicts now

Dispatch **Conflicts Fix** (`conflicts-fix.yml`, calling `adl-conflicts-fix.yml`; `pr_number`): the PR is merged with its base through the same ladder, bypassing the attempt cap and the circuit breaker for that run. Without `pr_number` it sweeps every open PR.

### Manually approve and close the loop

1. Remove `changes-requested` label from the PR.
2. Apply `review-approved` label.
3. Merge the PR through the normal GitHub merge UI.

### Partial outcomes in the dashboard

A recorded `partial` outcome can mean a withheld approval, requested changes,
intentional review skip, or an auto-fix escalation. It is not a job failure rate.
Execution cards show recorded decisions and causes separately; absent historical
metadata is displayed as not recorded. Inspect the verdict, CI evidence and
incomplete-code count before retrying. Keep approval withheld for incomplete
coverage, and inspect `no_changes` escalations rather than forcing a patch.
See [the incident diagnosis and proposed fixes](dashboard-partial-diagnosis.md)
for the 16–18 October sample, evidence limits and follow-up acceptance criteria.

### Pipelines (flow map)

Open **Pipelines** in the dashboard navigation: one card per recorded work item, plus a card for each merged PR without a recorded flow (ADR-0042, ADR-0043).
Branch-based issue matching (`ai/issue-<n>`) requires a head owned by this
repository; fork or deleted heads use recorded PR identity or local closing
references instead, so a fork branch cannot attach an unrelated issue trace. A PR number
recorded by one work item is never borrowed by another through a hint. Use
**Refresh merge status** to reload GitHub PR states (cached 5 minutes per tab
otherwise); search matches visible card text, including PR/issue numbers,
decisions and models. The page reads up to the 1,000 most recently updated PRs
(open and closed) and states when that limit is reached. A merge is confirmed
only by GitHub's `merged_at`, never by workflow success; a PR closed without it
shows ⊘ "closed without merge", an open one ○ "PR open".

Cards start collapsed. The summary shows the PR/issue title and one icon per
step (Validation, Code generation, PR preparation, Review, Auto-fix, Merge; plus Conflicts fix on a card where it ran, ADR-0059):
✓ success, ✗ failed, ⊘ skipped, ○ not recorded. A step's icon is the span
outcome of its final execution, ordered by when each attempt ended: its last
event of the step, including the workflow event that decides it
(`workflow.push` for Auto-fix, `workflow.pr_operation` for PR preparation),
else the run's completion, else its start. Overlapping runs (duplicate
triggers) can finish out of start order. Undated runs rank first, so never
final over a dated one; ties keep the earlier run in trace order. A failed
review followed by an approval shows ✓ **with** ×3 and an aria-label "after 2
failed or adverse attempt(s)"; the expanded step says "2 failed · recovered
automatically" and lists every attempt. An amber ring marks a step whose span
succeeded but whose decision did not move the item forward. Any other or missing
outcome is ○, never ✓. Merge turns ✓ only once GitHub's `merged_at` confirms
it. Expand a card for the details below.

Each card shows the canonical pipeline (three columns on wide screens, stacked on
narrow ones), including missing stages in grey. Grey means **not recorded**, not
skipped or failed; a conditional step says why it is absent (no linked issue,
auto-fix not triggered without a REQUEST_CHANGES verdict).
Expand review/auto-fix executions to inspect actors, models, duration, then follow
**Agent trace, events & spans** for detailed debugging. **Full chronological flow**
shows the actual execution order; stage arrows only show the canonical pipeline.

PR identity joins retained records first, then the repository-owned `ai/issue-N` branch convention (`ai/issue-007` → issue 7, as in `branchIssue()`) or first same-repository closing reference in the PR body (up to 64 KiB).
Unlinked issues and missing run records are explicit. Metrics cover the retained
work-item trace, possibly spanning several PRs. They exclude history beyond the
six-month record window and index overflows. Cost is a list-price token estimate,
not a bill; Groq free-tier calls cost nothing and are listed apart, other unknown
models/providers remain unpriced. Thinking tokens, cache
adjustments and non-LLM infrastructure costs are excluded.

If GitHub is unavailable or rate-limited, the status explains the failure and
recorded flow cards remain available with merge status unknown. Without
JavaScript the recorded evidence is still readable. See ADR-0042.
