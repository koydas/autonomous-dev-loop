---
name: test-protocol
description: Use when adding, changing or running tests, or after any change to scripts/ or prompts/: node:test only, test layout, no test shrinkage, failure-branch coverage for new scripts/lib exports, unit plus smoke layers.
---

# test-protocol

## When to Apply

Any time you add, modify, or run tests in this repository — or any time you modify `scripts/` or `prompts/` files (which always require the test suite to pass before committing).

## Expected Behavior

### Running tests

```bash
node --test scripts/tests/*.test.mjs
```

This is the only test command. There is no Jest, Mocha, Vitest, or other framework — only the built-in `node:test` runner. Node.js 20+ is required.

### Test file conventions

- Test files live in `scripts/tests/` and must be named `*.test.mjs`; `scripts/tests/test_layout.test.mjs` fails the suite for a test file `npm test` would not run (subdirectory, other name) or one using the Jest API.
- Each file imports directly from the module under test using ESM `import`.
- Use `node:test` and `node:assert/strict` — no external libraries.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myFunction } from '../lib/my_module.mjs';

test('describes expected behavior', () => {
  assert.equal(myFunction('input'), 'expected');
});
```

### Mandatory coverage requirements

When adding a new exported function to `scripts/lib/`, tests for **every failure branch** are required — not just the happy path. PRs lacking failure-branch tests are considered incomplete.

Modules with CI-enforced ≥ 80% coverage (lines, branches, functions, statements) are listed once, in `config/coverage-gates.json`, and run by `node scripts/coverage_gates.mjs` (`--only scripts/lib/<m>.mjs` runs one). To gate a new module, add it there (a bare path measured through `scripts/tests/<name>.test.mjs`, or `{ "module": …, "test": … }`), then run `node scripts/coverage_gates.mjs --sync` to refresh the list in the review prompt. `test.yml` has no per-module step to edit.

Required test paths per module: `AGENTS.md` → Test Coverage Policy (summary) and `docs/testing.md` → Required Test Paths per Module (exact paths).

### Hard rule: never remove tests

A test file never ends with fewer `test()` calls than it started with (`AGENTS.md` → Hard Guardrails). Count before and after.

### Two test layers

- **Unit tests** — modules tested in isolation with mocked dependencies.
- **Smoke tests** (`scripts/tests/smoke.test.mjs`) — full pipelines with real `config/models.yaml`, `config/labels.yaml`, and `prompts/*.md`, LLM mocked at the network boundary. Smoke tests catch renamed prompt placeholders, missing YAML keys, and mis-wired pipeline stages that unit tests cannot catch.

Both layers must pass before committing.

## Constraints

- Never use `--no-verify` to bypass the test requirement.
- Never commit to `scripts/` or `prompts/` without running the full suite first.
- Do not add `describe`/`it` blocks — `node:test` does not support Jest/Mocha syntax.

## References

- `docs/testing.md` — full test guide and per-file coverage table
- `AGENTS.md` — "Validation" and "Test Coverage Policy" sections
- `.github/workflows/test.yml` — CI test runner
- `scripts/tests/smoke.test.mjs` — cross-module integration tests
