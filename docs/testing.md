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

`scripts/tests/smoke.test.mjs` — 22 tests across 7 groups:

| Group | What is covered |
|-------|-----------------|
| Config files | `models.yaml` has a model + temperature for every pipeline stage; `labels.yaml` has all label groups (`issue`, `review`, `autofix`) with required fields |
| Prompt files | All 8 prompt templates load without error and contain their expected `{{placeholder}}` variables |
| Validation pipeline | `validateIssue()` → `formatGitHubComment()` end-to-end for valid and invalid issues; prompt template produces no unsubstituted placeholders |
| Generation pipeline | Realistic LLM JSON (plain and markdown-fenced) → `parseJsonResponse` → `validateAiOutput` → `writeGeneratedFiles` with real temp files |
| `buildDeterministicPrompt` | Real `generation-user.md` template used; all placeholders substituted; output schema keys present |
| `loadLLMConfig` | All four stages (`validation`, `generation`, `review`, `autofix`) produce a valid config shape for both Groq and Anthropic; `autofix` exposes `maxTokens` from `models.yaml` |
| Observability | After a full mocked pipeline run, trace file exists at the expected path; contains spans for all 5 stages (`issue_validation`, `code_gen`, `pr_prepare`, `review`, `autofix`) with `outcome` populated; top-level `outcome` reflects pipeline result |

## Observability Tests

`scripts/tests/observability.test.mjs` — 20 unit tests across two groups:

| Group | What is covered |
|-------|-----------------|
| `log()` | Emits one JSON line to stderr; correct schema fields (`ts`, `run_id`, `stage`, `event`, `level`, `duration_ms`, `meta`); `GITHUB_RUN_ID` env var used as `run_id`; falls back to `"local"`; emits `::error::` GHA annotation on error level when `GITHUB_ACTIONS=true`; no annotation for non-error levels; never throws on circular meta; output is always valid JSON |
| `createTracer()` | `startSpan` creates trace file immediately; `endSpan` populates `completed_at`, `duration_ms`, `outcome`; `finalize` writes `completed_at` and top-level `outcome`; multiple spans accumulate in insertion order; re-using a stage name updates rather than duplicates; nested `traceDir` is created automatically; `endSpan` without prior `startSpan` is safe; I/O failure in `finalize` emits warn log rather than throwing; I/O failure in `startSpan` emits warn log rather than throwing |

## Unit Test Coverage

| File | Tests | What is covered |
|------|-------|-----------------|
| `scripts/lib/output_writer.mjs` | 108 | JSON parsing (fence-first, case-insensitive fence detection, `JsonParseError` typed errors with full tier diagnostics), field validation, path safety (absolute paths, `..` traversal, `PROTECTED_WRITE_PATHS` denylist incl. normalization bypasses and `docs/` / `README.md` at any depth and case, symlink-redirected writes), shrink guard (`isDestructiveShrink` line and content boundaries incl. padded stub and emptied file, rejected batch writes nothing), `GuardrailError` vs malformed-response errors, 16 000-char size limit, type coercion. CI-enforced ≥ 80% via c8 |
| `scripts/lib/review_evidence.mjs` | 60 | Config parsing (field-path errors, timeout validation, quote stripping, inline-comment rejection), env sanitization (per-segment credential names, `GIT_CONFIG_*` family), output tail and rolling buffer, `runCheck` (pass/fail/timeout/spawn error/exit 126-127/detached grandchild), evidence validation per field, staleness, touched trusted paths, fence and table-cell escaping, `run_review_evidence.mjs` end to end (write, skip without config, invalid config). CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_harness.mjs` | 25 | Dataset parsing (invalid JSON, missing fields, duplicate ids, empty), tag/limit filtering, call recording, replay (ordering, exhausted queue, recorded-error rethrow), runner (scores, errored runs, repeats, concurrency order), percentile, confusion matrix, per-class P/R/F1, consistency, summary, thresholds, report. CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_scorecard.mjs` | 23 | Scorecard read (missing file, unsupported format, invalid JSON), run conversion (defaults, replay rejection), history ordering/dedup/cap, deltas, dataset-hash Δ suppression, error_rate publish filter, Markdown rendering, README marker helpers, and that the README links the Pages dashboard with no committed scorecard view left. CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_site.mjs` | 16 | HTML/script escaping, shields endpoint badge, threshold rendering, trend chart (≥ 2 runs, missing values, zoomed y domain, textContent-only tooltip), index (empty state, Δ, dataset change, failed gate), run page (confusion matrix, escaped model output), site file map. CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_suites.mjs` | 30 | Suite registry contract, validation run wiring (system prompt, tag-only title guard, unparseable output), every scorer (`verdict_match`, `score_in_range`, `suggested_ac_count`, `blocker_match`, `blockerCodes`), thresholds, dataset invariants (labels, support, rule tags, `core`, `injection`), `run_evals` replay end to end. CI-enforced ≥ 80% via c8 |
| `scripts/build_eval_site.mjs` | 17 | History read back from the deployed site (404 aborts unless allow-empty, other errors abort, invalid format, cache bypass, missing-detail warning), restore from a backup dir or a local dir, outage skipping, history-window pruning, replay rejection, end to end and CLI |
| `scripts/lib/config.mjs` | 12 | `requireEnv` missing/empty vars, `loadConfigFromEnv` defaults and required fields, `buildDeterministicPrompt` output structure, `loadLabelsConfig` group resolution |
| `scripts/lib/groq_client.mjs` | 7 | HTTP errors, non-JSON response, malformed `choices`, Authorization header, temperature payload |
| `scripts/lib/anthropic_client.mjs` | 10 | HTTP errors, non-JSON response, malformed `content`, `x-api-key` header, `anthropic-version` header, temperature, `max_tokens`, system prompt placement |
| `scripts/lib/llm_client.mjs` | 4 | Default routes to Anthropic, explicit `AI_PROVIDER=groq` routes to Groq, `AI_PROVIDER=anthropic` routes to Anthropic, case-insensitivity |
| `scripts/lib/issue_validator.mjs` | 51 | `VALIDATION_SYSTEM_PROMPT` structure, `isMeaningfulTitle` edge cases, `buildValidationUserPrompt` edge cases, `parseGroqResponse` hard rules and error cases, `formatGitHubComment` formatting, `validateIssue` integration (including prefix-only title short-circuit) |
| `scripts/lib/prompts.mjs` + `prompts/*.md` | 28 | `loadPrompt` for all 8 prompt files, `interpolatePrompt` placeholder substitution, per-file content assertions (keywords, placeholders, length) |
| `scripts/lib/yaml.mjs` | 15 | `parseFlatYaml` key/value parsing, blank lines, comments, colons in values; `parseNestedYaml` 3-level nesting, multiple groups, `labels.yaml` structure |
| `scripts/manage_labels.mjs` | 8 | Label upsert (create + PATCH fallback), apply/remove swap for `IS_VALID=true/false`, error cases (create 500, PATCH 500, add 422, remove 500), 404 on remove treated as success |
| `scripts/pr_review.mjs` | 24+ | Diff fetch errors, comment list/upsert errors, review submit errors (500 fatal, 422 warning), APPROVE/REQUEST_CHANGES event, heading-style and bold-markdown verdict detection, template-echo placeholder defaults to REQUEST_CHANGES, label swap, re-pulse of `changes-requested` (remove then re-apply), guard to skip re-pulse when auto-fix run is already queued/in-progress, fail-closed guard when run-status API is forbidden, PATCH fallback on label 422, short review body distinct from comment body |
| `scripts/auto_fix_pr.mjs` | 10+ | Label list fetch error, max-attempts guard (exits 0, posts exhausted comment), diff fetch error, invalid LLM JSON, empty changes array, guardrail-rejected patch escalated to `needs-human`, success path (file written + attempt-1 label applied), attempt counter increment, inline comment inclusion in prompt, graceful inline comment fetch failure, paginated fallback to latest automated review comment when review payload lacks feedback, attempt label repo creation |
| `.claude/settings.json` (post-edit hook) | 8 | Matcher `Write\|Edit`, timeout ≥ 120 s, suite runs from `$CLAUDE_PROJECT_DIR` for `scripts/` and `.github/workflows/` edits, skipped for other paths and payloads without `file_path`, exit 2 + failure on stderr when the suite fails, exit 2 when `$CLAUDE_PROJECT_DIR` is unusable (`claude_settings_hook.test.mjs`) |

## Prompt Files

All AI prompts live in `prompts/` as `.md` files, one per prompt:

| File | Used by | Notes |
|------|---------|-------|
| `validation-system.md` | `issue_validator.mjs` | Must exceed 4 000 chars for prompt caching |
| `validation-user.md` | `issue_validator.mjs` | Placeholders: `{{issueTitle}}`, `{{issueBody}}` |
| `generation-system.md` | `generate_issue_change.mjs` | System instruction for code generation |
| `generation-user.md` | `config.mjs` | Placeholders: `{{issueNumber}}`, `{{issueTitle}}`, `{{issueBody}}`, `{{fileContents}}` |
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

## Post-Edit Test Hook (interactive Claude Code sessions)

`.claude/settings.json` declares a `PostToolUse` hook for interactive Claude Code sessions. It does not run in the GitHub Actions pipeline.

- **Trigger:** any `Write` or `Edit` whose `tool_input.file_path` contains `scripts/` or `.github/workflows/`. Other edits are no-ops.
- **Action:** `cd "$CLAUDE_PROJECT_DIR" && node --test scripts/tests/*.test.mjs`, all output on stderr. Requires `jq` on `PATH`.
- **Failure:** exits 2, so Claude Code feeds the failing test output back to the model and the regression is fixed in-session instead of by the auto-fix loop.
- **Timeout:** 300 s. The suite takes ~15–60 s depending on the machine; the test file asserts ≥ 120 s.

**Coverage policy:** every branch of the hook command (path match, path miss, missing `file_path`, suite failure, unusable project dir) must keep a dedicated test in `scripts/tests/claude_settings_hook.test.mjs`. Any change to the hook command must update those tests in the same PR. The tests run the real command from `settings.json` against a throwaway project; they are skipped when `jq` is missing.

## CI

The workflow `.github/workflows/test.yml` runs `node --test scripts/tests/*.test.mjs` on every push and pull request targeting any branch.
