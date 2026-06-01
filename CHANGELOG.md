# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Entries are grouped by date. Add new entries under `[Unreleased]`.

## [Unreleased]

## [2026-06-01]

### Added
- Metrics storage as append-only JSONL (`metrics/runs.jsonl`) with same-run deduplication via `GITHUB_RUN_ID`+`GITHUB_RUN_ATTEMPT` composite key; `deduplicateMetrics` in `scripts/lib/metrics.mjs` filters duplicate records at report time (ADR-0013)
- Anthropic prompt caching on system prompts — reduces token cost on repeated LLM calls with identical system content (PR #143)

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
