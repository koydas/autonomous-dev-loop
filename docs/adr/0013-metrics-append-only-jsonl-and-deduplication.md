# ADR-0013: Metrics storage as append-only JSONL and same-run deduplication via GITHUB_RUN_ID

- **Date:** 2026-06-01
- **Status:** Accepted

## Context

Pipeline performance needs to be recorded after each completed workflow run (issue validation, PR approval, auto-fix exhaustion). The data must be readable by `scripts/metrics-report.mjs` to produce summary statistics.

`metrics/runs.jsonl` is written by three scripts running in separate ephemeral GitHub Actions VMs with no shared lock primitive. Two concurrent triggers of the same workflow (e.g. an issue edited while validation is in progress, or `auto-fix` triggered while `pr-review` is running) can both succeed in writing a record, producing duplicate lines.

## Decision

**Storage format:** append-only JSONL committed to the default branch via the GitHub Contents API (the `metrics` branch since the 2026-10-13 amendment below). Each workflow's "Commit metrics" step retries up to three times with exponential backoff to handle concurrent commit conflicts.

**`run_id` field:** each record carries a composite `{GITHUB_RUN_ID}-{GITHUB_RUN_ATTEMPT}` (e.g. `12345678-1`; `local-<epoch-ms>` for local invocations). Using both variables ensures that operator re-runs of a workflow — where GitHub keeps `GITHUB_RUN_ID` constant and increments `GITHUB_RUN_ATTEMPT` — produce distinct `run_id` values and are not dropped. `deduplicateMetrics` in `scripts/lib/metrics.mjs` filters the record list at report time, keeping only the first occurrence of each `run_id`. Records without `run_id` (written before this field was introduced) are kept unconditionally.

**Accepted limitation:** `deduplicateMetrics` acts as a same-run safety net only. Two *different* concurrent workflow runs for the same issue/PR have distinct `GITHUB_RUN_ID` values, so cross-run duplicates are not caught automatically. They may be removed manually by deleting lines with identical content (`type`, `issue_number`/`pr_number`, `verdict`/`final_verdict`) from `metrics/runs.jsonl`.

## Alternatives Considered

**`CHECKPOINT_RUN_ID` as `run_id`** (`issue-42`, `pr-15`) — the same stable logical ID shared by all concurrent runs for a given issue/PR. This would deduplicate concurrent writes correctly but would also suppress legitimate subsequent records: a re-validation of an edited issue and an APPROVE record that follows a MANUAL record (after manual fixes to a PR) would share the same `run_id` and only the first would be kept. Rejected because it silently hides real outcomes.

**Composite time-window key** (`{CHECKPOINT_RUN_ID}-{started_at truncated to minute}`) — two concurrent runs starting within the same minute share a key; distinct runs separated in time do not. Rejected as overly complex for an MVP and fragile if runs span a minute boundary.

**File locking / atomic writes** — GitHub Actions VMs cannot share a mutex. The Contents API's SHA-based conflict detection is the available coordination primitive, and it only prevents commit conflicts, not write-order races within a single job.

## Consequences

- ✅ Simple, no new dependencies, readable by any JSON Lines parser.
- ✅ `run_id` enables deduplication if the same run somehow writes twice (belt-and-suspenders).
- ✅ All legitimate re-runs (re-validations, post-fix APPROVE records) are preserved.
- ⚠️ Cross-run concurrent duplicates (two different `GITHUB_RUN_ID` values for the same logical event) are not automatically removed; manual cleanup is required in the rare case both concurrent runs succeed.
- ⚠️ The file has no schema enforcement; parsers must tolerate unknown fields for forward compatibility.

## Amendment (2026-10-13): records go to the `metrics` branch

**Context.** A repository rule requires every change to `main` to go through a pull request. Every "Commit metrics" PUT to the default branch failed with `409 Repository rule violations found` (three attempts, then the `Failed to commit metrics` warning): `metrics/runs.jsonl` on `main` has never received a record.

**Decision.** The four workflows (`validate-issue`, `code-generation`, `pr-review`, `auto-fix-pr`) read `contents/metrics/runs.jsonl?ref=metrics` and PUT with `branch: "metrics"`. The `metrics` branch is created once by a maintainer (from `main` in the UI; its other files are unused). The append, `sha` conflict retry and `run_id` deduplication above are unchanged. `metrics-report.mjs` reads the branch's file through `METRICS_FILE` (runbook). `workflow_gates.test.mjs` pins the target branch.

**Alternatives rejected.** A ruleset bypass for the workflow token (or a dedicated GitHub App) would let a run push to `main` without a PR, including runs that check out a PR tree (ADR-0021, ADR-0023), and adds one `[skip ci]` commit to `main` per stage. Per-run artifacts drop `contents: write` for `validate-issue` and `pr-review` but lose history past the artifact retention.

**Consequences.**
- ✅ `main` stays PR-only; its history carries no metrics commits.
- ⚠️ Any token with `contents: write` can rewrite the `metrics` branch: the store has no integrity guarantee.
- ⚠️ `contents: write` is still required by `validate-issue` and `pr-review` only for this step.
- ⚠️ The branch must exist and stay outside the `main` ruleset; if it is deleted, records are lost (warning in the step log) until it is recreated.

## Amendment (2026-10-15): one commit per run, with the run record

"Commit metrics" is `scripts/commit_run_record.mjs` (ADR-0040): the run's `runs.jsonl` lines and its redacted record `metrics/runs/<YYYY-MM>/<run_id>.json` (same composite `run_id`) go to the `metrics` branch in one Git Data API commit, fast-forward only, with the same 3 attempts and 2^i s backoff. `runs.jsonl` is read raw (no 1 MB Contents API cap). A record already stored for a `run_id` is never rewritten (first write wins, like `deduplicateMetrics`).
