# Code Generation

## Overview

All scripts under `scripts/` must adhere to the following guidelines:

* Use Node.js built-ins only.
* No external runtime dependencies.
* Keep business logic in `scripts/lib/`, not in workflow YAML or entrypoint scripts.
* Prompts in `prompts/` as `.md` files, one per prompt.
* Secrets via GitHub Actions — never hardcode credentials.
* Unit tests present for new logic, with ≥80% coverage for all scripts, including new automation files beyond checkpoint.mjs.

## Unit Testing and Coverage

All new scripts must include unit tests and meet the ≥80% coverage threshold. This ensures that our automation logic is reliable and maintainable.

## Changelog Gate (`changelog-check.yml`)

Runs on every pull request. Calls `node scripts/check_changelog.mjs` to verify that:

1. If the PR touches any **entrypoint script** (`scripts/*.mjs`, top-level only) or any **ADR file** (`docs/adr/NNNN-*.md`), then `CHANGELOG.md` must also be modified.
2. The modification must include at least one added non-empty line inside the `## [Unreleased]` section (editing a historical entry or fixing a typo does not satisfy the gate).

The check is skipped automatically if neither entrypoints nor ADRs are in the diff. No secrets or LLM calls are required.

**Adding a changelog entry** (see `CONTRIBUTING.md § Changelog Policy`):
```markdown
## [Unreleased]

### Added | Changed | Fixed | Removed
- Brief description of the change (ADR-XXXX or PR #NNN)
```
