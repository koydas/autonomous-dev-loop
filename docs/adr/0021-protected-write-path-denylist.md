# ADR-0021: Protected write-path denylist for AI-generated changes

- **Date:** 2026-09-29
- **Status:** Accepted

## Context

ADR-0003 constrains AI output to at most 6 *safe relative* paths (no absolute paths, no `..`). Any other path in the repository could be written, including:

- `.github/workflows/*` — run on `push` with `AI_PR_TOKEN` and the LLM API secrets.
- `scripts/*`, `prompts/*`, `config/*` — `pr-review.yml` (on `push`) and `auto-fix-pr.yml` check out the PR branch and execute *that branch's* `scripts/*.mjs`, with *that branch's* prompts and config, holding the same secrets.
- `package.json` and lock files — control what gets installed and executed.

The prompt-injection path is: attacker-controlled issue body → code generation (or review feedback → auto-fix) → model writes one of these paths → the modified file runs with repository secrets on the next push. Prompt-level instructions are not a boundary; the check must be in code.

## Decision

`scripts/lib/output_writer.mjs` exports `PROTECTED_WRITE_PATHS` (frozen) and `validateSingleChange()` rejects any `target_path` matching it, failing the whole batch (same fail-fast behavior as ADR-0003):

| Entry | Match |
|---|---|
| `.github/`, `scripts/`, `config/`, `prompts/` | root-level prefix, or the bare directory name |
| `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml` | file name at **any** depth (workspace manifests are install surface too) |

The path is normalized before matching: backslashes → `/`, `path.posix.normalize` (collapses `//`, `.` segments), leading `./` stripped, then lower-cased. `..` and absolute paths are still rejected earlier by the ADR-0003 check. The returned `targetPath` is unchanged for accepted paths.

The check sits in `validateAiOutput()`, which is shared by code generation (`generate_issue_change.mjs`, `issue_generator.mjs`) and auto-fix (`auto_fix_pr.mjs`), so both write paths are covered.

## Alternatives Considered

- **Deny only `.github/`** — leaves `scripts/`/`prompts/` open, which are executed with the same secrets by `pr-review.yml` and `auto-fix-pr.yml`. Rejected.
- **Opt-in allowlist flag to re-enable protected paths** — any flag the pipeline can read is a bypass the injected model output cannot set, but an operator would leave it on for self-hosting, reopening the hole. Rejected for now.
- **Run workflow scripts from the trusted base ref (check out the PR branch only as data)** — the correct long-term fix that would allow un-denying `scripts/`/`prompts/`/`config/`, but a larger workflow redesign. Deferred (see Consequences).
- **Prompt-only rule** — not a security boundary. Rejected.

## Consequences

- ✅ An injected issue body can no longer land a modified workflow, pipeline script, prompt, config or dependency manifest via the AI write path.
- ✅ Single exported constant; one place to audit.
- ⚠️ **The pipeline can no longer modify its own code.** Past self-hosted `[AI]` PRs (#149, #133, #119, #117, #112, #110, #105, #101) all wrote `scripts/`; equivalent issues now fail at validation and must be implemented by a human. Re-enabling this requires executing workflow scripts from the base ref first.
- ⚠️ Target repositories that keep application code under `scripts/`, `config/` or `prompts/` at the root are affected the same way.
- ⚠️ Generation/auto-fix prompts do not yet tell the model about the denylist, so such tasks fail at validation rather than being steered away earlier.
- ⚠️ Case-insensitive matching also blocks e.g. `Scripts/` on case-sensitive filesystems (intentional: avoids collisions on case-insensitive checkouts).
