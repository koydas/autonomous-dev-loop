# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Entries are grouped by date. Add new entries under `[Unreleased]`.

## [Unreleased]

### Security
- `auto-fix-pr.yml` and `scripts/auto_fix_pr.mjs`: the "Relancer Auto Fixer" checkbox rerun is honored only when the comment author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. Previously any commenter could reset the `auto-fix-attempt-*` labels and rerun the LLM loop indefinitely with repository secrets. The script re-checks the association so it does not rely on the workflow filter alone. It also exits before any GitHub mutation or LLM call on any `issue_comment` event that is not a trusted rerun request, so a loosened workflow filter cannot turn arbitrary comments into LLM runs.
- All 7 workflows declare a `concurrency:` group keyed per PR/issue. Workflows that push or mutate labels (`auto-fix-pr`, `pr-review`, `code-generation`, `validate-issue`, `reset-auto-fix`) use `cancel-in-progress: false`; `auto-fix-pr` and `code-generation` scope the group to the gated job so unrelated comment/label events cannot displace a pending run. Two reviews landing close together no longer spawn two auto-fix runs that read the same attempt count and both push (ADR-0020).
- `auto-fix-pr.yml`, `pr-review.yml`, `validate-issue.yml`: scripts now write metrics to `$RUNNER_TEMP/pipeline-metrics.jsonl` (`METRICS_FILE`), and "Commit metrics" uploads only that file. Previously the step PUT every working-tree `metrics/runs.jsonl` line past a baseline count to the default branch, so any content written into the checkout (e.g. by generated code) was committed to main (ADR-0021).
- `scripts/pr_review.mjs`: the "auto-fix already running" check now also counts `pending` runs (runs waiting on the ADR-0020 concurrency group), so the review does not re-pulse `changes-requested` while an auto-fix is queued behind another.
- `scripts/lib/output_writer.mjs`: AI-generated changes can no longer target `.github/`, `scripts/`, `config/`, `prompts/`, `package.json` or lock files (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`), npm/yarn rc files (`.npmrc`, `.yarnrc`, `.yarnrc.yml`), or pipeline state dirs (`checkpoints/`, `metrics/`, `observability/`; the auto-fix "Commit metrics" step PUTs working-tree `metrics/runs.jsonl` lines to the default branch). The denylist is exported as `PROTECTED_WRITE_PATHS`. Paths are normalized before matching (backslashes, `./`, `.` segments, repeated slashes, case), so `.\.GITHUB\workflows\x.yml` is rejected too. This closes the path from issue body to code generation to a modified workflow or script running with `AI_PR_TOKEN`. The pipeline can no longer modify its own code (ADR-0021). `prompts/generation-system.md` and `prompts/auto-fix-system.md` now list every protected path as a hard guardrail, so the model avoids them instead of having the whole patch rejected; a smoke test keeps both prompts in sync with `PROTECTED_WRITE_PATHS`.

### Fixed
- Retry semantics (ADR-0010): network errors thrown by `fetch` in `scripts/lib/anthropic_client.mjs` and `scripts/lib/groq_client.mjs` are now retryable (they were marked `retryable = false`, so a transient connection reset failed the stage immediately). `ghFetch` in `scripts/auto_fix_pr.mjs` and `scripts/pr_review.mjs` now retries GitHub HTTP 429 and 5xx (previously never retried in `auto_fix_pr.mjs`; only 502–504 in `pr_review.mjs`) and honors `Retry-After` via the shared `transientHttpError()` classifier in `scripts/lib/retry.mjs`. A `Retry-After` longer than `MAX_RETRY_AFTER_MS` (10 s) is not waited out, so a 60 s secondary rate limit cannot consume the job timeout. Comment and review POSTs are not replayed after a 5xx or network error, because a replay could post a duplicate; label POSTs and all other methods are (`isRetrySafeGitHubRequest()`). `groq_client.mjs` applies the same 10 s budget to its rate-limit wait hint (body `try again in Xs` or `Retry-After`), so a long Groq TPM wait fails fast and `callLLM` falls back to the next provider. Every other status is still returned to the caller unchanged; once retries are exhausted the last 429/5xx `Response` is returned so existing `.ok` checks and error messages are unchanged (ADR-0022).
- `scripts/auto_fix_pr.mjs` checkbox rerun: checkpoint cleanup deleted `checkpoints/checkpoint-attempt-N.json`, a layout `lib/checkpoint.mjs` never writes, so it was a no-op. It now removes `checkpoints/<CHECKPOINT_RUN_ID>/autofix.json` (the real layout) and keeps `review.json`, which the workflow requires as a prerequisite.
- `auto-fix-pr.yml` "Resolve PR payload for issue_comment": removed `echo "payload=${PAYLOAD}" >> "$GITHUB_OUTPUT"`, which wrote multi-line JSON without a heredoc delimiter (invalid `GITHUB_OUTPUT` format) and was never read.

### Added
- ADR-0019 (proposed): Static verification backstop for generated code — proposes an import-allowlist check and opt-in `tsc --noEmit` gate after generation/auto-fix, motivated by a benchmark session where a local coding model violated existing prompt-only guardrails (unauthorized dependency import, read-only property assignment causing a guaranteed runtime crash) and the paired PR-review prompt approved the resulting diff.
- Structured end-to-end observability: `scripts/lib/observability.mjs` provides `log()` (structured JSON to stderr, per-event) and `createTracer()` (incremental per-run trace file at `observability/traces/<GITHUB_RUN_ID>.json`). All four pipeline stages (issue_validation, code_gen/pr_prepare, review, autofix) now emit required events with `duration_ms` on terminal events. Error-level events emit `::error::` GitHub Actions annotations automatically (ADR-0018).
- Run trace artifact: each of the four main workflows uploads `run-trace-<GITHUB_RUN_ID>` as a GitHub Actions artifact (`if: always()`), so trace files are preserved even on failure.
- `scripts/tests/observability.test.mjs` — 20 unit tests covering `log()` schema, GHA annotations, error containment, tracer happy-path and I/O failure isolation.
- `docs/observability.md` — schema reference, per-stage event tables, trace file format, `jq` reading guide, and API reference.
- ADR-0018: Structured observability — JSON events to stderr + per-run trace files — documents the two-output design, rejected alternatives (OTEL, stdout-only, post-run aggregation), and the incremental-write rationale.
- ADR-0017: Configurable per-stage token budget in `config/models.yaml` — documents `autofix_max_input_tokens`, `autofix_diff_ratio`, `autofix_feedback_ratio` and the Groq on_demand 12k TPM constraint that motivated the design

### Changed
- `scripts/auto_fix_pr.mjs` and `scripts/lib/config.mjs`: auto-fix token budget is now configurable via `config/models.yaml` — `autofix_max_input_tokens` (default 7 400) caps the total user-prompt tokens (wrapper + sections) to stay within Groq on_demand's 12k per-request limit; `autofix_diff_ratio` (0.45) and `autofix_feedback_ratio` (0.25) control section allocation; the static wrapper text of `auto-fix-user.md` (~218 tokens) is deducted from the cap before dividing into sections; `diff_ratio + feedback_ratio ≥ 1.0` is now rejected at config load time; `token_estimate` log now includes a `wrapper` field and correct `total` (ADR-0017)
- All GitHub Actions workflows (`auto-fix-pr.yml`, `pr-review.yml`, `code-generation.yml`, `validate-issue.yml`, `test.yml`, `changelog-check.yml`, `reset-auto-fix.yml`): `node-version` updated from `'20'` to `'24'` ahead of the Node.js 20 deprecation on GitHub-hosted runners (forced transition 2026-06-16)
- `scripts/generate_issue_change.mjs` now calls `validateStartup()` at startup for early validation of required env vars (`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`, `ISSUE_NUMBER`, `ISSUE_TITLE`) and prompt files (`generation-system.md`, `generation-user.md`) before any external API call; `ISSUE_BODY` is intentionally not required as it has a `(no body provided)` fallback (PR #149)

### Added
- Automated changelog gate: `scripts/check_changelog.mjs` verifies that any PR touching entrypoint scripts or ADR files adds an entry under `## [Unreleased]`; enforced by `.github/workflows/changelog-check.yml` on every PR
- Context-aware PR review: `scripts/lib/change_classifier.mjs` classifies changed files before the LLM review and sets `tests_expected` so documentation-only, configuration-only, and lock-file-only PRs no longer receive irrelevant test-coverage findings (PR #148)
- ADR-0014: Anthropic prompt caching on system prompts — documents the `cache_control: { type: 'ephemeral' }` decision in `anthropic_client.mjs` (PR #143)
- ADR-0015: Three-tier JSON parsing with typed errors — documents `JsonParseError` class and Tier 1→2→3 cascade ordering invariant in `output_writer.mjs` (PR #144)
- ADR-0016: Changelog CI gate for entrypoint scripts and ADR files — documents `check_changelog.mjs`, `changelog_checker.mjs`, and `changelog-check.yml` (PR #146)

## [2026-06-01]

### Added
- Metrics storage as append-only JSONL (`metrics/runs.jsonl`) with same-run deduplication via `GITHUB_RUN_ID`+`GITHUB_RUN_ATTEMPT` composite key; `deduplicateMetrics` in `scripts/lib/metrics.mjs` filters duplicate records at report time (ADR-0013)
- Anthropic prompt caching on system prompts — reduces token cost on repeated LLM calls with identical system content (PR #143)
- Three-tier JSON parsing in `scripts/lib/output_writer.mjs`: `JsonParseError` typed error with `raw` and `parseErrors[]` fields; direct parse (Tier 1) → fence-strip (Tier 2) → brace-extraction (Tier 3) cascade (PR #144)

## [2026-05-25]

### Added
- Checkpoint-resume: `scripts/lib/checkpoint.mjs` records step outcomes (`validate`, `generate`, `review`, `autofix`) to `checkpoints/<runId>/<step>.json`, uploaded as GitHub Actions artifacts for cross-job observability (ADR-0011, PR #137)
- Pipeline performance metrics system: `scripts/metrics-report.mjs` and `scripts/lib/metrics.mjs` track per-step latency and outcomes (PR #141)
- Extended c8 coverage enforcement to `config.mjs`, `llm_client.mjs`, and `output_writer.mjs` at ≥80% threshold (PR #142)

### Changed
- Coverage enforcement scoped: CI hard-enforces ≥80% only for `scripts/lib/checkpoint.mjs`; all other automation files use reviewer-opinion gate. Reviewer system prompt gate (c) updated to reflect actual CI landscape (ADR-0012, PR #139)

## [2026-05-06]

### Added
- Structured logs and pipeline health metrics via `scripts/lib/logger.mjs` (PR #133)

## [2026-05-04]

### Added
- Idempotence for label writes, issue/PR comment upserts, and generated output files — duplicate workflow runs no longer produce duplicate artifacts (PR #119)

## [2026-05-03]

### Added
- LLM agent guardrails: five hard constraints added to `prompts/auto-fix-system.md` and `prompts/generation-system.md` to prevent destructive rewrites — e.g. replacing test suites with stubs, introducing CommonJS `require()` in ESM modules, changing exported function signatures, adding undeclared dependencies, or rewriting >30% of a file for a single finding (ADR-0009)

## [2026-05-01]

### Added
- Error taxonomy (`scripts/lib/error_taxonomy.mjs`): classifies LLM and GitHub API errors as `TRANSIENT` (retry), `PERMANENT` (fail-fast), or `UNKNOWN` (retry conservatively) (ADR-0010)
- Bounded retry with jitter (`scripts/lib/retry.mjs`): exponential backoff — base 200 ms, max 8 s, ±20% jitter, 4 attempts — shared by `llm_client.mjs` and `auto_fix_pr.mjs` (ADR-0010)
