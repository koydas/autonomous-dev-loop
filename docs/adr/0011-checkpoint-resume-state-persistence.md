# ADR-0011: Checkpoint writes for state observability across GitHub Actions jobs

- **Date:** 2026-05-25
- **Status:** Accepted

## Context

GitHub Actions jobs run in ephemeral VMs. When a multi-step pipeline fails mid-run — due to a runner timeout, billing cap, or transient API failure — there is no record of which steps succeeded. The entire workflow restarts from step 1, re-paying the cost of completed LLM calls.

Two distinct checkpoint concerns exist in this codebase:

1. **Auto-fix attempt tracking** — `auto_fix_pr.mjs` reads and writes attempt-state files under `.github/checkpoints/checkpoint-attempt-N.json` using direct `fs` calls. This pre-dates the checkpoint library.
2. **Cross-job state recording** — the new `scripts/lib/checkpoint.mjs` library (this ADR) records step outcomes so workflow jobs can inspect what prior jobs completed.

## Decision

Introduce `scripts/lib/checkpoint.mjs` with two exported functions:

- `writeCheckpoint(runId, step, data)` — serialises `{ step, timestamp, data }` to `./checkpoints/<runId>/<step>.json`.
- `readCheckpoint(runId, step)` — deserialises the file; returns `null` if absent.

Each pipeline script calls `writeCheckpoint` at the end of its main step:

| Script | step key | data written |
|---|---|---|
| `validate_issue.mjs` | `validate` | `{ valid, score }` |
| `generate_issue_change.mjs` | `generate` | `{ summary, outputPaths }` |
| `pr_review.mjs` | `review` | `{ isApproved, prNumber }` |
| `auto_fix_pr.mjs` | `autofix` | `{ prNumber, attempt, outputPaths }` |

Checkpoint files are uploaded as GitHub Actions artifacts at job end and downloaded at the start of downstream jobs, making step outcomes available across job boundaries.

**Current scope — write only.** At this commit, no pipeline script calls `readCheckpoint` to skip a completed step at runtime. The checkpoint data is available for inspection and for downstream jobs that choose to read it, but script-level resume-on-read is not implemented. Retry behavior continues to rely on workflow-level artifact gating and the existing `auto_fix_pr.mjs` attempt-counter logic.

## Alternatives Considered

**GitHub Actions cache** — persists across workflow runs (not just retries), which could cause stale state to bleed from one PR into another. Rejected.

**Encode state in PR labels** — works for simple flags but cannot carry structured data (LLM responses, file lists). Rejected.

## Consequences

- ✅ Step outcomes are recorded and available to downstream jobs and operators during incident recovery.
- ✅ The library is ready to be used for script-level resume (`readCheckpoint` exists); wiring it into the step skip logic is a future increment.
- ✅ Pure Node.js (`fs/promises`) — no new runtime dependencies.
- ⚠️ Without `readCheckpoint` skip logic in scripts, a retried workflow run still re-executes all steps; checkpoint data does not prevent duplicate LLM calls at this commit.
- ⚠️ If operators rely on checkpoints for incident recovery, they must be aware that the data records what ran — not that it was used to avoid re-running.
