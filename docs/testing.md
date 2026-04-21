# Testing

Unit tests cover all core Node.js modules using the built-in `node:test` runner — no external dependencies required.

## Running Tests

```bash
npm test
```

Requires Node.js 20+. All tests should pass in under a second.

## Coverage

| File | Tests | What is covered |
|------|-------|-----------------|
| `scripts/lib/output_writer.mjs` | 10 | Field validation, path safety (absolute paths, `..` traversal), 16 000-char size limit, type coercion |
| `scripts/lib/config.mjs` | 12 | `requireEnv` missing/empty vars, `loadConfigFromEnv` defaults and required fields, `buildDeterministicPrompt` output structure |
| `scripts/lib/groq_client.mjs` | 9 | HTTP errors, non-JSON response, malformed `choices`, invalid AI JSON (array vs object), Authorization header, temperature payload |
| `scripts/lib/issue_validator.mjs` | 39 | `VALIDATION_SYSTEM_PROMPT` structure, `buildValidationUserPrompt` edge cases, `parseClaudeResponse` hard rules and error cases, `formatGitHubComment` formatting, `validateIssue` integration |
| `scripts/lib/prompts.mjs` + `prompts/*.txt` | 19 | `loadPrompt` for all 6 prompt files, `interpolatePrompt` placeholder substitution, per-file content assertions (keywords, placeholders, length) |

## Prompt Files

All AI prompts live in `prompts/` as plain `.txt` files, one per prompt:

| File | Used by | Notes |
|------|---------|-------|
| `validation-system.txt` | `issue_validator.mjs` | Must exceed 4 000 chars for prompt caching |
| `validation-user.txt` | `issue_validator.mjs` | Placeholders: `{{issueTitle}}`, `{{issueBody}}` |
| `generation-system.txt` | `generate_issue_change.mjs` | System instruction for code generation |
| `generation-user.txt` | `config.mjs` | Placeholders: `{{issueNumber}}`, `{{issueTitle}}`, `{{issueBody}}` |
| `pr-review-system.txt` | `.github/scripts/pr-review.mjs` | Reviewer persona |
| `pr-review-user.txt` | `.github/scripts/pr-review.mjs` | Placeholder: `{{diff}}` |

Template placeholders use the `{{variableName}}` syntax. `interpolatePrompt()` in `scripts/lib/prompts.mjs` handles substitution; unknown placeholders are left unchanged.

## Adding Tests

Test files live in `scripts/tests/` and follow the `*.test.mjs` naming convention. Each file imports directly from the module under test.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myFunction } from '../lib/my_module.mjs';

test('describes expected behavior', () => {
  assert.equal(myFunction('input'), 'expected');
});
```

Per `AGENTS.md`: run `npm test` and ensure all tests pass before committing any change to `scripts/` or `prompts/`.

## CI

The workflow `.github/workflows/test.yml` runs `npm test` on every push and pull request targeting any branch.
