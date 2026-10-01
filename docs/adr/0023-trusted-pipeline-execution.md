# ADR-0023: Execute pipeline code from the default branch

- **Date:** 2026-09-29
- **Status:** Accepted

## Context

`pr-review.yml` (on `push` to any branch) and `auto-fix-pr.yml` (on PR label / trusted comment) check out the PR branch and ran `node scripts/<stage>.mjs` from it, with `ANTHROPIC_API_KEY`, `GROQ_API_KEY` and `AI_PR_TOKEN` in the environment. `scripts/lib/prompts.mjs` and `scripts/lib/config.mjs` resolve `prompts/` and `config/` relative to the script file, so the branch also controlled the prompts and model config. Anyone able to push a branch, and any content that reached a branch through the AI write path, therefore executed with repository secrets. ADR-0021's denylist closed the AI write path but not branch pushes, and forced the pipeline to stop modifying its own code.

Two smaller exposures of the same kind:

- `auto-fix-pr.yml`'s `load-labels` job checked out the default ref of the event — for `pull_request`, the PR **merge ref** — and imported `./scripts/lib/yaml.mjs` from it, with the workflow's write-scoped `GITHUB_TOKEN` persisted in `.git/config`.
- `test.yml` and `changelog-check.yml` run PR code (tests, `npx c8`) with no `permissions:` block, i.e. whatever the repository's default token permissions are.

## Decision

1. **Code from the default branch, data from the PR branch.** In `pr-review.yml` and `auto-fix-pr.yml`, the PR branch is checked out at the workspace root as before (the diff, changed files, `package.json` and the generated-file writes all still operate on it). A second checkout of `github.event.repository.default_branch` into `.trusted-pipeline` with `persist-credentials: false` is moved to `$RUNNER_TEMP/pipeline`, and the stage runs as `node "$RUNNER_TEMP/pipeline/scripts/<stage>.mjs"`. Prompts and config come from the trusted copy (script-relative resolution); checkpoints, traces and generated files stay workspace-relative (cwd). Moving the copy out of the workspace keeps it out of `git add -A` in the auto-fix commit step (a nested checkout would be staged as a gitlink).
2. `load-labels` in `auto-fix-pr.yml` checks out the default branch with `persist-credentials: false`.
3. `pr-review.yml`'s PR-branch checkout no longer persists credentials (the job uses `gh` with an explicit token, never `git push`). `auto-fix-pr.yml` still persists `AI_PR_TOKEN` in its PR-branch checkout because it pushes; the pipeline code that runs there is now trusted.
4. `test.yml` and `changelog-check.yml` declare `permissions: contents: read` and use no secrets.

`scripts/tests/workflow_gates.test.mjs` enforces all four.

`code-generation.yml` and `validate-issue.yml` are unchanged: `issues` events and `workflow_dispatch --ref <default branch>` already run on the default branch.

## Alternatives Considered

- **`pull_request_target`** — runs the base workflow with secrets but is triggered by PR events only; `pr-review` also needs `push`, and the pattern is easy to misuse (checking out head code in it is the classic pwn-request). Rejected.
- **Separate `trusted/` and `pr/` workspace directories** — equivalent isolation, but every step would need `working-directory:` and path changes. Rejected for a larger diff with no added protection.
- **Keep branch execution, rely on the ADR-0021 denylist** — does not cover humans' or third parties' branch pushes. Rejected.

## Consequences

- ✅ A branch (human- or AI-authored) can no longer run its own scripts, prompts or model config with repository secrets.
- ✅ PRs that change `scripts/`, `prompts/` or `config/` are reviewed and auto-fixed by the *merged* pipeline, not by themselves; the existing self-modification guard for `scripts/auto_fix_pr.mjs` is now defense in depth.
- ✅ This is the precondition ADR-0021 named for letting the pipeline modify its own code again. Removing `scripts/`, `prompts/` and `config/` from `PROTECTED_WRITE_PATHS` is now possible but is a separate decision (the entries still stop injected content from landing in a PR a human might merge unread).
- ⚠️ A pipeline change takes effect only after it is merged to the default branch; a PR cannot test its own pipeline changes end to end in CI (unit and smoke tests still run from the branch in `test.yml`).
- ⚠️ If the default branch and a long-lived PR branch diverge in their checkpoint/label conventions, the merged pipeline operates on the PR with the merged conventions.
- ⚠️ The workflow YAML itself still comes from the branch for `push` events (GitHub behavior); `.github/` stays in the ADR-0021 denylist for that reason.
