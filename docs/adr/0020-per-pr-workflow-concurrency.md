# ADR-0020: Per-PR/issue workflow concurrency groups

- **Date:** 2026-09-29
- **Status:** Accepted

## Context

The auto-fix attempt counter is derived from `auto-fix-attempt-N` labels read at run start, with no lock. Two `changes-requested` label events close together (e.g. a `push`-triggered and a `pull_request`-triggered review finishing seconds apart) start two `auto-fix-pr` runs that both read the same count, both call the LLM, both apply the same attempt label and both push to the PR branch. The same unguarded read-modify-write pattern exists for review labels/comments (`pr-review`), validation labels (`validate-issue`), PR creation (`code-generation`) and the manual counter reset (`reset-auto-fix`). No workflow declared `concurrency:`, so every run was fully parallel.

This is a trust-boundary change in the sense that it bounds how many LLM calls and pushes a single PR or issue can produce at once, independent of how events are emitted.

## Decision

Every workflow declares exactly one concurrency group, keyed per PR or issue and prefixed with the workflow name:

| Workflow | Level | Group key | `cancel-in-progress` |
|---|---|---|---|
| `auto-fix-pr.yml` | job `auto-fix` | `pull_request.number \|\| issue.number` | `false` |
| `code-generation.yml` | job `generate-pr` | `issue.number \|\| inputs.issue_number` | `false` |
| `pr-review.yml` | workflow | `pull_request.head.ref \|\| ref_name` | `false` |
| `validate-issue.yml` | workflow | `issue.number` | `false` |
| `reset-auto-fix.yml` | workflow | `inputs.pr_number` | `false` |
| `test.yml` | workflow | `event_name` + `pull_request.number \|\| ref` | `true` |
| `changelog-check.yml` | workflow | `pull_request.number` | `true` |

- **`cancel-in-progress: false`** on every workflow that pushes or mutates labels/comments: a run is never killed between its label write and its `git push`.
- **Job-level groups** for `auto-fix-pr` and `code-generation`: these workflows are triggered by *every* comment/label on the PR/issue and filter in the job `if:`. GitHub keeps at most one pending run per group and cancels the older pending one when a newer run enters; with a workflow-level group an unrelated comment (e.g. the review bot's own comment) would displace the pending real auto-fix run. At job level, runs whose `if:` is false are skipped before they enter the group.
- **`pr-review` is keyed by head branch**, not PR number: its `push` trigger carries no PR number, and keying by branch makes `push` and `pull_request` events for the same PR share one group.
- Read-only workflows (`test`, `changelog-check`) cancel superseded runs; `test.yml` includes `event_name` so the `push` and `pull_request` runs for the same commit do not cancel each other.

`scripts/tests/workflow_gates.test.mjs` asserts the presence, keying, cancel policy and job-level placement.

## Alternatives Considered

- **Label-based lock / compare-and-swap on the attempt label** — GitHub labels have no atomic create-if-absent on an issue; would need extra API round-trips and still race.
- **Workflow-level groups everywhere** — simpler, but loses real auto-fix/code-gen runs to pending-slot replacement by unrelated comment/label events (see above).
- **Single cross-workflow group per PR (`pr-<N>`)** — would also serialize `pr-review` against `auto-fix-pr`, but `pr-review`'s `push` trigger cannot compute the PR number in the `concurrency` expression, and the one-pending-slot rule would let a review displace a queued auto-fix.

## Consequences

- ✅ At most one auto-fix run per PR executes at a time; the attempt counter read is no longer racy within `auto-fix-pr`.
- ✅ No push or label write is interrupted mid-run.
- ⚠️ GitHub keeps only one *pending* run per group: bursts collapse to "running + latest pending". For auto-fix this is the desired behavior (the latest review feedback wins).
- ⚠️ Groups are per workflow: `pr-review` and `auto-fix-pr` can still run concurrently on the same PR. Their writes are to different labels, and the auto-fix push re-triggers `pr-review` anyway.
- ⚠️ `reset-auto-fix` is not serialized against a running `auto-fix-pr`; resetting during an active run can still interleave with its label write.
