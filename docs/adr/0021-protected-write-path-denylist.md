# ADR-0021: Protected write-path denylist for AI-generated changes

- **Date:** 2026-09-29
- **Status:** Accepted

## Context

ADR-0003 constrains AI output to at most 6 *safe relative* paths (no absolute paths, no `..`). Any other path in the repository could be written, including:

- `.github/workflows/*` — run on `push` with `AI_PR_TOKEN` and the LLM API secrets.
- `scripts/*`, `prompts/*`, `config/*` — `pr-review.yml` (on `push`) and `auto-fix-pr.yml` check out the PR branch and execute *that branch's* `scripts/*.mjs`, with *that branch's* prompts and config, holding the same secrets.
- `package.json` and lock files — control what gets installed and executed.
- `.npmrc` / `.yarnrc*` — `test.yml` runs `npx --yes c8` in the PR checkout (no `permissions:` block, so the default token applies); a registry override makes that download attacker code.
- `checkpoints/`, `metrics/`, `observability/` — gitignored or unstaged, but they are pipeline **state read back from the same working tree** the model writes to. `auto-fix-pr.yml` uploads `./checkpoints` as the next stage's artifact (a forged `review.json` satisfies the prerequisite check), and its "Commit metrics" step PUTs every line of `metrics/runs.jsonl` past the baseline **to the default branch** through the Contents API, after `git reset HEAD -- metrics/` has only kept the file out of the PR commit.

The prompt-injection path is: attacker-controlled issue body → code generation (or review feedback → auto-fix) → model writes one of these paths → the modified file runs with repository secrets on the next push. Prompt-level instructions are not a boundary; the check must be in code.

## Decision

`scripts/lib/output_writer.mjs` exports `PROTECTED_WRITE_PATHS` (frozen) and `validateSingleChange()` rejects any `target_path` matching it, failing the whole batch (same fail-fast behavior as ADR-0003):

| Entry | Match |
|---|---|
| `.github/`, `scripts/`, `config/`, `prompts/` | root-level prefix, or the bare directory name |
| `checkpoints/`, `metrics/`, `observability/` | root-level prefix, or the bare directory name |
| `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `.npmrc`, `.yarnrc`, `.yarnrc.yml` | file name at **any** depth (workspace manifests and nested rc files are install surface too) |

The path is normalized before matching: backslashes → `/`, `path.posix.normalize` (collapses `//`, `.` segments), leading `./` stripped, then lower-cased. `..` and absolute paths are still rejected earlier by the ADR-0003 check. The returned `targetPath` is unchanged for accepted paths.

The check sits in `validateAiOutput()`, which is shared by code generation (`generate_issue_change.mjs`, `issue_generator.mjs`) and auto-fix (`auto_fix_pr.mjs`), so both write paths are covered.

## Alternatives Considered

- **Deny only `.github/`** — leaves `scripts/`/`prompts/` open, which are executed with the same secrets by `pr-review.yml` and `auto-fix-pr.yml`. Rejected.
- **Opt-in allowlist flag to re-enable protected paths** — any flag the pipeline can read is a bypass the injected model output cannot set, but an operator would leave it on for self-hosting, reopening the hole. Rejected for now.
- **Run workflow scripts from the trusted base ref (check out the PR branch only as data)** — the correct long-term fix that would allow un-denying `scripts/`/`prompts/`/`config/`, but a larger workflow redesign. Deferred (see Consequences).
- **Prompt-only rule** — not a security boundary. Rejected.

## Consequences

- ✅ An injected issue body can no longer land a modified workflow, pipeline script, prompt, config, dependency manifest or registry config via the AI write path, nor forge checkpoint/metrics state (including the metrics PUT to the default branch).
- ✅ Single exported constant; one place to audit.
- ⚠️ **The pipeline can no longer modify its own code.** Past self-hosted `[AI]` PRs (#149, #133, #119, #117, #112, #110, #105, #101) all wrote `scripts/`; equivalent issues now fail at validation and must be implemented by a human. Re-enabling this requires executing workflow scripts from the base ref first.
- ⚠️ Target repositories that keep application code under `scripts/`, `config/`, `prompts/`, `metrics/` or `observability/` at the root are affected the same way.
- ⚠️ The denylist protects the AI write path only. The "Commit metrics" steps still trust whatever `metrics/runs.jsonl` holds in the working tree; any other writer to that tree (e.g. a future step) would reopen the path. Moving metrics out of the checkout (e.g. writing to `$RUNNER_TEMP`) is the structural fix.
- ✅ `generation-system.md` and `auto-fix-system.md` list every protected path as a hard guardrail; `smoke.test.mjs` fails if either prompt misses an entry of `PROTECTED_WRITE_PATHS`, so the prompt cannot drift from the enforced list.
- ⚠️ Case-insensitive matching also blocks e.g. `Scripts/` on case-sensitive filesystems (intentional: avoids collisions on case-insensitive checkouts).
