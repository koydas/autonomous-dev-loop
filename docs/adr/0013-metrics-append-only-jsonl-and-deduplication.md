# ADR-0013: Metrics storage as append-only JSONL and same-run deduplication via GITHUB_RUN_ID

- **Date:** 2026-06-01
- **Status:** Accepted

## Context

Pipeline performance needs to be recorded after each completed workflow run (issue validation, PR approval, auto-fix exhaustion). The data must be readable by `scripts/metrics-report.mjs` to produce summary statistics.

`metrics/runs.jsonl` is written by three scripts running in separate ephemeral GitHub Actions VMs with no shared lock primitive. Two concurrent triggers of the same workflow (e.g. an issue edited while validation is in progress, or `auto-fix` triggered while `pr-review` is running) can both succeed in writing a record, producing duplicate lines.

## Decision

**Storage format:** append-only JSONL committed to the default branch via the GitHub Contents API. Each workflow's "Commit metrics" step retries up to three times with exponential backoff to handle concurrent commit conflicts.

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
