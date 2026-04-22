# autonomous-dev-loop

A fully autonomous GitHub-native dev loop: Issue → AI coder → PR → AI reviewer → iterative loop → human merge gate.

## MVP Automation Implemented

The MVP issue-to-PR automation is now implemented (Groq-backed).

- Workflow: `.github/workflows/ai-issue-to-pr.yml` (kept minimal/orchestration-only)
- Generator script: `scripts/generate_issue_change.mjs`
- Generator modules: `scripts/lib/*.mjs`
- Prompt files: `prompts/*.md` (one file per prompt, loaded at runtime)
- Setup and testing guide: `docs/ai-issue-to-pr.md`
- MVP definition: `docs/mvp.md`

See `docs/ai-issue-to-pr.md` for required Groq secret, recommended PR token (`AI_PR_TOKEN`), optional variables, label configuration, end-to-end test steps, and risk/mitigation notes.


## Tests

The core Node.js modules are covered by unit tests using the built-in `node:test` runner (no extra dependencies).

```bash
npm test
```

- Test files: `scripts/tests/*.test.mjs` (includes prompt file tests)
- CI: `.github/workflows/test.yml` runs on every push/PR
- Guide: `docs/testing.md`

## Architecture Decisions

- ADR index: `docs/adr/README.md`
