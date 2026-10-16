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

`scripts/tests/smoke.test.mjs` — 31 tests across 8 groups:

| Group | What is covered |
|-------|-----------------|
| Config files | `models.yaml` has a model + temperature for every pipeline stage; `labels.yaml` has all label groups (`issue`, `review`, `autofix`) with required fields |
| Prompt files | All 8 prompt templates load without error and contain their expected `{{placeholder}}` variables |
| Validation pipeline | `validateIssue()` → `formatGitHubComment()` end-to-end for valid and invalid issues; prompt template produces no unsubstituted placeholders |
| Generation pipeline | Realistic LLM JSON (plain and markdown-fenced) → `parseJsonResponse` → `validateAiOutput` → `writeGeneratedFiles` with real temp files |
| Generation entrypoint guardrails (ADR-0019) | `generate_issue_change.mjs` run end to end, LLM and GitHub mocked: `require(` in an `.mjs` file → rejected with nothing written, `rejected=true`, comment, `needs-human`, `codegen_skip` metric; protected path → same escalation (`code_gen.skipped`); existing file not shown → `unshown_file`; clean patch → written, no GitHub call; failed escalation (403) → exit 1 with `pr_prepare.error`. Blocked outcome (ADR-0029 amendment): every named file protected → `denylist`, the model's note is not written; `blocked: true` → `model`; new notes only on a `bug` issue → `notes_only`; each: `blocked=true`, `needs-human` applied, `ready-for-dev` removed, one comment, `codegen_skip` metric, one `code_gen.skipped` with `reason: "blocked"` and `duration_ms`, no `pr_prepare`; not blocked (Markdown file, no bug/feature label, `blocked: false`) → written, no GitHub call; `blocked: "true"` → exit 1, `code_gen.error`; failed blocked escalation → exit 1, `code_gen.error` with `reason: "blocked"`. Generation prompts keep ≥ 10% of `generation_max_input_tokens` free (ADR-0037) |
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
| `scripts/lib/static_verifier.mjs` | 39 | Scanner (comments dropped, strings opaque, code inside template literals' `${…}` kept, nesting included; unterminated quote/comment/template), import extraction (static, side-effect, re-export, dynamic, `require`), one positive and one negative test per rule: `module_system` (`require(` in `.mjs`, `.cjs`/CommonJS `.js` → ESM, ESM `.js` → `require`, comments/strings ignored, new `.js`/`.cjs` not checked), `exported_signature` (removed — never unlocked by a mention, arity, parameter rename/reshape, sync ↔ async, defaults/types allowed, unlocked when the issue/feedback names the function, not by the word `default`), `unresolved_import` (undeclared package, subpath and already-imported roots, `node:` builtins incl. `node:test`, relative resolution with extensions/index/query, absolute paths and URLs, aliases skipped), combined entry point (ADR-0029 guard first, rule ids, patched files resolve), `GuardrailError` building and rule classification. Replays PR #122 auto-fix attempt 3 (fixture). CI-enforced ≥ 80% via c8 |
| `scripts/lib/review_evidence.mjs` | 60 | Config parsing (field-path errors, timeout validation, quote stripping, inline-comment rejection), env sanitization (per-segment credential names, `GIT_CONFIG_*` family), output tail and rolling buffer, `runCheck` (pass/fail/timeout/spawn error/exit 126-127/detached grandchild), evidence validation per field, staleness, touched trusted paths, fence and table-cell escaping, `run_review_evidence.mjs` end to end (write, skip without config, invalid config). CI-enforced ≥ 80% via c8 |
| `scripts/lib/stale_refs.mjs` | 20 | Normalization (backticks, `*`, `_`, whitespace, case), searched paths (docs, skills, top-level prompts, AGENTS.md; never CHANGELOG.md), diff parsing (blocks per hunk, old-file line, renames, lines outside hunks), hit, no hit, block under 60 chars, CHANGELOG / source-file / re-added-file exclusions, markdown and line-wrap differences, 60-char window at its longest quote, listing and read errors (warn event, empty result), PR #186 regression against ADR-0012, prompt and comment formatting caps. CI-enforced ≥ 80% via c8 |
| `scripts/lib/related_adrs.mjs` | 16 | ADR parsing (title, status, superseding ADR, Decision excerpt cut), exact path and unique-basename citations, no citation, superseded / deprecated skipped with successor included (missing, inactive or edited successor dropped), ranking (non-test paths, all paths, exact paths, recency), CHANGELOG.md ignored, ADRs changed by the diff skipped, read and listing errors (warn event, empty result), prompt block. CI-enforced ≥ 80% via c8 |
| `scripts/lib/prompt_budget.mjs` | 20 | Prompt → stage mapping (checked against `config/models.yaml`), placeholder-free token count, input vs TPM budget (unset or invalid → null), changed-prompt detection (new, deleted, nested and non-prompt paths ignored), prompt grows, shrinks, new (no base read), deleted (no head read), no budget configured, unmapped prompt, prompt shared by several stages, `auto-fix-system.md` on the TPM window, 10% threshold crossed or not and configurable, read error (warn event, empty result), prompt block and comment table. CI-enforced ≥ 80% via c8 |
| `scripts/lib/event_docs.mjs` | 10 | Event-docs check (#198): literal event names in single/double/backtick quotes, dynamic `${…}` names and non-event keys ignored, table-row first cell only (prose, lists and other cells ignored), missing events sorted with every emitting file, nothing missing / nothing emitted; entrypoint `check_event_docs.mjs`: pass (tests and non-`.mjs` files skipped), fail listing events and files, missing doc → exit 1. CI-enforced ≥ 80% via c8 |
| `scripts/lib/generation_blocked.mjs` | 34 | Generation "blocked" outcome (ADR-0029 amendment): needed paths (URLs, root `CHANGELOG.md` and bare names of named paths dropped; bare names only when at the root), deterministic block on the abridged #190 / #195 bodies, withheld path, one writable path or no path → not blocked; `blocked` must be the boolean `true` (summary text, `null`, `false` ignored; `"true"`, `1` throw); labels as JSON or comma list; notes-only refusal (bug/feature only, any non-Markdown file, existing file or `docs/` → allowed); precedence deterministic > model > notes-only, planned fix from `planned_fix` / note content / summary, capped; comment format; `escalateBlocked` call order, 422 / 404 tolerated, each failed call throws. Entrypoint branches in `smoke.test.mjs`. CI-enforced ≥ 80% via c8 |
| `scripts/lib/run_journal.mjs` | 27 | Run journal (ADR-0039): event order next to spans, adoption of pre-tracer events, cross-process append of the same run, a trace from another run / attempt / without envelope replaced (no forged events, spans, links), count and byte caps with `events_overflow`, oversized event, circular meta, event and span meta scrubbed of the producing process's env (secret absent from the committer env never reaches the record), event logged during `finalize()` kept, stdout untouched, one `trace_write_failed`, missing directory / half-written trace, envelope (env, payload, bot actor, meta fallback, links, `llm_calls`). CI-enforced ≥ 80% via c8 |
| `scripts/lib/run_record.mjs` | 20 | Public-safety contract: planted env secret and prompt body never survive, credential shapes, `scrubString` (no cut) vs `redactString` (scrub then cut), allowlist free of prompt/body/env keys, unlisted event → `meta {}`, nested objects dropped, URLs pinned to `GITHUB_SERVER_URL`, 256 KiB cap, Git Data API commit (single commit, dedup per run attempt, ref race retry, give-up, every failure branch). CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_harness.mjs` | 25 | Dataset parsing (invalid JSON, missing fields, duplicate ids, empty), tag/limit filtering, call recording, replay (ordering, exhausted queue, recorded-error rethrow), runner (scores, errored runs, repeats, concurrency order), percentile, confusion matrix, per-class P/R/F1, consistency, summary, thresholds, report. CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_scorecard.mjs` | 23 | Scorecard read (missing file, unsupported format, invalid JSON), run conversion (defaults, replay rejection), history ordering/dedup/cap, deltas, dataset-hash Δ suppression, error_rate publish filter, Markdown rendering, README marker helpers, and that the README links the Pages dashboard with no committed scorecard view left. CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_site.mjs` | 21 | HTML/script escaping, shields endpoint badge (incl. a registered suite with no published run → grey `no run yet`), threshold rendering, trend chart (≥ 2 runs, missing values, zoomed y domain, textContent-only tooltip), index (empty state, Δ, dataset change, failed gate, several suites with their own gate, trend and badge), run page (confusion matrix, escaped model output), site file map. CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_suites.mjs` | 57 | Suite registry contract, validation run wiring (system prompt, tag-only title guard, unparseable output), every scorer (`verdict_match`, `score_in_range`, `suggested_ac_count` incl. a response without `suggested_ac` end to end, `blocker_match`, `blockerCodes`), thresholds, dataset invariants (labels, support, rule tags, `core`, `injection`), `run_evals` replay end to end. `review` suite: run wiring through the production prompt builder and parser (contexts, evidence → `decideVerdict` incl. failing/timeout/stale/invalid evidence, missing verdict line → error, LLM failure, Groq budget vs Anthropic cap), scorers (`flags_issue` incl. Summary-only keyword and approving review → 0, `must_note`; `no_false_alarm`; `findingSeverities` past bold-only lines; `matchesFlag`; `reviewInputBudget` fallback and validation), dataset invariants (support, defect tags, docs-only → `tests_expected: false`, only `truncated` cases overflow the budget, valid evidence files), oracle end to end, replay of the hand-written fixture `scripts/tests/fixtures/review-replay.json`. CI-enforced ≥ 80% via c8 |
| `scripts/build_eval_site.mjs` | 21 | History read back from the deployed site (404 aborts unless allow-empty, other errors abort, invalid format, cache bypass, missing-detail warning), restore from a backup dir or a local dir, outage skipping, history-window pruning, replay rejection, several suites with their registry thresholds, `run_id` shared by two suites refused (batch and history), several suites of one workflow run in one CLI build, end to end and CLI. CI-enforced ≥ 80% via c8 |
| `scripts/lib/eval_replay_ci.mjs` | 35 | PR replay gate (`eval-replay.yml`): site reads (scorecard 404/5xx/network/format → unavailable; one retry on a network error or 5xx, never on a 4xx; newest run with a detail page, 404 fallback with warning, detail errors and malformed results files → suite missing), thresholds checked with the PR's rules on both sides (a stale recorded `failures` list is ignored, a tightened threshold only warns), malformed PR dataset → rejection, local site dir, dataset drift (same / changed / no recorded hash, added, removed, relabelled), replay of common cases and recorded repeats, metric deltas, verdict flips incl. errors, gate (blocking vs already failing vs advisory), suite outcomes (pass, parser regression → fail, preexisting → warn, drift → advisory, no common case → neutral), Markdown report and annotations, `replay_evals_ci.mjs` CLI end to end (exit 0/1, step summary, trace, neutral on an unreachable site). CI-enforced ≥ 80% via c8 |
| `scripts/lib/pr_evals.mjs` | 44 | Live PR prompt evals (`pr-evals.yml`): trigger checks (event, labeler permission, dispatch ref, moved or unknown head), `git diff --raw -z` parsing, prompt path safety, suite mapping kept in sync with `SUITES`, plan outcomes (run, refused on `scripts/`/`config/`, symlink, submodule, unsafe path, type change; nothing to run), merge-base diff and blob reads on a real git repository, size cap, apply validation and writes (create, overwrite, delete, refuse a symlink target), comparison with the published run (pass, blocking, preexisting, dataset drift, missing hash, model/repeats notes, no baseline, crashed suite), report (refused, empty, missing plan, escaping of model text, truncated change table), `plan_pr_evals.mjs` / `report_pr_evals.mjs` CLIs end to end. CI-enforced ≥ 80% via c8 |
| `scripts/lib/review_prompt.mjs` | 27 | Review prompt builder shared by `pr_review.mjs` and the `review` eval suite: context order, lock-file filtering vs raw-diff classification, Groq budget truncation, Anthropic 12,000-char cap, over-budget fixed part throws; unreviewed code files (ADR-0038): code cut in part or in full, only tests/docs cut, no cut, no diff, header-less chunk, withhold rule on APPROVE only; verdict parser: heading / bold / inline forms, `<think>` stripping, missing verdict → `null`. CI-enforced ≥ 80% via c8 |
| `scripts/lib/config.mjs` | 12 | `requireEnv` missing/empty vars, `loadConfigFromEnv` defaults and required fields, `buildDeterministicPrompt` output structure, `loadLabelsConfig` group resolution |
| `scripts/lib/groq_client.mjs` | 32 | HTTP errors (with `status`), non-JSON response, malformed `choices`, Authorization header, temperature payload, TPM rate-limit retries and wait budget, `reasoning_effort`, `response_format`. CI-enforced ≥ 80% via c8 |
| `scripts/lib/anthropic_client.mjs` | 27 | HTTP errors (with `status`), non-JSON response, malformed `content`, `x-api-key` / `anthropic-version` headers, no temperature by default, `max_tokens`, system prompt placement, `output_config.effort`, first text block after thinking, refusal and `max_tokens` truncation, 529 retry, no retry on undici timeouts, server-side `fallbacks` gating (ADR-0032). CI-enforced ≥ 80% via c8 |
| `scripts/lib/llm_client.mjs` | 4 | Default routes to Anthropic, explicit `AI_PROVIDER=groq` routes to Groq, `AI_PROVIDER=anthropic` routes to Anthropic, case-insensitivity |
| `scripts/lib/issue_validator.mjs` | 52 | `VALIDATION_SYSTEM_PROMPT` structure, `isMeaningfulTitle` edge cases, `buildValidationUserPrompt` edge cases, `parseGroqResponse` hard rules and error cases, `formatGitHubComment` formatting, `validateIssue` integration (including prefix-only title short-circuit), missing/`null` `suggested_ac` defaulted to `[]`. CI-enforced ≥ 80% via c8 |
| `scripts/lib/prompts.mjs` + `prompts/*.md` | 28 | `loadPrompt` for all 8 prompt files, `interpolatePrompt` placeholder substitution, per-file content assertions (keywords, placeholders, length) |
| `scripts/lib/yaml.mjs` | 15 | `parseFlatYaml` key/value parsing, blank lines, comments, colons in values; `parseNestedYaml` 3-level nesting, multiple groups, `labels.yaml` structure |
| `scripts/manage_labels.mjs` | 8 | Label upsert (create + PATCH fallback), apply/remove swap for `IS_VALID=true/false`, error cases (create 500, PATCH 500, add 422, remove 500), 404 on remove treated as success |
| `scripts/pr_review.mjs` | 24+ | Diff fetch errors, comment list/upsert errors, review submit errors (500 fatal, 422 warning), APPROVE/REQUEST_CHANGES event, heading-style and bold-markdown verdict detection, template-echo placeholder defaults to REQUEST_CHANGES, label swap, re-pulse of `changes-requested` (remove then re-apply), guard to skip re-pulse when auto-fix run is already queued/in-progress, fail-closed guard when run-status API is forbidden, PATCH fallback on label 422, short review body distinct from comment body |
| `scripts/auto_fix_pr.mjs` | 10+ | Label list fetch error, max-attempts guard (exits 0, posts exhausted comment), diff fetch error, invalid LLM JSON, empty changes array, guardrail-rejected patch escalated to `needs-human` (write denylist, write guard, and each ADR-0019 rule with its `rules` in the event), success path (file written + attempt-1 label applied), attempt counter increment, inline comment inclusion in prompt, graceful inline comment fetch failure, paginated fallback to latest automated review comment when review payload lacks feedback, attempt label repo creation |
| `.claude/hooks/test-gate.mjs` + `.claude/settings.json` (test gate) | 25 | Stop and PreToolUse(`Bash`) hooks wired with timeout ≥ 120 s, ai-dev-tools marketplace declared; suite runs for `scripts/`, `prompts/`, `config/`, `evals/`, `.github/workflows/` changes (uncommitted, committed on the branch, untracked), skipped for other paths; per-change-set cache (no re-run after a pass, no Stop loop after a failure, new edit re-runs); exit 2 + failure on stderr; `git push` tests `HEAD` — blocked while watched paths are dirty or untracked, blocked on a failed set, let through on a passed set, dirt elsewhere ignored, other Bash commands skipped, "git push" inside a commit message or heredoc not taken for a push; unusable `$CLAUDE_PROJECT_DIR` exits 2; no git tree → always runs; unknown mode; `isPushCommand`, `summarizeFailure` (`claude_settings_hook.test.mjs`) |

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

## Test Gate (interactive Claude Code sessions)

`.claude/settings.json` wires `.claude/hooks/test-gate.mjs` (Node built-ins only, no `jq`) to two hooks. Neither runs in the GitHub Actions pipeline.

- **Change set:** `git diff <merge-base with origin/main>` plus untracked files, restricted to `scripts/`, `prompts/`, `config/`, `evals/` and `.github/workflows/` (what the suite reads: smoke tests load `prompts/` and `config/`, the eval floor test pins `evals/`) — working-tree edits and commits already on the branch both count. No change → no-op. Outside a git tree the suite always runs, uncached.
- **`Stop` (end of turn):** runs `node --test --test-reporter=spec scripts/tests/*.test.mjs` from `$CLAUDE_PROJECT_DIR` once per change set. Failure → exit 2 with the failing-tests section on stderr: Claude Code keeps the turn going and the regression is fixed in-session instead of by the auto-fix loop.
- **`PreToolUse` on `Bash`:** only a `git push` command is gated (also `/usr/bin/git push`, `bash -c "git push"`; quoted strings and heredoc bodies — commit messages, echo text — are ignored, except the script of `sh -c`; best-effort detection, not a security boundary). It tests `HEAD`, which is what is pushed: watched paths with uncommitted or untracked changes refuse the push (commit or stash first), so a committed break hidden by a local fix cannot go out. On a clean tree the `HEAD` change set equals the `Stop` one, so its cached result is reused: failed → refused without re-running, passed → goes through, untested → run first.
- **Cache:** `$TMPDIR/adl-test-gate-<hash of project dir>.json` holds the last change-set hash and result. An unchanged set is never re-run — iterating 10 edits costs one suite run (~30 s), not ten — and a failing set blocks `Stop` once, not in a loop.
- **Timeout:** 300 s per hook (the test file asserts ≥ 120 s); the suite itself is killed after 280 s so a hang fails with an explicit message instead of an orphaned process.

It replaces the per-edit `PostToolUse` hook, which re-ran the whole suite after every `Write`/`Edit` whose path contained `scripts/` — also for files outside the project.

**Coverage policy:** every branch of `test-gate.mjs` keeps a dedicated test in `scripts/tests/claude_settings_hook.test.mjs`, run against throwaway git projects with a stub suite. Any change to the gate or its `settings.json` wiring updates those tests in the same PR.

## CI

The workflow `.github/workflows/test.yml` runs `node --test scripts/tests/*.test.mjs` on every push and pull request targeting any branch.
