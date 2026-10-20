# ADR-0007: PR Review Trigger Strategy

- **Date:** 2026-04-29
- **Status:** Amended 2026-04-30, 2026-10-20 (least-privilege tokens)

## Context

The PR review workflow (`pr-review.yml`) must fire after every push to a PR branch so the automated review loop can run promptly. The choice of trigger has meaningful consequences for event semantics, permissions, and guard logic.

Two candidate trigger strategies were considered:

1. **`push` to all branches (`branches: ["**"]`)** — fires on every push regardless of PR state; the script resolves the PR number via the GitHub API and exits silently when no open PR exists for the branch.
2. **`pull_request` with `synchronize`/`opened` activity types** — fires only for pushes that are already associated with an open PR; the PR number and diff URL are available directly from the event payload.

## Decision

Use a `push` trigger on `branches: ["**"]` combined with a `pull_request: [opened]` trigger.

The `push` trigger alone was insufficient because of a GitHub security rule: when a workflow pushes using `GITHUB_TOKEN`, the resulting push event does not trigger other workflows. The `code-generation.yml` workflow falls back to `GITHUB_TOKEN` when `AI_PR_TOKEN` is not configured, which means `pr-review.yml` never fires on the initial push from `peter-evans/create-pull-request`. Even when a PAT is used, there is a race window where `pr_review.mjs` queries for an open PR before GitHub has finished indexing it.

Adding `pull_request: [opened]` closes both gaps:

- When `code-generation.yml` (or any workflow) opens a PR, the `opened` event fires unconditionally regardless of the token used for the push.
- The event payload carries `pull_request.number` directly, so `pr_review.mjs` reads it at line 42 without a GitHub API lookup — eliminating the race condition.
- The `push` trigger is retained to cover all subsequent pushes to the branch (auto-fix commits, manual fixups) where a PR already exists.

The `pull_request: synchronize` type is intentionally omitted: subsequent pushes are already covered by the `push` trigger, and adding `synchronize` would cause duplicate review runs on every auto-fix commit.

## Guardrails

- The script checks for an open PR at the beginning of each `push`-triggered run. If none is found for the pushed branch, it exits immediately without calling the LLM or writing any output.
- On `pull_request: opened` runs, `pull_request.number` is read directly from the payload; no API lookup is needed.
- The `timeout-minutes: 2` job constraint prevents runaway executions on branches with large diffs or slow API responses.
- The `actions: read` permission is the minimum required to query run status for the re-pulse guard (ADR-0006), and no broader permissions are granted.

## Consequences

- ✅ Review fires on PR open regardless of which token was used to push (`GITHUB_TOKEN` or PAT).
- ✅ Review fires on every subsequent push (auto-fix commits, manual fixups) via the `push` trigger.
- ✅ No race condition between push and PR indexing: `opened` event carries the PR number directly.
- ⚠️ When `AI_PR_TOKEN` is configured and the push succeeds in triggering `pr-review.yml`, the `opened` event will also fire — resulting in two concurrent review runs on the very first commit. Both runs are safe (idempotent comment upsert, label swap); the mild redundancy is accepted.
- ⚠️ Pushes to branches with no open PR (e.g., direct commits to `main`) will invoke the workflow but exit immediately after a single API call — a minor, accepted overhead.

## Amendment (2026-10-20): least-privilege tokens per job (audit F14, F15)

**Context.** The 2026-10-19 cross-cutting audit found the guardrail above ("`actions: read` is the minimum … no broader permissions are granted") contradicted by the code. `pr-review.yml` granted `contents`, `issues`, `pull-requests` and `actions: write` at workflow level, while its only Actions calls are reads (`gh run list`, the auto-fix run check in `pr_review.mjs`, a cross-run artifact download). `auto-fix-pr.yml` and `code-generation.yml` gave `actions: write` to both jobs, including `load-labels`, which runs on every label or comment event and only reads config (F15). Checkouts in `validate-issue.yml`, `code-generation.yml` and `reset-auto-fix.yml` persisted the token although no step there runs `git push`. Separately, `pr-review.yml` expanded `github.ref_name` and `github.event.pull_request.head.ref` straight into `run:` shell source; a ref name may contain `$(`, `;` or backticks (F14).

**Decision.**

1. **Permissions per job.** Every pipeline workflow declares `permissions: contents: read` at workflow level and grants scopes per job, derived from the calls that job makes with `GITHUB_TOKEN` (inventory in the PR that made this change):

   | Workflow | Job | Scopes |
   |---|---|---|
   | `pr-review.yml` | `evidence` | `contents: read` |
   | | `review` | `contents: write` (`metrics` branch), `pull-requests: write` (review), `issues: write` (labels, comment), `actions: read` |
   | `auto-fix-pr.yml` | `load-labels` | `contents: read`, `pull-requests: read` |
   | | `auto-fix` | `contents: write` (push, `metrics`), `pull-requests: write` (kept, see below), `issues: write`, `actions: read` |
   | `code-generation.yml` | `load-labels` | `contents: read` |
   | | `generate-pr` | `contents: write`, `pull-requests: write` (create-pull-request), `issues: write`, `actions: read` |
   | `validate-issue.yml` | `validate` | `contents: write` (`metrics`), `issues: write`, `actions: write` (dispatch) |
   | `reset-auto-fix.yml` | `resolve` | `pull-requests: read` |
   | | `reset` | `contents: write` (`metrics`), `issues: write`, `pull-requests: write` (kept) |

   A call made with `AI_PR_TOKEN || GITHUB_TOKEN` still counts against `GITHUB_TOKEN`: the fallback runs when the secret is unset. `pull-requests: write` on the label-only jobs (`auto-fix`, `reset`) is kept until checked that `issues: write` alone covers labels and comments on a PR with this token.
2. **No `actions: write`.** Listing runs and downloading artifacts need `actions: read`. The one exception is `validate-issue.yml`, whose `gh workflow run code-generation.yml` (a dispatch) needs `actions: write`.
3. **No write scope at workflow level in a multi-job workflow.** A job that only reads (`load-labels`, `resolve`, `evidence`) must not inherit the write token of its sibling.
4. **`persist-credentials: false`** on every checkout of a job that never runs `git push`. `auto-fix-pr.yml` keeps the credential of its PR-branch checkout (`AI_PR_TOKEN || GITHUB_TOKEN`): its push step needs it. `create-pull-request` sets its own token for its push.
5. **Event values reach shell through `env:`.** A `run:` script never contains a `${{ }}` expression carrying a ref name, title, body or comment text; the step passes it in `env:` and the script reads the quoted variable (`"$BRANCH"`).

`scripts/tests/workflow_gates.test.mjs` enforces 2–5 and pins the table.

**Consequences.**

- ✅ A compromised or misbehaving read-only job (`load-labels` on any comment, `evidence` on PR code) holds no write token; no job can dispatch, re-run or cancel workflows except the validation dispatch.
- ✅ The guardrail of this ADR holds again, and is tested rather than stated.
- ⚠️ A new GitHub API call in a stage script needs its scope added to the job, or it fails with 403; the job's comment names what each scope is for.
- ⚠️ `pull-requests: write` on `auto-fix` and `reset` is kept by caution, not by need shown.
