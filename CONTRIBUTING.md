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
