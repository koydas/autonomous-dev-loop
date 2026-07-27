---
description: Test runner conventions — node:test only (no Jest/Mocha), no-shrink rule on test count, mandatory failure-branch coverage for new exports, smoke tests required.
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

- Test files live in `scripts/tests/` and must be named `*.test.mjs`.
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

Modules with CI-enforced ≥ 80% coverage (`c8 --check-coverage` in `test.yml`):
- `scripts/lib/checkpoint.mjs`
- `scripts/lib/config.mjs`
- `scripts/lib/llm_client.mjs`
- `scripts/lib/output_writer.mjs`

Specific required paths for `scripts/lib/prompts.mjs`:
- `loadPrompt`: file exists + non-empty (happy path), file-not-found (`Prompt file not found` error with path), empty file (`Prompt file is empty` error with path)
- `interpolatePrompt`: single placeholder, multiple distinct, repeated, unknown placeholder left unchanged, non-placeholder content unchanged

### Hard rule: never remove tests

Never produce a test file with fewer `test()` calls than the original. If modifying a test file, count existing tests first and verify your output has at least the same count.

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
