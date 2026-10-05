# ADR-0021: Protected write-path denylist for AI-generated changes

- **Date:** 2026-09-29
- **Status:** Accepted

## Context

ADR-0003 constrains AI output to at most 6 *safe relative* paths (no absolute paths, no `..`). Any other path in the repository could be written, including:

- `.github/workflows/*` — run on `push` with `AI_PR_TOKEN` and the LLM API secrets.
- `scripts/*`, `prompts/*`, `config/*` — `pr-review.yml` (on `push`) and `auto-fix-pr.yml` check out the PR branch and execute *that branch's* `scripts/*.mjs`, with *that branch's* prompts and config, holding the same secrets.
- `package.json` and lock files — control what gets installed and executed.
- `.git/` — git metadata executes code: a written `.git/config` with `core.fsmonitor` (or `core.hooksPath`, filter drivers) runs a command on the next `git add -A` / `git commit` in the auto-fix job, whose checkout holds `AI_PR_TOKEN`.
- `.npmrc` / `.yarnrc*` — `test.yml` runs `npx --yes c8` in the PR checkout (no `permissions:` block, so the default token applies); a registry override makes that download attacker code.
- `checkpoints/`, `metrics/`, `observability/` — gitignored or unstaged, but they are pipeline **state read back from the same working tree** the model writes to. `auto-fix-pr.yml` uploads `./checkpoints` as the next stage's artifact (a forged `review.json` satisfies the prerequisite check), and its "Commit metrics" step PUTs every line of `metrics/runs.jsonl` past the baseline **to the default branch** through the Contents API, after `git reset HEAD -- metrics/` has only kept the file out of the PR commit.

The prompt-injection path is: attacker-controlled issue body → code generation (or review feedback → auto-fix) → model writes one of these paths → the modified file runs with repository secrets on the next push. Prompt-level instructions are not a boundary; the check must be in code.

## Decision

`scripts/lib/output_writer.mjs` exports `PROTECTED_WRITE_PATHS` (frozen) and `validateSingleChange()` rejects any `target_path` matching it, failing the whole batch (same fail-fast behavior as ADR-0003):

| Entry | Match |
|---|---|
| `.git/` | any path **segment** equal to `.git` (root or nested repository metadata) |
| `.github/`, `scripts/`, `config/`, `prompts/` | root-level prefix, or the bare directory name |
| `checkpoints/`, `metrics/`, `observability/` | root-level prefix, or the bare directory name |
| `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml` | file name at **any** depth (workspace manifests and nested rc files are install surface too) |

The path is normalized before matching: backslashes → `/`, `path.posix.normalize` (collapses `//`, `.` segments), leading `./` stripped, then lower-cased. `..` and absolute paths are still rejected earlier by the ADR-0003 check. The returned `targetPath` is unchanged for accepted paths.

Because validation works on the path string, `writeGeneratedFiles()` also resolves the real path before writing: it refuses a write whose nearest existing parent directory resolves (through a symlink already in the checkout) outside the repository or into `.git/`, and refuses to overwrite a file that is itself a symlink.

The check sits in `validateAiOutput()`, which is shared by code generation (`generate_issue_change.mjs`, `issue_generator.mjs`) and auto-fix (`auto_fix_pr.mjs`), so both write paths are covered.

## Alternatives Considered

- **Deny only `.github/`** — leaves `scripts/`/`prompts/` open, which are executed with the same secrets by `pr-review.yml` and `auto-fix-pr.yml`. Rejected.
- **Opt-in allowlist flag to re-enable protected paths** — any flag the pipeline can read is a bypass the injected model output cannot set, but an operator would leave it on for self-hosting, reopening the hole. Rejected for now.
- **Run workflow scripts from the trusted base ref (check out the PR branch only as data)** — the correct long-term fix that would allow un-denying `scripts/`/`prompts/`/`config/`, but a larger workflow redesign. Deferred (see Consequences).
- **Prompt-only rule** — not a security boundary. Rejected.

## Consequences

- ✅ An injected issue body can no longer land a modified workflow, pipeline script, prompt, config, dependency manifest or registry config via the AI write path, nor forge checkpoint/metrics state (including the metrics PUT to the default branch).
- ✅ Single exported constant; one place to audit.
- ⚠️ **The pipeline can no longer modify its own code.** (ADR-0023 now runs pipeline code from the default branch, which removes the execution risk; un-denying `scripts/`, `prompts/`, `config/` is a separate decision.) Past self-hosted `[AI]` PRs (#149, #133, #119, #117, #112, #110, #105, #101) all wrote `scripts/`; equivalent issues now fail at validation and must be implemented by a human. Re-enabling this requires executing workflow scripts from the base ref first.
- ⚠️ Target repositories that keep application code under `scripts/`, `config/`, `prompts/`, `metrics/` or `observability/` at the root are affected the same way.
- ✅ Structural fix for the metrics path: the scripts append to `METRICS_FILE=$RUNNER_TEMP/pipeline-metrics.jsonl` (outside the checkout) and "Commit metrics" uploads only that file's lines, so no working-tree `metrics/runs.jsonl` is ever read back. `workflow_gates.test.mjs` enforces it; the `metrics/` denylist entry stays as defense in depth.
- ✅ `generation-system.md` and `auto-fix-system.md` list every protected path as a hard guardrail; `smoke.test.mjs` fails if either prompt misses an entry of `PROTECTED_WRITE_PATHS`, so the prompt cannot drift from the enforced list.
- ⚠️ Case-insensitive matching also blocks e.g. `Scripts/` on case-sensitive filesystems (intentional: avoids collisions on case-insensitive checkouts).

## Amendment (2026-10-05): documentation is human-owned, and destructive rewrites are rejected in code

On #173, auto-fix attempt 2 answered a review finding about missing coverage by replacing `README.md` (145 lines) with a 9-line stub (`# Project Title … (existing content above unchanged)`). This is the ADR-0009 failure mode again: the "never rewrite more than 30% of a file" rule was a prompt guardrail only, and `README.md` was writable.

- **Denylist.** `docs/` (root-level prefix) and `README.md` (file name at any depth) are added to `PROTECTED_WRITE_PATHS`. They apply to both code generation and auto-fix. Matching now lower-cases each entry as well as the path, so `README.md`, `readme.MD` and `packages/app/README.md` are all rejected.
- **Shrink guard.** `writeGeneratedFiles()` checks every change before writing any. It rejects the whole patch when a change would cut an existing file of `SHRINK_GUARD_MIN_LINES` (20) lines or more to fewer than `SHRINK_GUARD_MAX_RATIO` (50%) of its lines (`isDestructiveShrink()`). Smaller files are exempt. No file of the batch is written, so a rejected rewrite never leaves a partial patch.
- Both system prompts list the new entries (enforced by `smoke.test.mjs`) and state the shrink rule.

Alternatives considered:
- **Deny docs to auto-fix only** (a stage-specific list): keeps documentation issues automatable, but leaves code generation free to damage `README.md` from an injected issue body. The maintainer chose the global rule.
- **Shrink guard alone**: covers the incident's shape, but still lets the model rewrite documentation within the 50% bound.

Consequences:
- ✅ Neither stage can rewrite the project's documentation, and no stage can replace a large file with a stub.
- ⚠️ **Documentation issues can no longer be automated.** An issue that only targets `README.md` or `docs/` (for example the `valid-docs-diagram` eval case) passes validation, then fails at generation with a `protected path` error. The issue validator does not know the denylist.
- ⚠️ A legitimate refactor that deletes more than half of a large file is rejected. It must be done by a human or split.

