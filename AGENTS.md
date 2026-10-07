# AGENTS Guidelines

This file provides working conventions for AI agents contributing to this repository.

Two distinct agent types operate here:
- **Interactive agents** (e.g. Claude Code): assist developers directly on the codebase.
- **Pipeline agent**: the automated `code-generation` workflow that generates file changes from issues.

Rules marked _(pipeline only)_ apply exclusively to the automated pipeline. All other rules apply to both.

## Scope

These instructions apply to the entire repository.

## Objectives

- Keep changes MVP-focused and small.
- Prefer safe, deterministic behavior over broad automation.
- Fail fast on external API errors; never open PRs on failed generation.

## Models

Default Groq models (all stages): `openai/gpt-oss-120b` (ADR-0025). See `config/models.yaml` for per-stage overrides.
Default Anthropic model (all stages): `claude-opus-4-7`.
Context windows: `openai/gpt-oss-120b` (Groq default) has 131 072 tokens; Anthropic models 200 000 tokens. On the Groq free tier the binding limit is 8 000 TPM per request, not the context window (ADR-0025). `scripts/auto_fix_pr.mjs` maps known models in `MODEL_CONTEXT_WINDOW` — add new models there when switching.

**Token budget (auto-fix stage):** `autofix_max_input_tokens` in `config/models.yaml` sets a hard ceiling on the input budget sent to the LLM, independently of the model's context window. The default is `3000` tokens — tuned to keep the total request (system + input + output) under the 8,000 TPM free-tier limit of `openai/gpt-oss-120b` (ADR-0025). Increase or remove this cap when using Groq Dev Tier or Anthropic. See [ADR-0017](docs/adr/0017-configurable-token-budget.md).

## Engineering Rules

- Keep workflow YAML files dumb: orchestration only, business logic in Node.js scripts/modules.
- Use Node.js for helper scripts and automation utilities.
- Avoid multi-file refactors unless explicitly requested.
- Keep generated output constrained to predictable locations.
- Use repository secrets/variables for all external credentials/configuration.
- Keep startup validation fail-fast and deterministic: validate required env vars, prompt files, and payload shape before external API calls.
- Prefer explicit error messages that include missing field paths (for example `pull_request.number`, `choices[0].message.content`) rather than generic parse failures.

## Hard Guardrails

These apply to **all agents** (interactive and pipeline) whenever modifying existing files:

- **Test files**: never produce a test file with fewer test cases than the original. Preserve all existing tests; only add new ones or modify the specific case explicitly requested.
- **Module format**: never change a file's module system. `.mjs` files are always ESM — `import`/`export` only; `require()` is forbidden. `.cjs` or `require`-based files stay CJS.
- **Exported function signatures**: never rename, re-type parameters, or change the return type of an exported function unless the request explicitly targets that signature.
- **External dependencies**: never introduce an `import` or `require` for a package not already present in the file's existing imports or in `package.json`.
- **File rewrite scope**: if a single fix or feature requires replacing more than 30% of an existing file's lines, reduce scope to a targeted edit instead. Full rewrites are only acceptable for new files or when the request explicitly asks for a rewrite.

See [ADR-0009](docs/adr/0009-llm-agent-guardrails.md) for the incidents that motivated these rules.

## Validation

Before committing any change to `scripts/` or `prompts/`:

- Run `node --test scripts/tests/*.test.mjs` and ensure all tests pass.
- Never commit code that breaks an existing test without updating or replacing the test intentionally.
- Test files live only in `scripts/tests/` and use `node:test`; `scripts/tests/test_layout.test.mjs` fails the suite for a test file that `npm test` would not run (anywhere else, in a subdirectory, or not `.test.mjs`) or one using the Jest API, because `npm test` would never run it.
- The suite includes **unit tests** (modules in isolation) and **smoke tests** (`smoke.test.mjs`, cross-module pipelines with real config/prompt files). Both must pass.

### Eval Gates (ADR-0031)

A failing eval (`evals.yml`, `pr-evals.yml`, `eval-replay.yml`) is fixed **in the stage**: prompt, parser or production code. Never make it pass by lowering a `min`, raising a `max`, marking a metric `optional`, removing or relabelling the failing cases, or running a filtered subset. `scripts/tests/eval_threshold_floor.test.mjs` enforces it: thresholds only tighten, datasets only grow, and every existing case keeps its id, label and input (pinned). `workflow_gates.test.mjs` forbids `--tags` / `--limit` in `evals.yml` and `pr-evals.yml`. A dataset label may be corrected only when it is wrong on its own merits, in a separate PR; loosening a gate needs a new ADR.

### Test Coverage Policy

Minimum required path coverage for automation modules (enforced by code review):

| Module | Minimum coverage | Required test paths |
|---|---|---|
| `pr_review.mjs` — verdict → review event and labels (ADR-0026) | 100% of verdicts | `APPROVE` → `review-approved`; `REQUEST_CHANGES` → `changes-requested` (re-pulse); `WITHHELD` → `COMMENT` + `review-withheld`, neither other label; `review-withheld` cleared by the next `APPROVE` or `REQUEST_CHANGES`; missing evidence without an evidence config → `APPROVE`. `decideVerdict()` itself is in `scripts/lib/review_evidence.mjs`, under the c8 80% gate in `test.yml` |
| `scripts/lib/review_marker.mjs` — per-SHA dedup (ADR-0028) | 100% of branches | `decideReviewRun`: new head, `already_reviewed`, `WITHHELD` never dedups, manual re-run bypass, `superseded` (also on re-run), unknown head; `decideAutofixRun`: `APPROVE` on head skips, manual rerun overrides it, any other verdict / older head / no marker / unknown head runs; `hasNoProposedChanges`: only an explicit `changes: []`; marker anchored at end of body (echoed marker loses, mid-body only → `null`); `stripReviewMarkers`; `isTrustedReviewComment` / `findLatestReviewComment` (bot or member only, newest wins); marker format/parse failure branches. Entrypoints: `pr_review.mjs` skip → no LLM call + `skipped=true`, forged third-party marker ignored, LLM-echoed marker stripped; `auto_fix_pr.mjs` approved head → exit 0, no LLM call, no mutation; forged approval ignored; newest review across pages wins; `changes: []` → exit 0, attempt label + `needs-human` + comment + `autofix_skip` metric |
| `scripts/lib/prompts.mjs` — `loadPrompt` | 100% of branches | happy path (file exists, non-empty), file-not-found (explicit `Prompt file not found` error with path), empty-file (explicit `Prompt file is empty` error with path) |
| `scripts/lib/prompts.mjs` — `interpolatePrompt` | 100% of branches | single placeholder, multiple distinct placeholders, repeated placeholder, unknown placeholder left unchanged, non-placeholder content unchanged |
| Entrypoint startup validation (`auto_fix_pr.mjs`, `pr_review.mjs`) | 100% of failure paths | missing payload fields produce explicit path-oriented errors (e.g. `pull_request.number`, `pull_request.head.ref`) |
| `pr_review.mjs` — verdict parsing | 100% of accepted verdict forms | `### 🚀 Verdict` heading, `Verdict:` inline, bold verdict (`**APPROVED**`), bold heading (`**🚀 Verdict**`), bold heading with colon (`**Verdict:**`), each for APPROVED and REQUEST_CHANGES where it applies; template placeholder or missing verdict → REQUEST_CHANGES |
| `.claude/settings.json` post-edit test hook | 100% of branches | path under `scripts/` or `.github/workflows/` runs the suite from `$CLAUDE_PROJECT_DIR`, other paths and missing `file_path` skip it, failing suite exits 2 with output on stderr, unusable `$CLAUDE_PROJECT_DIR` exits 2 (`scripts/tests/claude_settings_hook.test.mjs`) |

Any PR that adds a new exported function to `scripts/lib/` must include tests for every failure branch, not only the happy path. PRs that lack these tests are considered incomplete regardless of whether existing tests pass.

## Workflow Rules _(pipeline only)_

- Issue automation triggers automatically when the validation agent applies the `ready-for-dev` label.
- Branch naming must follow `ai/issue-<number>`.
- PR descriptions should include `Closes #<issue_number>`.
- Do not implement auto-merge in MVP.

## Auto-Fix Rules _(pipeline only)_

- The auto-fix workflow (`auto-fix-pr.yml`) is label-driven: it triggers on `pull_request` `labeled` events and runs when the applied label matches `review.changes.name` from `config/labels.yaml` (default `changes-requested`).
- The maximum number of auto-fix attempts per PR is **3**, tracked via `auto-fix-attempt-N` labels on the PR.
- When the attempt limit is reached, the workflow posts a comment and exits without making any changes.
- Auto-fix commits use the message format `fix(ai): auto-fix attempt N`.
- Auto-fix only addresses issues explicitly named in the review feedback. It does not make speculative improvements.


## PR Review Comment Workflow (interactive agents)

When reading and acting on review comments or inline threads on a pull request:

1. **Fix the code** — implement the requested change and push the commit.
2. **Reply to each thread** — for every inline review thread addressed, post a reply explaining what was changed and which commit contains the fix (e.g. "Fixed in `abc1234` — …"). If no code change was needed (e.g. the comment was a false positive or already correct), explain why in the reply.
3. **Resolve each thread** — after replying, mark the thread as resolved so reviewers can see at a glance what is still open.
4. **Request a new review** — **only if at least one thread required an actual code fix** (i.e. a new commit was pushed): post a PR comment with `@Codex review` to trigger the next automated review cycle. If all threads were addressed with explanations only and no code was changed, do **not** post `@Codex review`.

Do not resolve a thread without first posting a reply, and do not reply without resolving. Steps 2 and 3 are always required; step 4 is conditional on whether code was changed.

## Review Hygiene (explicit)

For any change to workflow behavior (for example files under `.github/workflows/` or automation scripts under `scripts/`):

- **Documentation is mandatory in the same PR**: update `docs/code-generation.md` and/or `docs/runbook.md` whenever trigger conditions, rerun mechanics, labels, checkpoints, or operator steps change.
- **Tests are mandatory in the same PR**: add or update targeted tests that cover the new behavior (not only happy-path execution), in addition to running the full `node --test scripts/tests/*.test.mjs` suite.
- **No "code-only" automation behavior changes**: behavior updates without matching doc + test updates are considered incomplete.

## Observability Rules

- All pipeline event logging must go through `scripts/lib/observability.mjs` — use `log()` for structured JSON events (stderr) and `createTracer()` for span tracking. Never construct JSON log lines inline in business logic files.
- Every new pipeline stage script must emit at minimum: a `<stage>.start` event at entry and a `<stage>.complete` / `<stage>.error` event at exit, with `duration_ms` populated on terminal events.
- Observability failures must never abort business logic. The `log()` and tracer methods catch their own errors — do not add extra try/catch around them.
- The `observability/traces/` directory is git-tracked; the `*.json` files it contains are git-ignored (written at runtime and uploaded as CI artifacts). Do not commit trace files.
- When adding a new workflow that runs an instrumented script, add `GITHUB_RUN_ID: ${{ github.run_id }}` to the step env and an `upload-artifact` step for the trace file (`if: always()`). See existing workflows for the pattern.

## Documentation Rules

- Update `docs/code-generation.md` when workflow inputs, setup requirements, or pipeline behavior change.
- Record major architectural decisions in `docs/adr/` as numbered ADR files.
