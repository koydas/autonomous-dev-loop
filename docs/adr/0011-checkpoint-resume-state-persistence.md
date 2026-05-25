# ADR-0011: Checkpoint-resume for state persistence across GitHub Actions jobs

- **Date:** 2026-05-25
- **Status:** Accepted

## Context

GitHub Actions jobs run in ephemeral VMs. When a multi-step script (validate → generate → review → auto-fix) is interrupted mid-run — by a runner timeout, billing cap, or transient API failure — there is no way to restart from the point of failure. The entire workflow restarts from step 1, re-paying the cost of completed LLM calls and risking duplicate side-effects (duplicate PR comments, duplicate labels).

## Decision

Introduce `scripts/lib/checkpoint.mjs` with two exported functions:

- `writeCheckpoint(runId, step, data)` — serialises `{ step, timestamp, data }` to `./checkpoints/<runId>/<step>.json`.
- `readCheckpoint(runId, step)` — deserialises the file; returns `null` if the file does not exist (first run).

Each script (`validate_issue.mjs`, `generate_issue_change.mjs`, `pr_review.mjs`, `auto_fix_pr.mjs`) calls `readCheckpoint` at the start of each logical step and skips the step (returning the cached result) if a checkpoint exists. On completion the step writes its output as a checkpoint.

The `./checkpoints/` directory is:
- Added to `.gitignore` (not committed).
- Uploaded as a GitHub Actions artifact (`actions/upload-artifact`) at the end of each job.
- Downloaded (`actions/download-artifact`) at the start of subsequent jobs in the same workflow run.

The `runId` is the GitHub Actions `github.run_id`, which is stable for retries of the same workflow run.

## Alternatives Considered

**GitHub Actions cache** — persists across runs (not just retries), which could cause stale state to bleed from one PR into another. Rejected.

**Encode state in PR labels** — works for simple flags but cannot carry structured data (LLM responses, file lists). Rejected.

**Re-run from scratch on every failure** — simplest but wastes quota and risks duplicate side-effects. Rejected for workflows beyond the MVP 2-step pipeline.

## Consequences

- ✅ A retried workflow run resumes from the last successful step, not from the beginning.
- ✅ LLM call results are not duplicated on retry; quota usage is bounded per logical step.
- ✅ The checkpoint library is pure Node.js (`fs/promises`) — no new runtime dependencies.
- ⚠️ Checkpoint files are scoped to a single `run_id`; a fresh workflow trigger starts with no checkpoints. This is intentional.
- ⚠️ If a step writes a checkpoint but its side-effect (e.g. PR comment) fails, the side-effect is skipped on resume. Scripts must write checkpoints only after all side-effects complete.
