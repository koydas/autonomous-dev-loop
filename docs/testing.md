# Testing

The test suite uses the built-in `node:test` runner — no external dependencies required. It contains two layers:

- **Unit tests** — each module tested in isolation with mocked dependencies.
- **Smoke tests** — full pipelines exercised with real config files (`config/models.yaml`, `config/labels.yaml`) and real prompt templates (`prompts/*.md`), with the LLM mocked at the network boundary. They catch integration failures that unit tests cannot: a renamed placeholder, a missing YAML key, a mis-wired pipeline stage.

## Running Tests

```bash
node --test scripts/tests/*.test.mjs
```

Requires Node.js 20+. All tests should pass in under a few seconds.

## Smoke Tests

`scripts/tests/smoke.test.mjs` — 20 tests across 6 groups:

| Group | What is covered |
|-------|-----------------|
| Config files | `models.yaml` has a model + temperature for every pipeline stage; `labels.yaml` has all label groups (`issue`, `review`, `autofix`) with required fields |
| Prompt files | All 8 prompt templates load without error and contain their expected `{{placeholder}}` variables |
| Validation pipeline | `validateIssue()` → `formatGitHubComment()` end-to-end for valid and invalid issues; prompt template produces no unsubstituted placeholders |
| Generation pipeline | Realistic LLM JSON (plain and markdown-fenced) → `parseJsonResponse` → `validateAiOutput` → `writeGeneratedFiles` with real temp files |
| `buildDeterministicPrompt` | Real `generation-user.md` template used; all placeholders substituted; output schema keys present |
| `loadLLMConfig` | All four stages (`validation`, `generation`, `review`, `autofix`) produce a valid config shape for both Groq and Anthropic; `autofix` exposes `maxTokens` from `models.yaml` |

## Unit Test Coverage

| File | Tests | What is covered |
|------|-------|-----------------|
| `scripts/lib/output_writer.mjs` | 10 | Field validation, path safety (absolute paths, `..` traversal), 16 000-char size limit, type coercion |
| `scripts/lib/config.mjs` | 12 | `requireEnv` missing/empty vars, `loadConfigFromEnv` defaults and required fields, `buildDeterministicPrompt` output structure, `loadLabelsConfig` group resolution |
| `scripts/lib/groq_client.mjs` | 7 | HTTP errors, non-JSON response, malformed `choices`, Authorization header, temperature payload |
| `scripts/lib/anthropic_client.mjs` | 10 | HTTP errors, non-JSON response, malformed `content`, `x-api-key` header, `anthropic-version` header, temperature, `max_tokens`, system prompt placement |
| `scripts/lib/llm_client.mjs` | 4 | Default routes to Anthropic, explicit `AI_PROVIDER=groq` routes to Groq, `AI_PROVIDER=anthropic` routes to Anthropic, case-insensitivity |
| `scripts/lib/issue_validator.mjs` | 51 | `VALIDATION_SYSTEM_PROMPT` structure, `isMeaningfulTitle` edge cases, `buildValidationUserPrompt` edge cases, `parseGroqResponse` hard rules and error cases, `formatGitHubComment` formatting, `validateIssue` integration (including prefix-only title short-circuit) |
| `scripts/lib/prompts.mjs` + `prompts/*.md` | 28 | `loadPrompt` for all 8 prompt files, `interpolatePrompt` placeholder substitution, per-file content assertions (keywords, placeholders, length) |
| `scripts/lib/yaml.mjs` | 15 | `parseFlatYaml` key/value parsing, blank lines, comments, colons in values; `parseNestedYaml` 3-level nesting, multiple groups, `labels.yaml` structure |
| `scripts/manage_labels.mjs` | 8 | Label upsert (create + PATCH fallback), apply/remove swap for `IS_VALID=true/false`, error cases (create 500, PATCH 500, add 422, remove 500), 404 on remove treated as success |
| `scripts/pr_review.mjs` | 24+ | Diff fetch errors, comment list/upsert errors, review submit errors (500 fatal, 422 warning), APPROVE/REQUEST_CHANGES event, heading-style and bold-markdown verdict detection, template-echo placeholder defaults to REQUEST_CHANGES, label swap, re-pulse of `changes-requested` (remove then re-apply), guard to skip re-pulse when auto-fix run is already queued/in-progress, fail-closed guard when run-status API is forbidden, PATCH fallback on label 422, short review body distinct from comment body |
| `scripts/auto_fix_pr.mjs` | 10+ | Label list fetch error, max-attempts guard (exits 0, posts exhausted comment), diff fetch error, invalid LLM JSON, empty changes array, success path (file written + attempt-1 label applied), attempt counter increment, inline comment inclusion in prompt, graceful inline comment fetch failure, paginated fallback to latest automated review comment when review payload lacks feedback, attempt label repo creation |

## Prompt Files

All AI prompts live in `prompts/` as `.md` files, one per prompt:

| File | Used by | Notes |
|------|---------|-------|
| `validation-system.md` | `issue_validator.mjs` | Must exceed 4 000 chars for prompt caching |
| `validation-user.md` | `issue_validator.mjs` | Placeholders: `{{issueTitle}}`, `{{issueBody}}` |
| `generation-system.md` | `generate_issue_change.mjs` | System instruction for code generation |
| `generation-user.md` | `config.mjs` | Placeholders: `{{issueNumber}}`, `{{issueTitle}}`, `{{issueBody}}` |
| `pr-review-system.md` | `scripts/pr_review.mjs` | Reviewer persona |
| `pr-review-user.md` | `scripts/pr_review.mjs` | Placeholders: `{{issueTitle}}`, `{{issueBody}}`, `{{diff}}` |
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
