# Testing

Unit tests cover all core Node.js modules using the built-in `node:test` runner — no external dependencies required.

## Running Tests

```bash
node --test scripts/tests/*.test.mjs
```

Requires Node.js 20+. All tests should pass in under a second.

## Coverage

| File | Tests | What is covered |
|------|-------|-----------------|
| `scripts/lib/output_writer.mjs` | 10 | Field validation, path safety (absolute paths, `..` traversal), 16 000-char size limit, type coercion |
| `scripts/lib/config.mjs` | 12 | `requireEnv` missing/empty vars, `loadConfigFromEnv` defaults and required fields, `buildDeterministicPrompt` output structure, `loadLabelsConfig` group resolution |
| `scripts/lib/groq_client.mjs` | 7 | HTTP errors, non-JSON response, malformed `choices`, Authorization header, temperature payload |
| `scripts/lib/anthropic_client.mjs` | 10 | HTTP errors, non-JSON response, malformed `content`, `x-api-key` header, `anthropic-version` header, temperature, `max_tokens`, system prompt placement |
| `scripts/lib/llm_client.mjs` | 4 | Default routes to Anthropic, explicit `AI_PROVIDER=groq` routes to Groq, `AI_PROVIDER=anthropic` routes to Anthropic, case-insensitivity |
| `scripts/lib/issue_validator.mjs` | 51 | `VALIDATION_SYSTEM_PROMPT` structure, `isMeaningfulTitle` edge cases, `buildValidationUserPrompt` edge cases, `parseGroqResponse` hard rules and error cases, `formatGitHubComment` formatting, `validateIssue` integration (including prefix-only title short-circuit) |
| `scripts/lib/prompts.mjs` + `prompts/*.md` | 22 | `loadPrompt` for all 8 prompt files, `interpolatePrompt` placeholder substitution, per-file content assertions (keywords, placeholders, length) |
| `scripts/lib/yaml.mjs` | 15 | `parseFlatYaml` key/value parsing, blank lines, comments, colons in values; `parseNestedYaml` 3-level nesting, multiple groups, `labels.yaml` structure |
| `scripts/manage_labels.mjs` | 8 | Label upsert (create + PATCH fallback), apply/remove swap for `IS_VALID=true/false`, error cases (create 500, PATCH 500, add 422, remove 500), 404 on remove treated as success |
| `scripts/pr_review.mjs` | 20 | Diff fetch errors, comment list/upsert errors, review submit errors (500 fatal, 422 warning), APPROVE/REQUEST_CHANGES event, heading-style verdict detection, label swap, PATCH fallback on label 422, short review body distinct from comment body |
| `scripts/auto_fix_pr.mjs` | 10 | Label list fetch error, max-attempts guard (exits 0, posts exhausted comment), diff fetch error, invalid LLM JSON, empty changes array, success path (file written + attempt-1 label applied), attempt counter increment, inline comment inclusion in prompt, graceful inline comment fetch failure, attempt label repo creation |

## Prompt Files

All AI prompts live in `prompts/` as `.md` files, one per prompt:

| File | Used by | Notes |
|------|---------|-------|
| `validation-system.md` | `issue_validator.mjs` | Must exceed 4 000 chars for prompt caching |
| `validation-user.md` | `issue_validator.mjs` | Placeholders: `{{issueTitle}}`, `{{issueBody}}` |
| `generation-system.md` | `generate_issue_change.mjs` | System instruction for code generation |
| `generation-user.md` | `config.mjs` | Placeholders: `{{issueNumber}}`, `{{issueTitle}}`, `{{issueBody}}` |
| `pr-review-system.md` | `scripts/pr_review.mjs` | Reviewer persona |
| `pr-review-user.md` | `scripts/pr_review.mjs` | Placeholder: `{{diff}}` |
| `auto-fix-system.md` | `scripts/auto_fix_pr.mjs` | Fix-only persona, hard output-format rules |
| `auto-fix-user.md` | `scripts/auto_fix_pr.mjs` | Placeholders: `{{reviewFeedback}}`, `{{diff}}`, `{{fileContents}}` |

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

Per `AGENTS.md`: run `node --test scripts/tests/*.test.mjs` and ensure all tests pass before committing any change to `scripts/` or `prompts/`.

## CI

The workflow `.github/workflows/test.yml` runs `node --test scripts/tests/*.test.mjs` on every push and pull request targeting any branch.
