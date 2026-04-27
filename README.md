# autonomous-dev-loop

[![Tests](https://github.com/koydas/autonomous-dev-loop/actions/workflows/test.yml/badge.svg)](https://github.com/koydas/autonomous-dev-loop/actions/workflows/test.yml)

A fully autonomous GitHub-native dev loop: Issue → AI coder → PR → AI reviewer → iterative loop → human merge gate.

## MVP Automation Implemented

The MVP issue-to-PR automation is now implemented. The default AI provider is **Anthropic** (Claude); Groq is also supported via the `AI_PROVIDER` variable.

- Workflow: `.github/workflows/code-generation.yml` (kept minimal/orchestration-only)
- Generator script: `scripts/generate_issue_change.mjs`
- Generator modules: `scripts/lib/*.mjs`
- Prompt files: `prompts/*.md` (one file per prompt, loaded at runtime)
- Setup and testing guide: `docs/code-generation.md`
- MVP definition: `docs/mvp.md`

See `docs/code-generation.md` for required secrets (`ANTHROPIC_API_KEY` or `GROQ_API_KEY`), recommended PR token (`AI_PR_TOKEN`), optional variables, label configuration, end-to-end test steps, and risk/mitigation notes.

## Iterative Review Loop

Once a PR is opened, the automation continues:

1. **PR Review** (`.github/workflows/pr-review.yml`) — triggered on every push to the PR branch. Posts or updates a review comment and submits an `APPROVE` or `REQUEST_CHANGES` verdict.
2. **Auto-Fix** (`.github/workflows/auto-fix-pr.yml`) — triggered when a review requests changes. Reads the review feedback, generates targeted fixes using the LLM, and pushes them back to the PR branch — re-triggering the review.

The loop runs up to **3 auto-fix iterations** per PR. After that, a comment is posted requesting manual intervention.


## Tests

The core Node.js modules are covered by unit tests using the built-in `node:test` runner (no extra dependencies).

```bash
node --test scripts/tests/*.test.mjs
```

- Test files: `scripts/tests/*.test.mjs` (includes prompt file tests)
- CI: `.github/workflows/test.yml` runs on every push/PR
- Guide: `docs/testing.md`

## Architecture Decisions

- ADR index: `docs/adr/README.md`
