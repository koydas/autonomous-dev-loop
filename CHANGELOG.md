# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Entries are grouped by date. Add new entries under `[Unreleased]`.

## [Unreleased]

### Added
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
