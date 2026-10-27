# Observability

This document describes the structured observability system for the autonomous-dev-loop pipeline.

## Overview

Three complementary outputs are produced for every pipeline run:

1. **Structured JSON logs** — one JSON line per event written to stderr by each script.
2. **Run trace file** — one JSON file per GitHub Actions run, uploaded as an artifact: the spans, the **run journal** (every event of the run) and the **run envelope** (ADR-0040).
3. **Public run record** — the trace after the redaction allowlist, committed to the `metrics` branch as `metrics/runs/<YYYY-MM>/<run_id>-<attempt>.json` by "Commit metrics" (ADR-0040, see [Run record](#public-run-record)).
4. **Pipeline views** — the records and trace indexes rendered on the dashboard site, next to the evals ([below](#pipeline-views-on-the-dashboard)).

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
| `code_gen.skipped`     | warn   | ✓             | `reason: "guardrail_rejected"`, `rules`, `error` — `validateAiOutput()` rejected the patch (protected or unsafe path): issue commented, `needs-human`, `codegen_skip` metric, exit 0 with `rejected=true` (ADR-0019). `reason: "blocked"`, `source` (`denylist` \| `model` \| `notes_only`), `detail` (the model's or denylist's reason; stderr and trace only, not in the public record: model output, F06) — the issue cannot be implemented: no write, no PR, `ready-for-dev` → `needs-human`, issue commented with the reason and planned fix, `codegen_skip` metric (`reason: "blocked"`, `source`), exit 0 with `blocked=true` (ADR-0029 amendment) |

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
| `review.verdict`   | info   | ✓             | `verdict` (`"APPROVE"` \| `"REQUEST_CHANGES"` \| `"WITHHELD"`), `attempt`, `prNumber`, `evidence_state` (`available` \| `missing` \| `stale`), `evidence_override`, `guardrail_override` (the model approved and a guardrail finding turned it into REQUEST_CHANGES, RV-03), `unreviewed_code_files` (count of code files cut from the reviewed diff; > 0 turns an approval into `WITHHELD`, ADR-0038), `withheld_from` (`APPROVE` \| `REQUEST_CHANGES` \| null: the verdict the unseen-code backstop turned into `WITHHELD`, ADR-0038 / #219), `withheld_for` (`protocol` \| `unproven_findings` \| `unreadable_verdict` \| null: the adversarial protocol withheld an approval, ADR-0049; every blocking finding was unproven, ADR-0061; the review had no readable verdict line, ADR-0064), `adversarial_points` (axes that named a risk), `adversarial_axes` (their ids), `blocking_axes` (axis ids tagged on the High / Medium findings), `streak` (consecutive reviews with the same failure signature, ADR-0050) |
| `review.escalated` | warn   | —             | `prNumber`, `reason` (`circuit_breaker`), `streak`, `labels_added` (`needs-human`), `url` (the review comment) — the same failure was reported by `BREAKER_THRESHOLD` (3) consecutive reviews: no re-pulse of `changes-requested`, so no auto-fix (ADR-0050) |
| `review.external` | info | — | `prNumber`, `rounds` (distinct commits the external reviewer, the `chatgpt-codex-connector` login, reviewed), `threads` (its root inline comments), `p0p1` (those marked P0 or P1) — counts read from GitHub by an approving run before the trace is finalized; a lower bound; not emitted when GitHub could not be read, never 0 (ADR-0043 amendment 2026-10-25) |
| `review.skipped`   | info   | ✓             | `reason` (`already_reviewed` \| `superseded`), `prNumber`, `headSha` — no LLM call (ADR-0028) |
| `review.evidence_assessed` | info | —           | `prNumber`, `state` (`available` \| `missing` \| `stale`), `reason`, `failing`, `unverified` (check names) — the CI evidence read (ADR-0024, ADR-0026) |
| `review.prompt_truncated` | warn | —            | `prNumber`, `diff_truncated`, `body_truncated`, `unreviewed_code_files`, `adrs_shown`, `adrs_found`, `max_input_tokens` — the token budget cut the prompt (ADR-0028, ADR-0036, ADR-0038) |
| `review.comment_posted` | info  | —             | `prNumber`, `action` (`created` \| `updated`), `headSha`, `url` |
| `review.review_submitted` | info / warn | —     | `prNumber`, `review_event` (`APPROVE` \| `REQUEST_CHANGES` \| `COMMENT`), `url`; warn with `skipped: "own_pull_request"` when GitHub refused the review on the actor's own PR |
| `review.labels_applied` | info  | —             | `prNumber`, `added`, `removed`, `repulse_skipped` (auto-fix already running) |
| `review.error`     | error  | —             | `error`                                                  |
| `review.stale_refs_error` | warn | — | `error` — file listing or read failed; the review continues without stale references (ADR-0035) |
| `review.related_adrs_error` | warn | — | `error` — file listing or ADR read failed; the review continues without related ADRs (ADR-0036) |
| `review.finding_evidence` | info | — | `prNumber`, `findings`, `blocking`, `outside` (cite no file of the diff), `verified` (quotes found in the PR tree), `supported` (points at lines of the diff), `unverified` (not located and not proven), `refuted` (a quote not in a file that was read), `unproven` (blocking and neither verified nor supported). Counts only; emitted when the review has a finding (RV-04a, RV-05) |
| `review.finding_evidence_error` | warn | — | `error` — the findings could not be assessed; they are judged as before (RV-04a) |
| `review.guardrail_error` | warn | — | `error` — the guardrail checks failed or overran their 60 s deadline (`guardrail checks timed out`); the review continues without them (RV-03) |
| `review.guardrail_findings` | info | — | `prNumber`, `findings` (count, including those not listed), `rules` (rule ids among `test_count_drop`, `exported_signature`, `module_system`, `unresolved_import`). No path, title or reason (RV-03) |
| `review.doc_mentions` | info | — | `prNumber`, `terms` (changed exports and files that a document names), `refs` (document lines listed), `docs` (documents mentioning them, summed per term), `included` (the prompt had room for the block), `scanned` (documents read), `truncated` (the scan hit its cap) — counts only, never a path or a line of a document (RV-04b) |
| `review.doc_mentions_error` | warn | — | `error` — document listing failed; the review continues without the documents block (RV-04b) |
| `review.impact_error` | warn | — | `error` — file listing failed; the review continues without the impact analysis (RV-02) |
| `review.impact_context` | info | — | `prNumber`, `symbols` (changed or removed exports found), `with_refs` (those still referenced outside the diff), `refs` (references listed), `tests` (related tests), `included` (the prompt had room for the block), `scanned` (source files read), `truncated` (the scan hit its cap) — counts only, never the code (RV-02) |
| `review.prompt_budget_error` | warn | — | `error` — base (`git show`) or head read of a changed prompt failed; the review continues without the prompt budget block (ADR-0037) |
| `review.file_skipped` | warn | — | `path`, `reason` (`too_large`), `size`, `max_bytes` — a PR-tree file is over `PR_TREE_MAX_BYTES` (1 MiB, `scripts/lib/pr_tree_reader.mjs`): it is never read, and is left out of the stale-reference / related-ADR searches or treated as unreadable by the prompt budget; one event per file, the review continues (F22) |
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
| `autofix.file_withheld`        | warn   | —             | `prNumber`, `attempt`, `path`, `reason` (`symlink` \| `not_regular_file` \| `outside_tree`) — a changed file is not a regular file in the PR tree (symlink, directory, FIFO, device): it is never followed nor read, the prompt carries a `File withheld (not a regular file in the PR tree)` marker and a change to it is rejected (`non_regular_target`; ADR-0023, F02) |
| `autofix.llm_request`          | info   | —             | `model`, `input_tokens_est`, `attempt`, `prNumber` |
| `autofix.llm_response`         | info   | —             | `output_tokens_est`, `attempt`, `prNumber`|
| `autofix.push`                 | info   | ✓             | `paths`, `attempt`, `prNumber` — files written; the git push is the workflow's (`workflow.push`) |
| `autofix.attempt_labeled`      | info   | —             | `prNumber`, `attempt`, `label`            |
| `autofix.escalated`            | warn   | —             | `prNumber`, `attempt`, `reason` (`no_changes` \| `guardrail_rejected`), `labels_added`, `url` (escalation comment) |
| `autofix.max_attempts_reached` | warn   | —             | `attempt`, `prNumber`, `url` (exhausted comment) |
| `autofix.skipped`              | info / warn | ✓        | `reason` (`untrusted_comment`, info: before the tracer, stderr only \| `self_modification`, warn: the PR changes `auto_fix_pr.mjs`, comment posted (`url`) \| `approved`, info: no LLM call \| `circuit_open`, info: the review of this head is the 3rd in a row to report the same failure, no LLM call, a trusted human rerun overrides it (ADR-0050) \| `no_changes`, warn: attempt consumed, `needs-human` applied, summary commented, `autofix_skip` metric \| `guardrail_rejected`, warn: same, with the rejection reason commented — write denylist, shrink guard, ADR-0029 write guard or ADR-0019 static rules; `rules` lists them), `attempt`, `prNumber`, `headSha` (approved only) — exit 0, nothing pushed (ADR-0028) |
| `autofix.error`                | error  | ✓             | `error`, `attempt`, `prNumber`            |

### `autofix_reset`

Emitted by `scripts/reset_auto_fix.mjs` (`reset-auto-fix.yml`, ADR-0041): the reset joins the trace of the PR's work item.

| Event                          | Level | `duration_ms` | Key `meta` fields |
|--------------------------------|-------|---------------|-------------------|
| `autofix_reset.start`          | info  | —             | `prNumber` |
| `autofix_reset.labels_removed` | info  | —             | `prNumber`, `removed_labels` |
| `autofix_reset.retriggered`    | info  | —             | `prNumber`, `label` — changes-requested removed and re-applied (new `labeled` event) |
| `autofix_reset.complete`       | info  | ✓             | `prNumber`, `retrigger` |
| `autofix_reset.error`          | error | ✓             | `prNumber`, `error` |

### `conflicts_detect`

Emitted by `scripts/detect_conflicts.mjs` (`conflicts-fix.yml`, ADR-0059): the `merge-conflict` label kept in step with each open PR's mergeability. No LLM, no push.

| Event | Level | `duration_ms` | Key `meta` fields |
|---|---|---|---|
| `conflicts_detect.start` | info | — | `prNumber` (null: every open PR) |
| `conflicts_detect.classified` | info | — | `prNumber`, `state` (`conflicting` \| `clean` \| `unknown` \| `closed`) — `unknown`: GitHub had not computed `mergeable` after the bounded re-reads, the PR is left to the next run |
| `conflicts_detect.labeled` | info | — | `prNumber`, `added`, `removed` — `merge-conflict` and, on a PR that is clean again, the `conflict-fix-attempt-N` labels |
| `conflicts_detect.comment_posted` | info | — | `prNumber`, `url` — once per head, on a conflicting PR the pipeline cannot push to (a fork without maintainer edits) |
| `conflicts_detect.dispatched` | info | — | `prNumber` — the sweep started the fix run of this PR (`workflow_dispatch` of the caller, `sweep: true`; one run per PR so each has its own record, ADR-0041) |
| `conflicts_detect.dispatch_complete` | info / warn | ✓ | `dispatched`, `failed` — warn and exit 1 when GitHub refused a dispatch; the next sweep dispatches it again |
| `conflicts_detect.complete` | info | ✓ | `checked`, `conflicting`, `fixable` |
| `conflicts_detect.error` | error | ✓ | `error` |

### `conflicts`

Emitted by `scripts/conflicts_fix.mjs` (ADR-0059): the base merged into the head of one conflicting PR. The run joins the trace of the PR's work item (ADR-0041).

| Event | Level | `duration_ms` | Key `meta` fields |
|---|---|---|---|
| `conflicts.start` | info | — | `prNumber`, `attempt` |
| `conflicts.skipped` | info | — | `prNumber`, `reason` (`clean` \| `unknown` \| `closed` \| `up_to_date` \| `fork_not_writable` \| `unsafe_ref` \| `attempts_exhausted` \| `circuit_open`), `sig` — exit 0, nothing pushed |
| `conflicts.model_unavailable` | warn | — | `error` — no provider key: the run goes on and escalates at the first file that needs the model |
| `conflicts.llm_request` | info | — | `model`, `input_tokens_est` |
| `conflicts.llm_response` | info | — | `output_tokens_est` |
| `conflicts.adr_renumbered` | info | — | `prNumber`, `from`, `to` — the mechanical renumber of the PR's ADR (the base keeps its number) |
| `conflicts.push` | info | — | `prNumber`, `attempt`, `head_sha`, `files_count` — the merge commit was pushed |
| `conflicts.resolved` | info | — | `prNumber`, `attempt`, `rung` (`L0` \| `L1` \| `L2`), `files_count`, `hunks` (resolved by the model), `renumbered`, `url` (comment) |
| `conflicts.escalated` | warn | — | `prNumber`, `attempt`, `reason` (`protected_path` \| `unsupported_conflict` \| `binary_file` \| `too_large` \| `too_many_files` \| `parse_failed` \| `model_rejected` \| `guard_rejected` \| `syntax_error` \| `lockfile_failed` \| `lockfile_unsafe` \| `push_failed` \| `workflow_scope`), `rules` (post-check or ADR-0029 rule ids), `labels_added`, `url` — merge aborted, nothing pushed, `needs-human` applied |
| `conflicts.complete` | info | ✓ | `prNumber`, `outcome` (`resolved` \| `escalated` \| `skipped`) |
| `conflicts.error` | error | ✓ | `prNumber`, `error` |

No event carries a file name, a hunk, a PR title or model text: the comment on the PR names the files, the record does not.

### `item`

Emitted by `scripts/item_closed.mjs` (`item-closed.yml`, on `issues: closed` and `pull_request: closed`; ADR-0043 amendment 2026-10-21): the end of a work item. The run joins the trace of the item (ADR-0041), opens no stage span, calls no LLM and uses no secret. The dashboard reads `item.closed` to move the item out of "Waiting on you"; a closing before the workflow existed has no event and is never inferred.

| Event         | Level | `duration_ms` | Key `meta` fields |
|---------------|-------|---------------|-------------------|
| `item.start`  | info  | —             | — |
| `item.closed` | info  | ✓             | `state_reason` (issue: `completed` \| `not_planned` \| `duplicate`, else null) **or** `merged` (pull request: boolean). Both are published; nothing else (no number, title, body or actor: the work item comes from the run's envelope) |
| `item.error`  | error | ✓             | `error` (unknown `ITEM_KIND`, or `ITEM_MERGED` that is not `true` / `false`) |

### `labels_install`

Emitted by `scripts/ensure_labels.mjs` (the `setup-labels.yml` template, or by hand, ADR-0045): creates the labels of the effective labels config in a repository. An operator tool, not a pipeline stage: no metrics. In a workflow (`GITHUB_RUN_ID` set) the events are journaled in `observability/traces/<run_id>.json`, which the template uploads as the `run-trace-<run_id>` artifact (`if: always()`).

| Event                     | Level | `duration_ms` | Key `meta` fields |
|---------------------------|-------|---------------|-------------------|
| `labels_install.start`    | info  | —             | `repository`, `labels`, `update`, `dry_run` |
| `labels_install.label_created` | info | —          | `repository`, `label` — after each successful POST |
| `labels_install.label_updated` | info | —          | `repository`, `label` — after each successful PATCH (`--update`) |
| `labels_install.complete` | info  | ✓             | `repository`, `created`, `existing`, `updated`, `drift` |
| `labels_install.error`    | error | ✓             | `repository`, `error` |

### `eval`

Emitted by `run_evals.mjs` (ADR-0027).

| Event           | Level | `duration_ms` | Key `meta` fields |
|-----------------|-------|---------------|-------------------|
| `eval.start`    | info  | —             | `suite`, `repeats`, `replay`; once the dataset is loaded also `cases`, `tokens_est`, `tokens_est_per_run`, `tokens_est_source` |
| `eval.complete` | info  | ✓             | `suite`, `passed`, `resultsFile` |
| `eval.error`    | error | ✓             | `error`; on a circuit-breaker abort also `reason: "provider_quota"`, the breaker fields and `resultsFile` |

### `eval_grader`

Emitted by `grade_autofix_eval.mjs` (EV-03, ADR-0052): the grader job of the `autofix` suite, no secret.

| Event                | Level | `duration_ms` | Key `meta` fields |
|----------------------|-------|---------------|-------------------|
| `eval_grader.start`    | info  | —             | — |
| `eval_grader.complete` | info  | ✓             | `runs`, `graded`, `passed`, `errored` |
| `eval_grader.error`    | error | ✓             | `error` |

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
| `llm_call`                 | info          | ✓             | `provider`, `model`, `fallback` — the provider and model that answered (ADR-0040); `stage` is the calling stage. Feeds `envelope.llm_calls` |
| `llm_call_failed`          | warn          | ✓             | `providers` (`<provider>:<status \| skip reason>`) — no provider answered; the caller gets the error |
| `llm_fallback`             | warn / error  | —             | `from`, `to`, `error_type` (the provider's code when it gave one, e.g. `rate_limit_exceeded`, `json_validate_failed`; else the error class), `status` (HTTP, or null), `error` (stderr and trace only) — the primary failed and the call goes to the other provider; `error` level when the primary's key or config is wrong (`PERMANENT`, 401/403) |
| `llm_fallback_disabled`    | warn          | —             | `from`, `error_type`, `status`, `error` (stderr and trace only) — same fields as `llm_fallback`; the primary failed and the caller passed `fallback: false` (live evals) |
| `llm_provider_error`       | warn          | —             | `provider`, `error_type`, `status` — the primary failed with a structured provider error code (Groq `error.code`, e.g. `json_validate_failed` on HTTP 400: the model's output failed `response_format` JSON validation); logged once, before `llm_fallback` / `llm_fallback_disabled` / the no-key skip. Code and HTTP status only, never the response body |
| `provider_config_fallback` | warn          | —             | `message`, `variable`, `ai_provider`, `provider` — `variable` (`AI_PROVIDER` or `AI_PROVIDER_<STAGE>`) is unknown or names a provider without a key; logged once per process |

### `lessons`

Emitted by `lessons_loader.mjs` in the generation (`code_gen`) and auto-fix (`autofix`) stages (ADR-0051). Ids are keys of the lesson catalog (`rule:<guardrail rule>`, `axis:<review axis>`), never text from a record.

| Event                | Level | `duration_ms` | Key `meta` fields |
|----------------------|-------|---------------|-------------------|
| `lessons.loaded`     | info  | —             | `stage` (`generation` \| `autofix`), `count`, `ids` — recurring signals found on the `metrics` branch and offered to the prompt (generation drops the block when it would exceed the stage's input budget) |
| `lessons.unavailable`| warn  | —             | `stage`, `reason` (`not_configured` \| `http_error` \| `timeout` \| `network_error`), `status` (HTTP, `http_error` only) — the signals could not be read; the run goes on without lessons. A missing `metrics` branch (404) is not a fault and logs nothing |

### `retry`

Emitted by `retry.mjs` before each wait of `retryWithBackoff` (GitHub API calls and LLM clients, ADR-0022).

| Event        | Level | `duration_ms` | Key `meta` fields |
|--------------|-------|---------------|-------------------|
| `retry.wait` | warn  | —             | `attempt`, `wait_ms`, `status` (HTTP, or null), `error_type` (`err.code`, else the error class, else the error name, e.g. `TypeError`), `error` (stderr and trace only) |

### `workflow`

Emitted by `commit_run_record.mjs` ("Commit metrics") for what a workflow step did, not a script (ADR-0040).

| Event                   | Level       | `duration_ms` | Key `meta` fields |
|-------------------------|-------------|---------------|-------------------|
| `workflow.pr_operation` | info        | —             | `prNumber`, `operation` (`created` \| `updated` \| `closed` \| `none`), `url` — `peter-evans/create-pull-request` outputs (code-generation) |
| `workflow.push`         | info / warn | —             | `prNumber`, `outcome` (`success` \| `failure` \| `skipped`) — the auto-fix "Commit and push fixes" step; warn on failure |

### `trace`

Emitted by scripts that read a PR whose payload lacks its body or head ref (push-triggered `pr_review.mjs`, `reset_auto_fix.mjs`), so the run resolves the same work item as the others (ADR-0041).

| Event              | Level | `duration_ms` | Key `meta` fields |
|--------------------|-------|---------------|-------------------|
| `trace.work_item`  | info  | —             | `prNumber`, `branchIssue` (`ai/issue-<n>` head ref, else null), `closingIssues` (issues the body closes, body order, ≤ 20) — numbers only, the body is never logged |

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
  "schema_version": 2,
  "trace_id": "<32 hex>", "item": { "kind": "issue|pr|run", "number": 12, "source": "issue_event|branch|closes|pr|run", "key": "owner/repo#issue-12" },
  "root_span_id": "<16 hex>",
  "child_spans": [{ "span_id": "<16 hex>", "parent_span_id": "<16 hex>", "name": "llm_call", "started_at": "…", "completed_at": "…", "duration_ms": 900, "status": "ok|error|null", "attributes": { } }],
  "spans_overflow": { "count": 0 },
  "envelope": { "workflow": "…", "run_id": "…", "run_attempt": 1, "event_name": "…", "actor": "…", "actor_type": "bot|human|null",
                "repository": "owner/repo", "issue_number": null, "pr_number": 12, "head_sha": "<sha | null>",
                "run_url": "…", "issue_url": null, "pr_url": "…",
                "links": [{ "event": "review.comment_posted", "url": "…" }],
                "llm_calls": [{ "stage": "review", "provider": "groq", "model": "…", "fallback": false, "outcome": "answered|failed", "duration_ms": 900 }] },
  "events": [ { "ts": "…", "run_id": "…", "stage": "…", "event": "…", "level": "…", "duration_ms": null, "span_id": "<16 hex>", "meta": { } } ],
  "events_overflow": { "count": 0, "bytes": 0 },
  "spans": [
    {
      "stage": "<stage_name>",
      "span_id": "<16 hex>", "parent_span_id": "<root_span_id>",
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

### Run journal and envelope (ADR-0040)

`scripts/lib/run_journal.mjs`, fed by `observability.mjs`: `log()` records each event it writes to stderr, `createTracer()` points the journal at `<traceDir>/<runId>.json`.

- **Journal** — `events[]`: every `log()` event of the run, in emission order, written to the trace file on each event (a killed job keeps them). Events logged before the tracer exists are adopted by it. Event and span meta strings are scrubbed in the process that writes the trace (its non-public env values of 12+ characters, credential shapes; not truncated) before they reach the file: the stderr line is unchanged. A later process of the same job (the validation comment and label steps) appends to the events already in the file; a trace at that path whose `envelope` names another run id or attempt (or has none) is replaced by a fresh one, never adopted. `finalize()` writes synchronously, so an event logged while it runs is never overwritten.
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

`metrics/runs/<YYYY-MM>/<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>.json` on the `metrics` branch: the dashboard's source. Written by `scripts/commit_run_record.mjs` (the "Commit metrics" step of `validate-issue`, `code-generation`, `pr-review`, `auto-fix-pr` and — record only, no `runs.jsonl` line — `reset-auto-fix` and `item-closed`) in **the same commit** as the run's `metrics/runs.jsonl` lines, with the same 3-attempt retry (ADR-0013, ADR-0040).

### Redaction contract

`redactTrace()` in `scripts/lib/run_record.mjs` is the only path from a trace to the store. The site is public:

| Rule | Detail |
|---|---|
| Allowlist, not denylist | Event meta keeps only the keys listed for that event in `EVENT_META_ALLOWLIST`; an unlisted event keeps its name, level and timing with `meta: {}`. Span meta keeps `SPAN_META_ALLOWLIST`. Unknown top-level and envelope keys are dropped. |
| Never stored | Prompts, raw model output, file contents, issue/PR titles and bodies, previews, stack traces, stderr tails, env, local paths. |
| Strings | Already scrubbed against the producing step's env by the journal; scrubbed again against the committing step's env, then cut to 200 characters: every env value of 12+ characters except public run metadata (`GITHUB_REPOSITORY`, `GITHUB_SHA`, …, `*_MODEL`, `*_EFFORT`, `*_PROVIDER`, `RUN_RECORD_*`), and credential shapes (`ghp_…`, `github_pat_…`, `sk-ant-…`, `gsk_…`, `Bearer …`, JWTs, AWS keys). |
| Provider errors (audit F01, F20) | A provider error message embeds the response body (Groq: organization id and service tier on a 429, the model's `failed_generation` on a 400 `json_validate_failed`). `retry.wait`, `llm_fallback`, `llm_fallback_disabled` and `llm_provider_error` publish `error_type` and `status` only, and every value of these four events is a finite number or an identifier (`[A-Za-z][A-Za-z0-9_.-]{0,63}`), else null. Everywhere: `error_type` is an identifier or null, `status` an HTTP status (100–599) or null. |
| Free-text `error` | Sanitized before the string scrub, in event meta, span meta and OTLP `adl.error` alike (`sanitizeErrorText()`): cut at the first provider body marker — `HTTP error <status>: ` (the status is kept), `{"`, `: {` — and suffixed `[body omitted]`; then `org_…`, `Bearer <anything>`, `api_key=` / `x-api-key:` / `secret` / `password` / `authorization` values and key-shaped tokens (32+ characters mixing letters and digits) become `[redacted]`. An organization id (`org_` + 16+ characters) is scrubbed from every published string. |
| Values | Numbers, booleans, null; arrays of primitives (≤ 50 items); one level of flat map. Nested objects are dropped. |
| URLs | Kept whole only on `GITHUB_SERVER_URL`, URL-safe characters, nothing to scrub; otherwise null. |
| Span attributes (ADR-0041) | Kept per span name in `SPAN_ATTRIBUTE_ALLOWLIST`: `run`, `llm_call`, `eval.case`, each stage (its `SPAN_META_ALLOWLIST` keys as `adl.<snake_case>`), each side-effect span (its event's `EVENT_META_ALLOWLIST` keys). Span events keep their event's allowlist. Any other attribute, and every attribute of an unlisted span name, is dropped; same string scrub and cut. |
| Size | ≤ 256 KiB per record; the OTLP block ≤ 128 KiB (spans past it counted in `spans_overflow.count`, span events in `spans_overflow.events`), events past the rest are added to `events_overflow`. |

**Free-text `error` per event** (ADR-0040 amendment 2026-10-20). Sanitized as above wherever it is kept.

| Event | `error` published | Why |
|---|---|---|
| `retry.wait`, `llm_fallback`, `llm_fallback_disabled` | no — `error_type`, `status` | the message is the provider's HTTP error with its body |
| `llm_provider_error` | no (never had it) | code and status only |
| `issue_validation.fail`, `code_gen.error`, `review.error`, `autofix.error`, stage span meta (`error`, OTLP `adl.error`) | yes, sanitized | an unexpected exception: may be `callLLM`'s `All providers failed: <provider>: … HTTP error <status>: <body>`, cut at the body |
| `pr_prepare.error`, `code_gen.skipped`, `pr_prepare.skipped` | yes, sanitized | our own message: write guard, static verifier or a GitHub API call |
| `review.stale_refs_error`, `review.related_adrs_error`, `review.impact_error`, `review.doc_mentions_error`, `review.guardrail_error`, `review.finding_evidence_error`, `review.prompt_budget_error`, `review.models_config_ignored` | yes, sanitized | our own message: a git or file read of the PR tree |
| `autofix_reset.error`, `conflicts_detect.error` | yes, sanitized | our own message: a GitHub API call |
| `conflicts.error`, `conflicts.model_unavailable` | yes, sanitized | an unexpected exception: may be `callLLM`'s provider error (sanitized), a git failure or a GitHub API call |
| `trace_write_failed`, `start_span_failed`, `end_span_failed`, `trace_finalize_failed` | yes, sanitized | our own message: a trace-file write |
| `review_evidence.error`, `eval.error`, `eval_grader.error`, `eval_replay.error`, `pr_evals.error`, `pr_evals_report.error` | no (not allowlisted: `meta: {}`) | out of the allowlist since ADR-0040 |


### Schema (`schema_version: 2`)

```json
{
  "schema_version": 2,
  "trace_schema_version": 2,
  "run_id": "<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>",
  "trace_id": "<32 hex | null>",
  "item": { "kind": "issue|pr|run", "number": 12, "source": "…", "key": "owner/repo#issue-12" },
  "root_span_id": "<16 hex | null>",
  "envelope": { "...": "as in the trace, validated" },
  "started_at": "<ISO8601 | null>", "completed_at": "<ISO8601 | null>", "outcome": "<string | null>",
  "spans": [{ "stage": "…", "span_id": "…", "parent_span_id": "…", "started_at": "…", "completed_at": "…", "duration_ms": 0, "outcome": "…", "meta": { } }],
  "events": [{ "ts": "…", "stage": "…", "event": "…", "level": "info|warn|error", "duration_ms": null, "span_id": "…", "meta": { } }],
  "events_overflow": { "count": 0, "bytes": 0 },
  "spans_overflow": { "count": 0, "events": 0 },
  "otlp": { "resourceSpans": [{ "resource": { "attributes": [] }, "scopeSpans": [{ "scope": { "name": "autonomous-dev-loop", "version": "1" }, "spans": [] }] }] }
}
```

Schema 1 (ADR-0040) is the same without `trace_id`, `item`, `root_span_id`, the span ids, `spans_overflow` and `otlp`. `readRunRecord()` (`run_record.mjs`) reads both: a v1 record gets its trace id from its envelope (issue, else PR) and `otlp: null`.

A consumer must ignore unknown fields and branch on `schema_version`. `run_id` matches the `run_id` of the run's `runs.jsonl` records (ADR-0013).

### Dedup and retention

- The first record for a `run_id` (run + attempt) wins: a record already on the branch is not rewritten; the `runs.jsonl` lines are still appended (report-time dedup, ADR-0013).
- A run that never created a tracer (an untrusted auto-fix comment, a review with no open PR) writes no record. The `pr-review` evidence job's trace stays an artifact only.
- Size: ~3–10 KB per record (10–40 events), ~600 runs/month at the current activity → **≈ 2–6 MB/month**; hard ceiling 256 KiB × runs. Records are kept 12 months; older `metrics/runs/<YYYY-MM>/` directories are removed by hand on the `metrics` branch (no automated pruning yet).

---

## End-to-End Trace (ADR-0041)

One trace per **work item** — an issue, or a PR without an issue — links every run that touches it: validate-issue → code-generation → pr-review (each cycle) → auto-fix (each attempt) → reset-auto-fix. No context is passed between workflows: each run derives the same trace id from its own payload.

### Trace identity

`trace_id` = first 128 bits (32 hex, W3C trace-context) of SHA-256 of the item key `<owner>/<repo>#issue-<n>` (or `#pr-<n>`, `#run-<run_id>`). Resolved by `resolveWorkItem()` (`scripts/lib/trace_context.mjs`), first match wins:

| Order | Source (`item.source`) | Where it is read |
|---|---|---|
| 1 | `issue_event` | `issues` payload (not a PR), `workflow_dispatch` `inputs.issue_number` |
| 2 | `branch` | head ref `ai/issue-<n>`: `pull_request.head.ref`, push `ref`, or a `trace.work_item` event |
| 3 | `closes` | the **first** issue the PR body closes (`Closes` / `Fixes` / `Resolves #n`, body order) |
| 4 | `pr` | the PR number (payload, `inputs.pr_number`, `trace.work_item`) |
| 5 | `run` | nothing else: the run is its own trace (scheduled evals, local runs) |

The PR body is untrusted: only same-repository `#<digits>` after a closing keyword counts, in the first 64 KiB, at most 20 references; it is parsed when the payload is read and never kept. A PR body edited to close another issue moves the **later** runs to that issue's trace (earlier records stay where they are).

### Span tree of a run

| Span | Parent | Kind | Source |
|---|---|---|---|
| `run` (root) | — | internal | one per trace file (`root_span_id`; a later step of the same job adopts it) |
| `<stage>` (`review`, `autofix`, `code_gen`, …) | `run` | internal | `createTracer().startSpan/endSpan`; a restarted stage keeps its id |
| `llm_call` | enclosing stage | client | `callLLM()` via `withSpan()` |
| `eval.case` | `eval` stage | internal | `runSuite()`: one per case × repeat; its LLM calls are children |
| side effects (`review.comment_posted`, `autofix.attempt_labeled`, `workflow.push`, … — `SIDE_EFFECT_EVENTS` in `otlp_trace.mjs`) | enclosing span | client | the journaled event (start = `ts − duration_ms`) |
| span events | enclosing span | — | every other event (`retry.wait`, `llm_fallback`, `llm_call`, `*.start`, …) |

Each journal event carries `span_id`: the `withSpan()` context (AsyncLocalStorage, so concurrent eval workers do not mix), else the open stage, else the root. Span ids are 16 random hex; v1 traces get ids derived from run id + stage. Spans from different runs (different runners, different clocks) are ordered by start time only; the only cross-run duration is the item lead time of the trace index.

### `llm_call` attributes

| Attribute | Value |
|---|---|
| `gen_ai.operation.name` | `chat` |
| `gen_ai.system` | provider that answered (`groq` \| `anthropic`); the primary when no provider answered |
| `gen_ai.request.model` | model the stage asked for (primary config) |
| `gen_ai.response.model` | model of the provider that answered (its config; the API response is not parsed) |
| `gen_ai.request.max_tokens` | stage `max_tokens`, when set |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | as the provider billed them (`onUsage`, ADR-0041 amendment): input = whole prompt including cached tokens, output including thinking / reasoning; the chars/4 estimate when the provider reported no usage |
| `gen_ai.usage.cache_read.input_tokens` / `gen_ai.usage.cache_creation.input_tokens` | prompt-cache reads / writes, measured usage only |
| `adl.usage.estimated` | `false` for provider-measured usage, `true` for an estimate; a failed call with no billed response has no usage attribute |
| `adl.stage` | calling stage |
| `adl.llm.fallback` / `adl.llm.fallback_from` | the fallback answered / the primary it replaced |
| `adl.llm.providers` | `<provider>:<status \| skip reason>` per failed or skipped provider |
| `adl.llm.input_budget_skipped` | providers skipped because the prompt was over their input budget |
| `adl.llm.max_input_tokens` | the stage input budget passed to the call |
| `error.type` | error class (`TRANSIENT`, `PERMANENT`, …) on a failed call; status `error` |

Never an attribute: prompt, completion, file content, issue/PR title or body, env value — the allowlist has no key for them, and the record drops anything unlisted.

### LLM cost on the dashboard

`scripts/lib/llm_cost.mjs` prices each `llm_call` from `PRICES_USD_PER_MTOK` (`eval_scorecard.mjs`), list price, never the bill:

| Basis | When | Amount |
|---|---|---|
| `measured` | `adl.usage.estimated: false` | uncached input × `in` + cache reads × `cacheRead` + cache writes × `cacheWrite` + output × `out` |
| `estimated` | older records, or no usage reported | input × `in` + output × `out` (no cache, no thinking) |
| `free` | `gen_ai.system: groq` | $0 (free tier) |
| `unpriced` | model not in the table, no token count, prompt over `maxPromptTokens` | not added, counted apart |

`adl.stage` names the pipeline stage the cost goes to (`validation` → `issue_validation`, `generation` → `code_gen`, `review`, `autofix`). Shown on the flow card (per flow, step, execution, call), the run page (LLM cost panel, waterfall Cost column), the trace page (per stage and run), Health (total, mean per run / work item, per stage, workflow, day, top 10 runs and work items), Activity and Models.

**Operational cost vs eval cost.** Everything above is the *operational* cost: pipeline runs from the run records on the `metrics` branch. The cost of the eval runs is a separate Health panel (`Eval LLM cost`, `#cost-evals`), computed from the scorecard's `cost_est` (harness chars/4 estimate, list price; input ignores the prompt cache, output excludes thinking) over all the history the scorecard keeps, not the pipeline window. It has a total, a per-suite table and the top 10 priced runs. A Groq run is free tier, a run whose model has no price is `unpriced` and counted apart, never as $0. The two are never added: eval traces stay workflow artifacts and have no run record, so neither panel can double-count the other.

### Storage

- **Run record** (`metrics/runs/<YYYY-MM>/<run>-<attempt>.json`, schema 2): `trace_id`, `item` and `otlp` — an OTLP/JSON `ExportTraceServiceRequest` body (`resourceSpans → scopeSpans → spans`, attributes as `{ key, value: { stringValue | intValue | … } }`, nanosecond timestamps as strings). It can be POSTed as is to any OTLP/HTTP JSON endpoint (`/v1/traces`); `scripts/tests/otlp_trace.test.mjs` validates the shape against `scripts/tests/fixtures/otlp/minimal-trace.json`.
- **Trace index** (`metrics/traces/<trace_id>.json`): written in the **same commit** as the record, same retry, same first-wins dedup on `run_id`:

```json
{
  "schema_version": 1, "trace_id": "…", "item": { "kind": "issue", "number": 12, "source": "branch", "key": "owner/repo#issue-12" },
  "first_started_at": "…", "last_completed_at": "…", "lead_time_ms": 5400000,
  "runs": [{ "run_id": "123-1", "record_path": "metrics/runs/2026-10/123-1.json", "workflow": "Validate Issue", "event_name": "issues", "root_span_id": "…", "started_at": "…", "completed_at": "…", "outcome": "success" }],
  "runs_overflow": 0
}
```

  Runs sorted by start time, ≤ 500 (more are counted in `runs_overflow`). An index that cannot be parsed or names another trace is left untouched (`::warning::`), never rebuilt from one run; the record still lands.

### Reading a trace

```bash
# trace id of an issue (or pr-<n>):
node -e "import('./scripts/lib/trace_context.mjs').then(m => console.log(m.traceIdFor('owner/repo#issue-12')))"
git fetch origin metrics
git show origin/metrics:metrics/traces/<trace_id>.json | jq '.runs[] | {run_id, workflow, outcome, started_at}'
# span tree of one run:
git show origin/metrics:metrics/runs/2026-10/<run>-<attempt>.json \
  | jq '.otlp.resourceSpans[0].scopeSpans[0].spans[] | {name, spanId, parentSpanId, status: .status.code, events: [.events[].name]}'
# every LLM call of the item, with provider and estimated tokens:
for p in $(git show origin/metrics:metrics/traces/<trace_id>.json | jq -r '.runs[].record_path'); do
  git show "origin/metrics:$p" | jq -c '.otlp.resourceSpans[0].scopeSpans[0].spans[] | select(.name == "llm_call") | [.attributes[] | {(.key): (.value | to_entries[0].value)}] | add'
done
```

All the run records of a trace concatenated (`spans` of each `otlp` block, same `traceId`) form the full item trace in any OTLP viewer (e.g. a local Jaeger `/v1/traces` import).

---

## Pipeline views on the dashboard

**[koydas.github.io/autonomous-dev-loop/pipeline/](https://koydas.github.io/autonomous-dev-loop/pipeline/)** — static pages built by `build_eval_site.mjs --pipeline-dir` from a checkout of the `metrics` branch, in the same build as the eval dashboard (ADR-0027 amendment 2026-10-17: Pages hosts one site). Rebuilt by `pipeline-site.yml` after each run of the five workflows that commit a record (`workflow_run`; their `GITHUB_TOKEN` + `[skip ci]` commits create no push run), on a push to `metrics` and on dispatch, and by every eval publish.

| Page | Content |
|---|---|
| `index.html` (home) | One phone screen (ADR-0043 amendment 2026-10-24, `consoleOverview()`): status line from the diagnostic rules naming the top active problem; Flows, Cost (per stage), Quality (eval gates, one chip per suite) and Waiting on you over the last 7 days, each row linked to its page and each chip to a filtered view; a change only on a previous window of ≥ 10 runs |
| `evals.html` | The evaluations (latest gate per suite, then each suite's thresholds, trend and history); `#suite-<name>` opens that suite. `index.html#evaluations` is forwarded here |
| `status.json` (site root) | `{ schema_version, app, generated_at, status: ok \| warn \| bad \| no_data, headline }`: the diagnostic status, raised to `warn` by a failing eval gate (`buildStatus`, `findings_export.mjs`); read by the ai-dev-tools dashboard's tab-bar switch |
| `pipeline/diagnostics.html` | Deterministic findings (`pipeline_diagnostics.mjs`, `RULES`): observed fact, labelled hypothesis, impact, frequency, evidence (run, event, summary, https link), Investigate link; data gaps; severity / category filters; per finding `first_seen`, `last_seen` and `status` (`active` / `resolved` over the last `RULES.activeWindow` eligible runs of its rule; resolved = `info`) |
| `pipeline/levers.html` | Rules and levers (ADR-0047): the finding → lever table itself, generated from `LEVERS` / `NO_LEVER` in `scripts/lib/meta_levers.mjs` — for each rule the stage, what it governs, the targets with what a change to each requires (a live eval suite, or a check by hand), the decisions, and for the rules without a lever the reason; what no lever points at. Row anchors `#rule-<id>` are linked from the lever block of a Diagnostics card |
| `pipeline/console.css` | Base, theme and console component styles of every page of a site with pipeline views (one file instead of inline styles) |
| `pipeline/flows.html` | Pipelines: **Waiting on you** first (open items escalated to a human, oldest first, with the reason and the escalation comment; `#waiting`), then one row per work item, opening into stage boxes and key information (`pipeline_journey.mjs`), final status per step with ×N attempts and adverse-decision ring, full attempt history, last recorded state, escalations, cost; live GitHub PR states (`pulls?state=all`, ≤ 10 pages, 5-min `sessionStorage` cache); URL-kept filters |
| `pipeline/index.html` | Investigation — execution list and activity feed: every journal event, newest first (latest 300), with stage, level, a summary of its decisive meta (`verdict`, `reason`, `rules`, …), issue, PR, run and run outcome; filters by stage, run outcome, level, issue and PR (inline script, rows stay readable without it). Input warnings (skipped records) are listed here |
| `pipeline/feed/<YYYY-MM>.html` | The same per month, at most 2000 actions (the run pages keep every event) |
| `pipeline/traces/<trace_id>.html` | One per trace index: one waterfall of every run of the work item (validation → codegen → review cycles → auto-fix attempts → reset), each run's span tree down to LLM calls and side effects; duration, status, `provider:model` (`gen_ai.*`), tokens flagged `est.`, links (run, PR, issue, comments); lead time, running vs waiting; `runs_overflow` / `spans_overflow`; a listed run without a loadable record stays as a row |
| `pipeline/runs/<run_id>.html` | Per-step execution status and decision, key events (decisions, warnings, errors, side effects), envelope, links, the span waterfall (a v1 record is shown flat), every event with its meta behind a disclosure (`#ev-<n>` anchors), overflow counters, link to the item trace |
| `pipeline/health.html` | **Trends** first (`#trends`, `overviewTrends()`: the 7 / 14 / 30-day indicators with their change and sparkline, result / duration / provider charts, the secondary strip, metric definitions), then funnel (validated → PR opened → approved; merged is not journaled), WITHHELD rate and causes (incl. cut diffs, `withheld_from`), REQUEST_CHANGES turned WITHHELD (#220), auto-fix outcomes and guardrail rules (legacy `runs.jsonl` lines without a record included), fallbacks / `llm_call_failed` / 429 waits, review cycles per PR, p50/p95 per stage, critical path per item, Groq tokens per day vs the 200k TPD with the eval crons and eval runs |
| `pipeline/models.html` | Per `provider:model`: pipeline calls, failures, fallback answers, tokens, runs — and the eval runs of that model (cross-link with the eval pages) |
| `findings.json` (site root) | The Diagnostics findings, machine-readable (ADR-0047 §1, `findings_export.mjs`): written by `assembleSite` from the same `diagnose()` result as the page, only with the pipeline views. The Diagnostics page links to it under the status banner (`exportNote` in `console_views.mjs`): the number of findings and runs it holds and its `generated_at`. Schema below |


### `findings.json` (`schema_version: 1`)

A serialization of the Diagnostics page: **every value in it is shown on the page**; it adds no journal field and no event meta outside `EVENT_META_ALLOWLIST`. Fields are copied by name, so a field later added to a finding is not published until it is added to `findings_export.mjs` (and `scripts/tests/findings_export.test.mjs`, which checks export ⊆ page on a fixture where every rule fires, fails until it is on the page).

```json
{
  "schema_version": 1,
  "generated_at": "<ISO8601 build time>",
  "window": { "from": 0, "to": 0, "runs": 0 },
  "status": "critical|warning|ok|no_data",
  "findings": [{
    "key": "<rule id; id:n only on a collision>", "id": "…", "category": "…", "title": "…", "severity": "info|warning|critical", "status": "active|resolved",
    "first_seen": 0, "last_seen": 0, "clean_since": 0,
    "fact": "…", "hypothesis": null, "impact": "…", "frequency": "…",
    "evidence": [{ "run_id": "…", "ts": 0, "event": "…", "summary": "…", "pr": 0, "url": "https://…" }],
    "lever": null
    // or { "stage": "review", "summary": "…", "adr": ["0028"], "requires": ["evals", "docs-and-tests"], "verified": false,
    //      "targets": [{ "kind": "config|variable|prompt|policy|external", "ref": "config/models.yaml#review_max_input_tokens", "gate": "review|null", "requires": "evals|no-eval-gate" }] }
  }],
  "gaps": [{ "id": "…", "title": "…", "detail": "…" }]
}
```

- `window` is relative to the first and last recorded run (epoch ms; `null` when no run is dated), not to the build time: the site rebuilds when a record lands, so `generated_at` can be old after a quiet week. A consumer shows both.
- `first_seen`, `last_seen`, `clean_since`: epoch ms or `null` (finding lifecycle, ADR-0043). `evidence` is capped at 25 entries, as on the page. Findings are most severe first.
- `key` is the identity of a finding across builds; renaming a rule is a breaking change. `lever` is `null` unless the finding is `active`, `warning` or `critical` and its rule is in the lever table (`meta_levers.mjs`, ADR-0047 §2); it is advice (`verified` is always `false`): it says where to look, not that the setting is the cause. It is shown on the Diagnostics card as "Suggested lever".
- `status: "no_data"` and a `gaps` entry are not health; an empty `findings` array is not proof of health. The file is absent from a site built without pipeline records.
- `title`, `fact`, `hypothesis` and `evidence[].summary` are data: some carry allowlisted event metadata that can be model-originated text. A consumer must never execute or obey them.
- A consumer must reject a `schema_version` it does not know. An additive change (field, value, finding) keeps the version; a removal, rename, change of meaning or of a `key` bumps it.

Rules: every record string is escaped (the allowlist limits keys, not content); URLs are links only when `https:`; `run_id`, `trace_id` and month are validated before naming a file; the newest 6 months of records are rendered. Modules: `pipeline_model.mjs`, `pipeline_health.mjs`, `pipeline_site.mjs`, `pipeline_journey.mjs`, `pipeline_kpis.mjs`, `pipeline_diagnostics.mjs`, `console_views.mjs` (pure, c8-gated); `flow_dashboard.mjs` renders Pipelines. Token counts are chars/4 estimates; runner clocks differ, so offsets between runs on a trace waterfall and the running/waiting split are approximate.

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
