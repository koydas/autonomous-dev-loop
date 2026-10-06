# ADR-0030: Live evals of a PR's prompt change

- **Date:** 2026-10-06
- **Status:** Accepted

## Context

`eval-replay.yml` (ADR-0027 amendment, #179) replays the last live run published on the eval dashboard against a PR's code. It checks the parsers, `decideVerdict` and the scorers, but it serves the recorded responses again: **a prompt change is not measured**. The only way to measure one was to run `evals.yml` (`workflow_dispatch`) on the PR branch, which:

- runs the branch's `run_evals.mjs`, harness, suites and `config/models.yaml` with `GROQ_API_KEY` / `ANTHROPIC_API_KEY` in the environment, which ADR-0023 forbids for pipeline stages;
- gives no comparison with the published baseline in the PR, only a job summary;
- is slow: `review` ≈ 11–12 min per repeat and `validation` ≈ 4–6 min on the Groq free tier (8K TPM).

Running the live eval automatically on `pull_request` is not an option: the secrets would be exposed to the PR's code, and every push would spend TPM.

## Decision

New workflow `.github/workflows/pr-evals.yml`, logic in `scripts/lib/pr_evals.mjs` (entrypoints `scripts/plan_pr_evals.mjs`, `scripts/report_pr_evals.mjs`).

### 1. Trigger: a trusted human, never an automatic event

- `pull_request_target: types: [labeled]`, honored only for the `run-evals` label, or `workflow_dispatch` (`pr_number`, `repeats` 1 or 3) from the default branch.
- A `labeled` payload has no `author_association`, so the labeler's repository permission is read from `GET /repos/{repo}/collaborators/{sender}/permission`: `admin`, `maintain` or `write` is trusted. This is at least as strict as the OWNER/MEMBER/COLLABORATOR check of the `issue_comment` workflows: an org member without write access, or a triage-only collaborator, is refused. Unknown (API error) is refused.
- The PR head SHA at trigger time is pinned (`pull_request.head.sha`, or the API for a dispatch). A push between the trigger and the plan refuses the run ("set the label again").
- The label is removed after every run, whatever the outcome, so it never re-arms on its own.
- `repeats` is 1 for a label; 3 only through the dispatch.

**`pull_request_target`, not `pull_request`.** ADR-0023 rejected `pull_request_target` for `pr-review.yml` because of the pwn-request pattern (checking out and running head code with secrets). Here it is the safer event: with `pull_request`, a label on a same-repository PR runs the workflow YAML **from the PR's merge commit** with the secrets, so the PR could rewrite the job. With `pull_request_target`, the YAML comes from the default branch, and no job checks out the PR as a worktree.

### 2. Three jobs, three trust levels

| Job | Runs | Token | Secrets |
|---|---|---|---|
| `plan` | default-branch `plan_pr_evals.mjs plan` | `contents: read`, `pull-requests: read` | none |
| `eval` | default-branch `plan_pr_evals.mjs apply` + `run_evals.mjs` | `contents: read`, not persisted | LLM keys |
| `comment` | default-branch `report_pr_evals.mjs` | `contents: read`, `pull-requests: write`, not persisted | none |

- **plan** checks out the default branch with full history, fetches `refs/pull/<n>/head` as objects only, and lists the PR's changes from its merge base (`git diff --raw --no-renames`). It keeps `prompts/**` and refuses the PR when it also changes `scripts/` or `config/` (the run would measure code the PR does not contain, and the PR is the wrong unit for a mixed change), or when a prompt is not a regular file (symlink, submodule, type change) or has an unsafe path. Prompt contents are read as git blobs (`git show <sha>:<path>`, ≤ 64 KiB), never from a checkout, so a symlink cannot make the eval read a runner file. Other changed files (docs, datasets, `.github/`) are ignored and listed: the default branch's version is used. It writes `plan.json` (with the contents) as an artifact.
- **eval** checks out the default branch, re-validates `plan.json` (version, status, paths under `prompts/`, change types, sizes, no write through a symlink) and writes the PR's prompts over `prompts/`. Then the default branch's `run_evals.mjs` runs each suite: scripts, harness, suites, scorers, thresholds, `config/models.yaml` and datasets are all the default branch's. No PR code runs in the job holding the keys.
- **comment** never sees an LLM key. It downloads the artifacts, compares each results file with the last run published on the dashboard (`loadPublishedRuns`, `diffDataset`, `metricDeltas`, `verdictChanges`, `classifyGate` from `eval_replay_ci.mjs`), posts one PR comment (`<!-- adl-pr-evals -->`) and removes the label. Model-derived text in the comment (error strings) is escaped: no table break, no `@` mention, no HTML.

### 3. Suites from the prompts

`prompts/validation-*` → `validation`, `prompts/pr-review-*` → `review` (`SUITE_PROMPT_PREFIXES`, kept in sync with `SUITES` by a test). A PR changing only other prompts (`generation-*`, `auto-fix-*`) gets a "nothing to run" comment.

### 4. Comparison

Per suite: published vs PR value and Δ for `error_rate`, every `scores.*.mean`, `consistency` and per-class precision/recall/F1, the thresholds and the case × repeat whose outcome changed. Same rules as the replay gate: a threshold the published run meets and the PR run misses is ❌, one already missed is ⚠️, a changed dataset compares the common cases and makes thresholds advisory. A different model or repeat count is flagged (the Δ then mixes two causes). The comment is informational: the workflow's conclusion does not gate the merge.

### 5. Never published

No `--scorecard`, no `publish` job, no Pages permission: the dashboard records the default branch only.

## Alternatives Considered

- **`evals.yml` dispatched on the PR branch.** Runs the branch's harness and config with the secrets (ADR-0023), no comparison. Rejected.
- **`pull_request` + label gate.** The YAML comes from the PR: a same-repository PR could change the job that receives the secrets. Rejected.
- **`issue_comment` command (`/run-evals`).** Same trust properties (default-branch YAML, `author_association`), but a label is visible on the PR while armed and maps to "one label, one run". Kept as a possible addition.
- **Run on every PR touching `prompts/**`, with secrets.** Exposes the secrets to the PR's code and spends the shared 8K TPM on every push. Rejected.
- **Take `scripts/lib/` changes too (e.g. a prompt builder change).** Would run PR code with the secrets. Rejected: such a PR splits the prompt change out, or is measured after merge.

## Consequences

- ✅ A prompt change can be measured live before merge, with a Δ against the published baseline in the PR.
- ✅ The job holding the LLM keys runs default-branch code only; the PR contributes text files read as git blobs.
- ✅ The write token (comment, label) never shares a runner with the LLM keys.
- ⚠️ A prompt change that needs a code change (new placeholder, new parser rule) cannot be measured: the PR is refused when it touches `scripts/` or `config/`, and a prompt referencing a placeholder the default branch does not fill is measured as-is (unfilled).
- ⚠️ The PR's changed prompts replace the default branch's versions wholesale: if the default branch changed the same prompt since the PR's merge base, the comparison runs the PR's version without those changes. Rebase first.
- ⚠️ With `repeats: 1` and review sampling at temperature > 0, a Δ of one case is noise; `repeats: 3` costs ≈ 35 min for `review`.
- ⚠️ The published baseline may be on another model or dataset revision; the comment says so but cannot remove the confound.
- ⚠️ The prompt text sent to the provider is the PR's: a malicious prompt can make the model output anything, but the model has no tools, never sees a key, and only labels and escaped error strings reach the comment. The trusted labeler is the gate on spending TPM.
- ⚠️ The `plan` job keeps its read-only token persisted in `.git/config` to fetch `refs/pull/<n>/head` of a private repository; it executes default-branch code only and holds no secret.
