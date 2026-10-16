# CLAUDE.md — autonomous-dev-loop

GitHub-native autonomous dev loop: **Issue → AI validation → Code generation → PR → AI review → Auto-fix loop → Human merge.**
Setup: `docs/code-generation.md` · Failure triage: `docs/runbook.md` · Tests: `docs/testing.md`.

## Rules

`AGENTS.md` is the single source of engineering rules for every agent (Codex and Claude Code); it is imported here, never restated:

@AGENTS.md

Procedures live in `.claude/skills/` and load on demand from their `description`: `edit-guardrails`, `test-protocol`, `changelog-gate`, `observability-contract`, `pr-review-workflow`, `new-adr`. Read the matching skill before the task it names (editing `scripts/` or `prompts/`, adding an ADR, answering review threads, …).

## Before pushing

Commands and the CI-gate checklist are in `AGENTS.md` → **Local Checks** (shared with Codex). On top of that, Claude Code has:

### Test gate (hooks in `.claude/settings.json`)

- **Stop** — at the end of each turn, `npm test` runs once if `scripts/`, `prompts/`, `config/`, `evals/` or `.github/workflows/` differ from the merge-base with `origin/main` (working tree or branch commits). A failure keeps the turn going with the failing tests.
- **PreToolUse `git push`** — tests `HEAD`, i.e. what is pushed: refused while those paths have uncommitted or untracked changes (commit or stash first), and while the committed change set has not passed.
- Results are cached per change set (`.claude/hooks/test-gate.mjs`): an unchanged set is never re-run, so iterating edits costs one suite run per turn, not one per edit.

## Toolbox — koydas/ai-dev-tools

`.claude/settings.json` declares the `ai-dev-tools` plugin (trust the folder → install offered). Useful here:

| Need | Command |
|---|---|
| Evidence-grounded review of a PR, posted on the PR | `/ai-dev-tools:pr-review <n>` |
| Apply the fixes of that review and of human PR comments (blocking, then in-scope non-blocking and nits; bots ignored) | `/ai-dev-tools:pr-fixer` |
| Interactive issue → patch (human-gated alternative to the `ready-for-dev` pipeline) | `/ai-dev-tools:issue-code-generation <n> [--strict]` |
| Check a branch against an issue's acceptance criteria | `/ai-dev-tools:ac-check <n>` |

Its reviewer discovers checks from `CLAUDE.md`/`AGENTS.md` and `.github/workflows/`: the **Local Checks** table is the list it runs. Repo rules win over toolbox defaults — after fixing review threads, follow `pr-review-workflow` (`@Codex review` only when code changed).

## Cloud sessions (claude.ai/code)

- Repository-declared plugins are not installed in cloud sessions. To get the toolbox, add to the environment's setup script:
  `git clone --depth 1 https://github.com/koydas/ai-dev-tools "$HOME/ai-dev-tools" && node "$HOME/ai-dev-tools/scripts/sync-claude.mjs"` — commands are then un-prefixed (`/pr-review`).
- `gh` is not authenticated: use the GitHub MCP tools for PRs, reviews and comments; `gh api` REST calls go through the proxy.
- A session with several repositories reads no hooks or permissions from this file: run the **Local Checks** list by hand.
