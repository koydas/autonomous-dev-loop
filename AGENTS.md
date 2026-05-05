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

## Models

Default Groq models (all stages): `qwen/qwen3-32b`. See `config/models.yaml` for per-stage overrides.
Default Anthropic model (all stages): `claude-opus-4-7`.
Context windows: Groq models cap at 32 768 tokens; Anthropic models at 200 000 tokens. `scripts/auto_fix_pr.mjs` maps known models in `MODEL_CONTEXT_WINDOW` — add new models there when switching.

## Engineering Rules

- Keep workflow YAML files dumb: orchestration only, business logic in Node.js scripts/modules.
- Use Node.js for helper scripts and automation utilities.
- Avoid multi-file refactors unless explicitly requested.
- Keep generated output constrained to predictable locations.
- Use repository secrets/variables for all external credentials/configuration.
- Keep startup validation fail-fast and deterministic: validate required env vars, prompt files, and payload shape before external API calls.
- Prefer explicit error messages that include missing field paths (for example `pull_request.number`, `choices[0].message.content`) rather than generic parse failures.

## Hard Guardrails

These apply to **all agents** (interactive and pipeline) whenever modifying existing files:

- **Test files**: never produce a test file with fewer test cases than the original. Preserve all existing tests; only add new ones or modify the specific case explicitly requested.
- **Module format**: never change a file's module system. `.mjs` files are always ESM — `import`/`export` only; `require()` is forbidden. `.cjs` or `require`-based files stay CJS.
- **Exported function signatures**: never rename, re-type parameters, or change the return type of an exported function unless the request explicitly targets that signature.
- **External dependencies**: never introduce an `import` or `require` for a package not already present in the file's existing imports or in `package.json`.
- **File rewrite scope**: if a single fix or feature requires replacing more than 30% of an existing file's lines, reduce scope to a targeted edit instead. Full rewrites are only acceptable for new files or when the request explicitly asks for a rewrite.

See [ADR-0009](docs/adr/0009-llm-agent-guardrails.md) for the incidents that motivated these rules.

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


## Review Hygiene (explicit)

For any change to workflow behavior (for example files under `.github/workflows/` or automation scripts under `scripts/`):

- **Documentation is mandatory in the same PR**: update `docs/code-generation.md` and/or `docs/runbook.md` whenever trigger conditions, rerun mechanics, labels, checkpoints, or operator steps change.
- **Tests are mandatory in the same PR**: add or update targeted tests that cover the new behavior (not only happy-path execution), in addition to running the full `node --test scripts/tests/*.test.mjs` suite.
- **No "code-only" automation behavior changes**: behavior updates without matching doc + test updates are considered incomplete.

## Documentation Rules

- Update `docs/code-generation.md` when workflow inputs, setup requirements, or pipeline behavior change.
- Record major architectural decisions in `docs/adr/` as numbered ADR files.
