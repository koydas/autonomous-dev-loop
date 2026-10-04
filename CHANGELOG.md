# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Entries are grouped by date. Add new entries under `[Unreleased]`.

## [Unreleased]
- Eval dashboard on GitHub Pages replaces the in-repo scorecard: the Evals workflow's `publish` job reads the history back from the deployed site, adds the run (`scripts/build_eval_site.mjs`, `scripts/lib/eval_site.mjs`) and redeploys — per-suite gate, thresholds, Δ, trend chart and history, per-run confusion matrix and case-level model output, shields.io badge. Nothing is committed; `evals/scorecard.json`, `evals/SCORECARD.md`, the README block, `scripts/update_scorecard.mjs` and the `evals/scorecard` PR flow are removed; `run_evals.mjs --scorecard` builds a local preview in `evals/site/`. Requires Pages source = GitHub Actions (ADR-0027 amendment)
- Evals workflow publishes the scorecard through a PR: the default branch rejects direct pushes (ruleset GH013), so the `publish` job now commits to the bot-owned `evals/scorecard` branch and opens or updates a `chore(evals): scorecard update` PR; pending runs accumulate in that PR until merged. Requires "Allow GitHub Actions to create and approve pull requests" (ADR-0027 amendment)
- Evals workflow publishes the scorecard: with the `publish` input (on by default), a run on the default branch is recorded and a separate `publish` job (`contents: write`, no secrets) commits `evals/scorecard.json`, `evals/SCORECARD.md` and the README results block. A metric threshold failure is published with ❌; a run that failed on `error_rate` (provider outage) is skipped. The eval job runs read-only without persisted credentials. Each run records the dataset `sha256`, and Δ is hidden when the dataset changed (ADR-0027 amendment)
- Eval dataset: `invalid-undocumented-dependency` now states that the notifier service is not deployed and has no API contract, so the B4 blocker is unambiguous
- Eval scorecard: `scripts/update_scorecard.mjs` (and `run_evals.mjs --scorecard`) records live eval runs in the committed `evals/scorecard.json` and regenerates `evals/SCORECARD.md` and the README "Latest results" block, with deltas against the previous run; replay runs are rejected (ADR-0027)
- Offline eval harness: `scripts/run_evals.mjs --suite validation` runs the issue validator against a labelled dataset (`evals/datasets/validation.jsonl`) and reports verdict accuracy, per-class precision/recall/F1, error rate, consistency across repeats, latency and estimated tokens; exits 1 below thresholds, `--replay` re-scores a recorded run without LLM calls; manual `evals.yml` workflow (ADR-0027)

### Fixed
- `scripts/tests/test_layout.test.mjs`: the placement check now requires the exact `npm test` glob (`scripts/tests/*.test.mjs`). It accepted any `*.test.*` under `scripts/tests/`, so `scripts/tests/foo.test.js` or `scripts/tests/sub/foo.test.mjs` passed the guard and never ran (review on #167).

### Added
- `scripts/tests/test_layout.test.mjs`: `npm test` (and therefore the review evidence job) now fails when a tracked test file sits outside `scripts/tests/`, or when a test file there does not import `node:test` or uses the Jest API (`jest.*`, `expect()`). `npm test` only globs `scripts/tests/*.test.mjs`, so such files passed CI without running: auto-fix wrote one on koydas/autonomous-dev-loop#165 (`ecb6382`), and `test/output_writer.test.mjs` from #119 sat dead on `main`.

### Changed
- `scripts/pr_review.mjs`: when the model approves but the tool evidence cannot confirm it — a check ended in `timeout` or `error`, or the evidence is missing or stale — the review is now **withheld** instead of approved. The GitHub review is submitted as `COMMENT`, `review-approved` and `changes-requested` are removed and the new `review-withheld` label (`config/labels.yaml`) is applied — auto-fix is not triggered, and the next approve or request-changes verdict clears it — and the comment explains why. A failing check still forces `REQUEST_CHANGES`. Repos without `config/review-evidence.yaml` keep the previous behavior. New exports `decideVerdict()` and `formatWithheldNote()` in `scripts/lib/review_evidence.mjs`; `review.verdict` events can now carry `verdict: "WITHHELD"` (ADR-0026).

### Removed
- `test/output_writer.test.mjs`: a Jest-syntax test (`jest.mock`) that never ran under `node --test`; `scripts/tests/output_writer.test.mjs` covers the module.

### Fixed
- `scripts/pr_review.mjs` verdict parsing: a review whose heading came back bold (`**🚀 Verdict**` followed by `APPROVED`, or `**Verdict:** APPROVED`) instead of `### 🚀 Verdict` matched nothing and defaulted to `REQUEST_CHANGES`. The PR got `changes-requested` while its comment said `APPROVED`, and auto-fix ran against an approved change: on koydas/autonomous-dev-loop#165 it pushed a Jest-style test file on attempt 1, then failed with `AI response missing non-empty changes array` on attempt 2. The parser now accepts a closing `**` after the word and after the colon.
- Groq defaults in `config/models.yaml` moved to `openai/gpt-oss-120b` for all stages: `qwen/qwen3-32b` (validation, review) and `llama-3.3-70b-versatile` (generation, autofix) were retired by Groq on 2026-07-17 and 2026-08-16, so every Groq call failed with `404 model_not_found`. New optional `<stage>_reasoning_effort` key (`low` | `medium` | `high`, set to `low` for every stage) is validated by `loadLLMConfig()` and sent by `groq_client.mjs` only when set. `autofix_max_input_tokens` lowered from 7,400 to 3,000 to fit gpt-oss-120b's 8K free-tier TPM with the measured ~890-token auto-fix system prompt. Every stage now sets an explicit `<stage>_max_tokens` (validation 1,024, generation 4,096, review 1,024) so each request stays bounded under the TPM. New `GROQ_REASONING_EFFORT` repository variable overrides every stage; `off` stops sending `reasoning_effort` for non-reasoning `GROQ_MODEL` overrides. ADR-0005 marked superseded and ADR-0017 amended (ADR-0025).

### Security
- `pr-review.yml` and `auto-fix-pr.yml` now run pipeline scripts, prompts and model config from a default-branch checkout in `$RUNNER_TEMP/pipeline`. The PR branch is only checked out as data. Previously any pushed branch executed its own `scripts/*.mjs` with `ANTHROPIC_API_KEY`, `GROQ_API_KEY` and `AI_PR_TOKEN`. `auto-fix-pr.yml`'s `load-labels` job checks out the default branch instead of the PR merge ref; `pr-review.yml` no longer persists git credentials; `test.yml` and `changelog-check.yml` run with `permissions: contents: read` (ADR-0023).
- `auto-fix-pr.yml` and `scripts/auto_fix_pr.mjs`: the "Relancer Auto Fixer" checkbox rerun is honored only when the comment author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`. Previously any commenter could reset the `auto-fix-attempt-*` labels and rerun the LLM loop indefinitely with repository secrets. The script re-checks the association so it does not rely on the workflow filter alone. It also exits before any GitHub mutation or LLM call on any `issue_comment` event that is not a trusted rerun request, so a loosened workflow filter cannot turn arbitrary comments into LLM runs.
- `pr-review`, `auto-fix-pr` and `reset-auto-fix` share one concurrency group per PR head branch (`pr-pipeline-<head ref>`), so a review never judges a commit that an auto-fix is replacing, and a reset never clears attempt labels in the middle of an auto-fix run. `auto-fix-pr`'s `load-labels` job and a new `reset-auto-fix` `resolve` job look up the head ref where the event lacks it, only for trusted rerun comments, and fail the job if the lookup returns nothing instead of falling back to a global group (ADR-0020).
- All 7 workflows declare a `concurrency:` group keyed per PR/issue. Workflows that push or mutate labels (`auto-fix-pr`, `pr-review`, `code-generation`, `validate-issue`, `reset-auto-fix`) use `cancel-in-progress: false`; `auto-fix-pr` and `code-generation` scope the group to the gated job so unrelated comment/label events cannot displace a pending run. Two reviews landing close together no longer spawn two auto-fix runs that read the same attempt count and both push (ADR-0020).
- `auto-fix-pr.yml`, `pr-review.yml`, `validate-issue.yml`: scripts now write metrics to `$RUNNER_TEMP/pipeline-metrics.jsonl` (`METRICS_FILE`), and "Commit metrics" uploads only that file. Previously the step PUT every working-tree `metrics/runs.jsonl` line past a baseline count to the default branch, so any content written into the checkout (e.g. by generated code) was committed to main (ADR-0021).
- `scripts/pr_review.mjs`: the "auto-fix already running" check now also counts `pending` runs (runs waiting on the ADR-0020 concurrency group), so the review does not re-pulse `changes-requested` while an auto-fix is queued behind another.
- `scripts/lib/output_writer.mjs`: AI-generated changes can no longer target `.github/`, `scripts/`, `config/`, `prompts/`, `package.json` or lock files (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`), npm/yarn rc files (`.npmrc`, `.yarnrc`, `.yarnrc.yml`), or git metadata (`.git` at any path segment: a written `.git/config` with `core.fsmonitor` would run on the auto-fix job's `git add -A`), or pipeline state dirs (`checkpoints/`, `metrics/`, `observability/`; the auto-fix "Commit metrics" step PUTs working-tree `metrics/runs.jsonl` lines to the default branch). The denylist is exported as `PROTECTED_WRITE_PATHS`. Paths are normalized before matching (backslashes, `./`, `.` segments, repeated slashes, case), so `.\.GITHUB\workflows\x.yml` is rejected too. This closes the path from issue body to code generation to a modified workflow or script running with `AI_PR_TOKEN`. `writeGeneratedFiles()` also refuses writes that a symlink in the checkout would redirect outside the repository or into `.git/`. The pipeline can no longer modify its own code (ADR-0021). `prompts/generation-system.md` and `prompts/auto-fix-system.md` now list every protected path as a hard guardrail, so the model avoids them instead of having the whole patch rejected; a smoke test keeps both prompts in sync with `PROTECTED_WRITE_PATHS`.

### Fixed
- Retry semantics (ADR-0010): network errors thrown by `fetch` in `scripts/lib/anthropic_client.mjs` and `scripts/lib/groq_client.mjs` are now retryable (they were marked `retryable = false`, so a transient connection reset failed the stage immediately). `ghFetch` in `scripts/auto_fix_pr.mjs` and `scripts/pr_review.mjs` now retries GitHub HTTP 429 and 5xx (previously never retried in `auto_fix_pr.mjs`; only 502–504 in `pr_review.mjs`) and honors `Retry-After` via the shared `transientHttpError()` classifier in `scripts/lib/retry.mjs`. A `Retry-After` longer than `MAX_RETRY_AFTER_MS` (10 s) is not waited out, so a 60 s secondary rate limit cannot consume the job timeout. Comment and review POSTs are not replayed after a 5xx or network error, because a replay could post a duplicate; label POSTs and all other methods are (`isRetrySafeGitHubRequest()`). `groq_client.mjs` bounds its rate-limit wait hint (body `try again in Xs` or `Retry-After`) by 60 s (`MAX_LLM_RETRY_AFTER_MS`, one TPM window), overridable with `LLM_MAX_RETRY_WAIT_MS`; `pr-review.yml` (2-minute timeout) sets 10 s, and a longer wait there fails fast so `callLLM` falls back to the next provider. Every other status is still returned to the caller unchanged; once retries are exhausted the last 429/5xx `Response` is returned so existing `.ok` checks and error messages are unchanged (ADR-0022).
- `scripts/auto_fix_pr.mjs` checkbox rerun: checkpoint cleanup deleted `checkpoints/checkpoint-attempt-N.json`, a layout `lib/checkpoint.mjs` never writes, so it was a no-op. It now removes `checkpoints/<CHECKPOINT_RUN_ID>/autofix.json` (the real layout) and keeps `review.json`, which the workflow requires as a prerequisite.
- `auto-fix-pr.yml` "Resolve PR payload for issue_comment": removed `echo "payload=${PAYLOAD}" >> "$GITHUB_OUTPUT"`, which wrote multi-line JSON without a heredoc delimiter (invalid `GITHUB_OUTPUT` format) and was never read.

### Added
- Tool evidence for PR review (ADR-0024): a new secret-free `evidence` job in `pr-review.yml` runs the checks declared in `config/review-evidence.yaml` (default `npm test`, `npm run lint`) on the PR head via `scripts/run_review_evidence.mjs`. `scripts/pr_review.mjs` injects the results into the review prompt, appends a `🧪 Tool Evidence` section to the review comment, and **forces `REQUEST_CHANGES` when any check fails**, whatever the LLM verdict. Missing or stale evidence (head SHA mismatch) and `timeout`/`error` results are reported as unverified and never override. `review.verdict` gains `evidence_state` and `evidence_override`; new `review_evidence` observability stage.
- Tool evidence hardening (PR #160 review): the `evidence` job runs its runner and config from the default branch (ADR-0023) and writes evidence outside the checkout; passing results are flagged as not authoritative when the PR touches a PR-tree path that still controls the checks (`EVIDENCE_TRUSTED_PATHS`: `package.json`, `pr-review.yml`); ADR renumbered to ADR-0024 after #159 took 0020–0023; exit codes 126/127 map to `error` instead of `fail` (no forced `REQUEST_CHANGES` on a config typo); quoted commands are unquoted and inline comments rejected; output tails use a fence longer than any backtick run and table cells escape `|`; the evidence section moves before the LLM text when a check failed so auto-fix truncation keeps it; a repo without `config/review-evidence.yaml` skips evidence (exit 0) instead of failing the job; rolling output buffer and exit + grace period so a detached grandchild cannot hang a check; credential env filter matches per name segment; `pr-review.yml` no longer runs on pushes to `main`; `scripts/lib/review_evidence.mjs` joins the c8 ≥ 80% coverage gate.
- ADR-0024: Tool evidence for PR review — documents the pushed-evidence design, secret isolation of the job that executes PR code, verdict override in code, and the rejected alternatives (LLM tool-use loop, Checks API polling, in-job execution, auto-discovery).
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
