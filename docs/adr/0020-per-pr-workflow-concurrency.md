# ADR-0020: Per-PR/issue workflow concurrency groups

- **Date:** 2026-09-29
- **Status:** Accepted

## Context

The auto-fix attempt counter is derived from `auto-fix-attempt-N` labels read at run start, with no lock. Two `changes-requested` label events close together (e.g. a `push`-triggered and a `pull_request`-triggered review finishing seconds apart) start two `auto-fix-pr` runs that both read the same count, both call the LLM, both apply the same attempt label and both push to the PR branch. The same unguarded read-modify-write pattern exists for review labels/comments (`pr-review`), validation labels (`validate-issue`), PR creation (`code-generation`) and the manual counter reset (`reset-auto-fix`). No workflow declared `concurrency:`, so every run was fully parallel.

This is a trust-boundary change in the sense that it bounds how many LLM calls and pushes a single PR or issue can produce at once, independent of how events are emitted.

## Decision

Every workflow declares exactly one concurrency group, keyed per PR or issue. The three workflows that read and write a PR's review/attempt labels share **one** group per PR head branch, `pr-pipeline-<head ref>`; the others are prefixed with the workflow name:

| Workflow | Level | Group | `cancel-in-progress` |
|---|---|---|---|
| `pr-review.yml` | workflow | `pr-pipeline-` + `pull_request.head.ref \|\| ref_name` | `false` |
| `auto-fix-pr.yml` | job `auto-fix` | `pr-pipeline-` + `pull_request.head.ref \|\| needs.load-labels.outputs.head_ref` | `false` |
| `reset-auto-fix.yml` | job `reset` | `pr-pipeline-` + `needs.resolve.outputs.head_ref` | `false` |
| `code-generation.yml` | job `generate-pr` | `code-generation-` + `issue.number \|\| inputs.issue_number` | `false` |
| `validate-issue.yml` | workflow | `validate-issue-` + `issue.number` | `false` |
| `test.yml` | workflow | `event_name` + `pull_request.number \|\| ref` | `true` |
| `changelog-check.yml` | workflow | `pull_request.number` | `true` |

- **`cancel-in-progress: false`** on every workflow that pushes or mutates labels/comments: a run is never killed between its label write and its `git push`.
- **Job-level groups** for `auto-fix-pr` and `code-generation`: these workflows are triggered by *every* comment/label on the PR/issue and filter in the job `if:`. GitHub keeps at most one pending run per group and cancels the older pending one when a newer run enters; with a workflow-level group an unrelated comment (e.g. the review bot's own comment) would displace the pending real auto-fix run. At job level, runs whose `if:` is false are skipped before they enter the group.
- **Shared `pr-pipeline-<head ref>` group for review, auto-fix and reset.** Separate per-workflow groups still let `pr-review` judge commit N while `auto-fix` pushes N+1 (a stale verdict re-labels and burns an attempt on outdated feedback), and let `reset-auto-fix` clear attempt labels between an auto-fix run's count read and its label write. The key is the head branch because `pr-review`'s `push` trigger carries no PR number and the `concurrency` expression cannot call the API. `issue_comment` payloads carry no head ref either, so `auto-fix-pr`'s `load-labels` job resolves it (`gh api` on `issue.pull_request.url`) and the group is job-level; `reset-auto-fix` gets a `resolve` job for the same reason. There is no deadlock: no run waits on another run inside a job (auto-fix's push only *enqueues* `pr-review`).
- Read-only workflows (`test`, `changelog-check`) cancel superseded runs; `test.yml` includes `event_name` so the `push` and `pull_request` runs for the same commit do not cancel each other.

`scripts/tests/workflow_gates.test.mjs` asserts the presence, keying, cancel policy and job-level placement.

## Alternatives Considered

- **Label-based lock / compare-and-swap on the attempt label** — GitHub labels have no atomic create-if-absent on an issue; would need extra API round-trips and still race.
- **Workflow-level groups everywhere** — simpler, but loses real auto-fix/code-gen runs to pending-slot replacement by unrelated comment/label events (see above).
- **Separate per-workflow groups** (this ADR's first version) — leaves the review/auto-fix and reset/auto-fix races above. Superseded.
- **Shared group keyed by PR number (`pr-<N>`)** — `pr-review`'s `push` event cannot compute the number in the expression without restructuring the workflow into a resolve job plus a gated job. Rejected in favor of the head ref, which every event has or can resolve.

## Consequences

- ✅ At most one of review / auto-fix / reset executes per PR at a time: the attempt counter read and the review verdict are never interleaved with another stage's writes.
- ✅ No push or label write is interrupted mid-run.
- ⚠️ Runs waiting on a group have status `pending` (not `queued`); `pr_review.mjs`'s `hasActiveAutoFixRun()` checks `pending` too, so it does not re-pulse the label behind a queued auto-fix.
- ⚠️ GitHub keeps only one *pending* run per group, now across three workflows: a newer pending run of any of them cancels the older pending one. In the normal loop runs alternate (review → label → auto-fix → push → review), so at most one is pending. A human push or label while a run is pending can displace it; the displacing run then acts on the newer state (latest wins), and a displaced review is re-triggered by the next push.
- ⚠️ If the head ref cannot be resolved (`gh api` failure), `load-labels` / `resolve` fails and the gated job does not run (fail closed); re-run the workflow.
- ⚠️ Two PRs with the same head branch name from different forks would share a group (serialized, not incorrect).
