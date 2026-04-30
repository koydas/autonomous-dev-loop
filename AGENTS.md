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
- The suite includes **unit tests** (modules in isolation) and **smoke tests** (`smoke.test.mjs`, cross-module pipelines with real config/prompt files). Both must pass.

## Workflow Rules _(pipeline only)_

- Issue automation triggers automatically when the validation agent applies the `ready-for-dev` label.
- Branch naming must follow `ai/issue-<number>`.
- PR descriptions should include `Closes #<issue_number>`.
- Do not implement auto-merge in MVP.

## Auto-Fix Rules _(pipeline only)_

- The auto-fix workflow (`auto-fix-pr.yml`) is label-driven: it triggers on `pull_request` `labeled` events and runs when the applied label matches `review.changes.name` from `config/labels.yaml` (default `changes-requested`).
- The maximum number of auto-fix attempts per PR is **3**, tracked via `auto-fix-attempt-N` labels on the PR.
- When the attempt limit is reached, the workflow posts a comment and exits without making any changes.
- Auto-fix commits use the message format `fix(ai): auto-fix attempt N`.
- Auto-fix only addresses issues explicitly named in the review feedback. It does not make speculative improvements.

## Documentation Rules

- Update `docs/code-generation.md` when workflow inputs, setup requirements, or pipeline behavior change.
- Record major architectural decisions in `docs/adr/` as numbered ADR files.
