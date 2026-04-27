# AGENTS Guidelines

This file provides working conventions for AI agents contributing to this repository.

Two distinct agent types operate here:
- **Interactive agents** (e.g. Claude Code): assist developers directly on the codebase.
- **Pipeline agent**: the automated `code-generation` workflow that generates file changes from issues.

Rules marked _(pipeline only)_ apply exclusively to the automated pipeline. All other rules apply to both.

## Scope

These instructions apply to the entire repository.

## Objectives

- Keep changes MVP-focused and small.
- Prefer safe, deterministic behavior over broad automation.
- Fail fast on external API errors; never open PRs on failed generation.

## Engineering Rules

- Keep workflow YAML files dumb: orchestration only, business logic in Node.js scripts/modules.
- Use Node.js for helper scripts and automation utilities.
- Avoid multi-file refactors unless explicitly requested.
- Keep generated output constrained to predictable locations.
- Use repository secrets/variables for all external credentials/configuration.

## Validation

Before committing any change to `scripts/` or `prompts/`:

- Run `node --test scripts/tests/*.test.mjs` and ensure all tests pass.
- Never commit code that breaks an existing test without updating or replacing the test intentionally.

## Workflow Rules _(pipeline only)_

- Issue automation triggers automatically when the validation agent applies the `ready-for-dev` label.
- Branch naming must follow `ai/issue-<number>`.
- PR descriptions should include `Closes #<issue_number>`.
- Do not implement auto-merge in MVP.

## Documentation Rules

- Update `docs/code-generation.md` when workflow inputs or setup requirements change.
- Record major architectural decisions in `docs/adr/` as numbered ADR files.
