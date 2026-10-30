# Contributing

## Prerequisites

- Node.js 20+
- An `ANTHROPIC_API_KEY` (default provider) or `GROQ_API_KEY` (set `AI_PROVIDER=groq`) for manual end-to-end testing

## Running Tests

```bash
node --test scripts/tests/*.test.mjs
```

All tests use the built-in `node:test` runner — no install needed. Tests must pass before committing any change to `scripts/` or `prompts/`.

## Repository Layout

```
scripts/          Node.js entrypoint scripts and shared lib modules
scripts/tests/    Unit tests (*.test.mjs)
prompts/          AI prompt templates loaded at runtime
config/           Model and pipeline configuration
.github/          Workflows and issue templates
docs/             Setup guides and architecture decisions (ADRs)
```

## Workflow

1. Pick or open an issue.
2. Create a branch: `git checkout -b your-branch`.
3. Make changes — keep them small and MVP-focused (see `AGENTS.md`).
4. Run `node --test scripts/tests/*.test.mjs` and fix any failures.
5. Open a pull request against `main`.

## Key Conventions

- **Business logic in `scripts/lib/`**, not in workflow YAML or entrypoint scripts.
- **Prompts in `prompts/`** as `.md` files, one per prompt.
- **No external runtime dependencies** — use Node.js built-ins only.
- **Secrets via GitHub Actions** — never hardcode credentials.
- Document major architectural choices in `docs/adr/` as numbered ADR files.

See `AGENTS.md` for the full engineering rules and `docs/testing.md` for test conventions.

## Changelog Policy

Add a changelog fragment whenever your PR modifies:

- **Entrypoint scripts** — any `scripts/*.mjs` file (not `scripts/lib/` or `scripts/tests/`)
- **ADR files** — any `docs/adr/NNNN-*.md` record
- **What other repositories depend on (ADR-0045)** — `.github/workflows/adl-*.yml`, `templates/consumer/*.yml` and `docs/workflow-interface.json`; a change that a caller can notice says so in the fragment bullet, and the release operator lists it under `### Breaking` (see `docs/releasing.md`)

The fragment is a new file `changes/<issue-number>-<slug>.md` (lowercase kebab-case slug, unique to the PR: two PRs for the same issue use two slugs), with exactly one category heading and at least one bullet:

```
### Added | Changed | Fixed | Removed
- Brief description of the behavior change (ADR-XXXX or PR #NNN)
```

Never edit root `CHANGELOG.md` in a feature PR: the release operator assembles it from the fragments (`node scripts/assemble_changelog.mjs`, `docs/releasing.md`). A PR that changes one of the files above but needs no note puts the line `No-Changelog: true` in its description.

A CI job (`changelog-check.yml`) enforces this on every PR, and again when the description is edited: it fails when `CHANGELOG.md` is modified (except by a release change: `CHANGELOG.md` plus deleted fragments only), when a fragment is malformed, or when a trigger file changed with neither a fragment nor the exemption line.
