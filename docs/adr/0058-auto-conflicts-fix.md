# ADR-0058: Auto conflicts-fix: a PR that conflicts with its base is merged forward, by escalating resolvers

- **Date:** 2026-10-25
- **Status:** Accepted

## Context

A PR that conflicts with its base is invisible to the loop. `pull_request` events run on the merge ref, which does not exist while the PR is `dirty`, so review, CI and auto-fix go silent; the only trace was a runbook line (branch `ai/issue-<N>` with conflicts: delete it by hand, re-apply `ready-for-dev`). The commonest causes are structural, not semantic: two PRs append to `CHANGELOG.md` under `[Unreleased]`, two PRs take the same ADR number and add a line to `docs/adr/README.md`, a lockfile moves. Auto-fix on a stale base also produces a patch that no longer applies, so a conflict must be resolved **before** the review → auto-fix loop continues.

## Decision

**A. Detection** (`scripts/detect_conflicts.mjs`, job `detect`). Lists the open PRs and reads `mergeable_state` (REST only: no GraphQL, so [ADR-0011](./0011-graphql-rest-fallback.md)'s fallback does not apply). `dirty` is a conflict; `mergeable: null` / `unknown` is re-read a bounded number of times, then left to the next run (never read as clean, never as conflicting). Triggers (`conflicts-fix.yml`): a `push` to the default branch (a base move is how most conflicts are born; `pull_request` never fires on a conflicting PR), a schedule as a safety net, and `workflow_dispatch` with an optional `pr_number`. The label `merge-conflict` (`config/labels.yaml`, group `conflicts`) follows the state; a PR that is clean again also loses its `conflict-fix-attempt-N` labels.

**B. Scope: every open PR**, `ai/issue-*` and human branches alike, drafts included. A fork PR is fixed only when `maintainer_can_modify` is true (the job checks out and pushes to the head repository); otherwise it is labelled and told once per head, never skipped silently. A branch name outside `[A-Za-z0-9._/@+-]` is left to a human: it reaches a checkout and a concurrency key.

**C. Resolution is a ladder** (`scripts/lib/conflicts_engine.mjs`, `mergeForward`). The fix is a **merge of the base into the head** (`git merge`, never a rebase, amend or force-push), one commit `fix(ai): resolve merge conflicts with <base>@<sha7>`. Every rung is decided from the plan before anything is written; any refusal runs `git merge --abort` and escalates.

| Rung | Mechanism | Writes |
|---|---|---|
| L0 | `git merge` is clean (or a stale `dirty`: already up to date → skip) | none by us |
| L1 | `package-lock.json` only: take the PR's lockfile, `npm install --package-lock-only --ignore-scripts` on the merged manifest, env without token and with no user/global npm config; refused when the PR changes `.npmrc` (the registry would be the PR's choice) | derived |
| L2 | The model resolves the conflict **hunks** of at most 3 files (`conflicts` stage) | conflicted hunks only |
| L3 | `needs-human`, a comment naming files, reason and rules | none |

**D. L2 contract** (`scripts/lib/conflict_resolver.mjs`). The model returns resolved **hunks**, not whole files (the whole-file contract of [ADR-0029](./0029-autofix-deterministic-write-guard.md) would let a conflict serve as cover for rewriting the 95 % that does not conflict). The script splices them into the conflict blocks and touches nothing else. Conflict markers, file contents and hunks are **data**: never interpolated into a command, never logged (the record carries counts, rung and reason codes). A file whose hunks exceed the stage's input budget is escalated, never cut.

**E. Resolvers** (`planFile`, pinned and tested). `CHANGELOG.md`: every top-level entry of both sides kept, nothing invented. `docs/adr/README.md`: every line of both sides kept, nothing invented. `docs/adr/NNNN-*.md`: nothing invented. Any other path that is not protected: invented lines bounded (a merged import line is legitimate). **ADR number collision is mechanical, not a model decision**: when the merged tree holds a base ADR with the number of an ADR the PR adds, the PR's ADR takes the next free number (`planAdrRenumber`: file name, title and self references), and the lines the PR itself added elsewhere that cite the old number (the index line, a CHANGELOG entry) follow it (`renumberReferences`: exact-line match on what the PR added, so the base's own references keep theirs). The model only writes the index and CHANGELOG text the collision put in conflict; it never chooses a number, because the answer is a function of the base. This applies even when git sees no textual conflict.

**F. Guards, before the commit.**
- *Protected paths* ([ADR-0021](./0021-protected-write-path-denylist.md), [ADR-0044](./0044-protected-paths-floor-and-repo-config.md)): the base's own changes arrive in the merge commit as they are; that is not an AI write. What is guarded is **model-resolved** content. A conflict on a protected path is L2-eligible only through the named allowlist of E (`CHANGELOG.md`, `docs/adr/README.md`, `docs/adr/NNNN-*.md`; amends ADR-0021); every other protected conflicted file (`scripts/`, `config/`, `prompts/`, `.github/`, other `docs/`, manifests, any lockfile but the root `package-lock.json`) is L3.
- *Syntax*: `node --check` on a resolved `.js`/`.mjs`/`.cjs`, `JSON.parse` on `.json`; no conflict marker left in any resolved file.
- *Write guard* ([ADR-0029](./0029-autofix-deterministic-write-guard.md), [ADR-0019](./0019-static-verification-backstop.md)): mass deletion, test-count drop, module system, exported signature, unresolved import are checked on the result **against both sides**, and only a rule violated against both rejects it. Taking the base's own change is the merge doing its job; a resolution that loses what neither side loses is not.
- *Trusted execution* ([ADR-0023](./0023-trusted-pipeline-execution.md)): resolver code and prompts come from the pinned pipeline, the PR head is data; git runs with hooks disabled and an environment without token or key; the token reaches `git fetch`/`git push` only through `GIT_CONFIG_*` variables of that call, never in argv.

**G. Budget and loop interaction.**
- Own labels `conflict-fix-attempt-1..2` (cap 2), separate from `auto-fix-attempt-N`: the review budget ([ADR-0034](./0034-review-fix-loop-converges.md)) is untouched. A test pins the label count to the cap.
- Circuit breaker, [ADR-0050](./0050-circuit-breaker-review-loop.md)'s shape: the signature (conflicted files + incoming side of the hunks) and its streak travel in a hidden marker at the end of the comment (`<!-- adl-conflicts head=… outcome=… sig=… streak=… -->`, trusted authors only). The same signature escalated twice in a row stops further runs with no model call. A manual `workflow_dispatch` with `pr_number` bypasses cap and breaker for one run.
- When `changes-requested` and a conflict coexist, the conflict goes first. The push uses `AI_PR_TOKEN` (a `GITHUB_TOKEN` push triggers no workflow) and changes the head, so `pr-review` runs on it ([ADR-0028](./0028-one-review-per-head-sha.md)). A merge that is clean but breaks CI is left to review/auto-fix, never reverted.
- The `fix` job runs one PR at a time on `pr-pipeline-<head ref>`, shared with pr-review, auto-fix and reset ([ADR-0020](./0020-per-pr-workflow-concurrency.md)), `cancel-in-progress: false`.
- A base change to `.github/workflows/` is not pushable without the `workflow` scope: the push failure is `workflow_scope`, an escalation with the reason named.

**H. Observability** ([ADR-0018](./0018-structured-observability.md), [ADR-0040](./0040-run-journal-and-public-run-record.md)). Stages `conflicts_detect` and `conflicts`; events in `docs/observability.md`; meta allowlisted: counts, rung, reason and rule codes, label names, URLs; never a file name, hunk, title or model text. Both jobs commit their run record; the dashboard reads them ([ADR-0043](./0043-diagnostic-observability-console.md) amendment: journey step, escalation explanation, `conflicts-unresolved` finding and lever); the `fix` run joins the PR's work item ([ADR-0041](./0041-end-to-end-work-item-tracing.md)).

**I. Delivered in one PR** (the author's decision): detection and label, L0, L1, L2 with the hunk contract, the allowlisted resolvers and the mechanical renumber, the guards, the breaker, the consumer template, tests, docs. Each rung stays a separate function with its own tests, so a rung can be disabled by removing its branch.

## Alternatives Considered

- **Rebase the head onto the base.** Rewrites someone else's branch history and invalidates their checkout. Rejected (repository convention).
- **Whole-file LLM output** (ADR-0029 shape). Rejected for hunks, see D.
- **The model chooses the ADR number.** Non-deterministic where the answer is a function of the base. Rejected for E.
- **Blanket exception for protected paths in conflict resolution.** Erases the human-owned `docs/` rule. Rejected for a named allowlist.
- **Guard against the head only.** A merge that legitimately takes the base's refactor of a file would be rejected as a mass deletion. Rejected for both sides.
- **Revert the merge commit if CI fails.** Reverts history on a shared branch and hides the cause. Rejected.
- **`pull_request` / `synchronize` as the trigger.** Never fires on a conflicting PR. Rejected as sole trigger.
- **Lockfiles of other package managers** (`yarn.lock`, `pnpm-lock.yaml`, NuGet, `uv.lock`). Each needs its own regeneration command and its own registry trust analysis. Out of scope: L3.

## Consequences

- ✅ Conflicts stop being silent: label, then a fix or a named reason on the PR.
- ✅ The common structural conflicts (changelog, ADR number, lockfile) are resolved with deterministic post-checks, not trust in the model; the ADR number is never the model's.
- ✅ Review budget unaffected; no history rewritten; no secret in a child process.
- ⚠️ **Semantic merge risk.** An L2 resolution can compile, pass review and still change behavior; the guards bound size and shape, not meaning. The human merge gate and CI remain the only semantic check. No eval suite measures the resolver yet (the ADR-0031 ratchet would apply to one): recorded real conflicts are the follow-up.
- ⚠️ A model now writes into `CHANGELOG.md` and `docs/adr/` (human-owned by ADR-0021) through a named allowlist: ADR-0021 is amended accordingly.
- ⚠️ The breaker's streak lives in a PR comment: a member (whose PAT posts the comments) can edit it. It is a cost control, not a security boundary; the cap by labels is the second bound.
- ⚠️ A sweep reads every open PR (cap 100 per run) and a fix is a PAT-authored commit; fork PRs without `maintainer_can_modify`, and any fork whose head the PAT cannot reach, end in a label and a comment.
- ⚠️ `mergeable_state` is asynchronous: a bounded re-read can still end on `unknown`, so a conflict may be detected one trigger late.
- ⚠️ L1 covers npm only; a conflict on any other lockfile is escalated.
