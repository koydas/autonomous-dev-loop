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
- Split a PR that adds about 1,000 lines or more along a seam (a module and its tests, then the wiring, then the docs), unless it is one mechanical change (a rename, a generated file, a moved block). Measured on 250 PRs: external review threads per PR rise from about 1.5 (100 to 1,000 added lines) to 3.5 (1,000 or more); below 1,000 the number of rounds does not follow the size, so there is no smaller cap.
- Prefer safe, deterministic behavior over broad automation.
- Fail fast on external API errors; never open PRs on failed generation.

## Models

Default Groq models (all stages): `openai/gpt-oss-120b` (ADR-0025). See `config/models.yaml` for per-stage overrides.
Anthropic model, effort and `max_tokens` are per stage, in the `anthropic_*` keys of `config/models.yaml` (ADR-0032; provisional until a stage's evals pass on that model). Read the file, not this page, for the current values. No temperature is sent to Anthropic: Opus 4.7+ / 5.x reject sampling parameters.
Context windows: `openai/gpt-oss-120b` (Groq default) has 131 072 tokens; for auto-fix, Anthropic models are budgeted at 200 000 tokens: `MODEL_CONTEXT_WINDOW` in `scripts/lib/autofix_core.mjs` lists only the 4.x ids, so the 5.x ids use its 200 000 fallback. `config/models.yaml` states a 1M window for them; that figure is not used by any code. Raising the auto-fix assumption means adding the 5.x ids to the map with a verified window. On the Groq free tier the binding limit is 8 000 TPM per request, not the context window (ADR-0025). `scripts/lib/autofix_core.mjs` maps known models in `MODEL_CONTEXT_WINDOW` — add new models there when switching.

**Token budget (auto-fix stage):** `autofix_max_input_tokens` in `config/models.yaml` sets a hard ceiling on the input budget sent to the LLM, independently of the model's context window. The value is in `config/models.yaml` — tuned to keep the total request (system + input + output) under the 8,000 TPM free-tier limit of `openai/gpt-oss-120b` (ADR-0025). Increase or remove this cap when using Groq Dev Tier or Anthropic. See [ADR-0017](docs/adr/0017-configurable-token-budget.md).

## Repository Map

- `scripts/*.mjs` entrypoints (one per stage, run by the workflows); `scripts/lib/` modules; `scripts/tests/` the only place for tests.
- `prompts/` stage prompts (their hard guardrails are hand-copied from this file and enforced in `scripts/lib/static_verifier.mjs`: change both together); `config/` models, labels, protected paths, coverage gates; `evals/` datasets and graders.
- `docs/adr/` numbered ADRs; `.github/workflows/` orchestration (`adl-*.yml` are the reusable workflows consumers depend on); `.claude/` skills and the test-gate hook.
- The pipeline never reads this file at run time: it governs interactive agents and the external reviewer. Pipeline behavior changes in code and prompts.
- The pipeline cannot write `scripts/`, `config/`, `prompts/`, `docs/`, `.github/`, `evals/fixtures/`, `evals/graders/` (ADR-0021, `config/protected-paths.yaml`): those changes are made by hand or by an interactive agent.
- `npm run lint` needs `bash`; `npm test` runs `scripts/tests/*.test.mjs` flat, no subdirectories.

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

See [ADR-0009](docs/adr/0009-llm-agent-guardrails.md) for the incidents that motivated these rules. For pipeline output (code generation and auto-fix) they are also enforced in code before any write — `scripts/lib/static_verifier.mjs` with the ADR-0029 write guard ([ADR-0019](docs/adr/0019-static-verification-backstop.md)): a violation rejects the patch and escalates to `needs-human`.

## Validation

Before committing any change to `scripts/` or `prompts/`:

- Run `node --test scripts/tests/*.test.mjs` and ensure all tests pass.
- Never commit code that breaks an existing test without updating or replacing the test intentionally.
- Test files live only in `scripts/tests/` and use `node:test`; `scripts/tests/test_layout.test.mjs` fails the suite for a test file that `npm test` would not run (anywhere else, in a subdirectory, or not `.test.mjs`) or one using the Jest API, because `npm test` would never run it.
- The suite includes **unit tests** (modules in isolation) and **smoke tests** (`smoke.test.mjs`, cross-module pipelines with real config/prompt files). Both must pass.

### Local Checks

Each CI gate has a local command. Run the ones your diff triggers before pushing:

| Gate (CI workflow) | Triggered by | Local command |
|---|---|---|
| Test suite (`test.yml`) | `scripts/`, `prompts/`, `config/`, `evals/`, `.github/workflows/` | `npm test` (~30 s) — one file: `node --test scripts/tests/<name>.test.mjs` |
| Syntax (`npm run lint`) | `scripts/` | `npm run lint` |
| Event docs (`test.yml`) | a new `event: '…'` under `scripts/` | `node scripts/check_event_docs.mjs` |
| Changelog (`changelog-check.yml`) | release-relevant entrypoints, ADRs, reusable workflows and consumer templates | `git fetch origin main && BASE_REF=main node scripts/check_changelog.mjs` |
| LangGraph prototype (`test.yml` → `prototype-langgraph`) | `prototypes/langgraph-loop/` | `cd prototypes/langgraph-loop && python -m unittest -v tests.test_loop` (Python ≥ 3.11, `pip install -r requirements.txt`) |
| c8 ≥ 80% (`test.yml`) | a module listed in `config/coverage-gates.json` | `node scripts/coverage_gates.mjs --only scripts/lib/<m>.mjs` (all gates: `node scripts/coverage_gates.mjs`); a new gated module is added to that file (the review reads it: no other list to update) |
| Review hygiene (PR review) | behavior change in a workflow or `scripts/` | docs (`docs/code-generation.md` / `docs/runbook.md`) + tests in the same PR |

### Eval Gates (ADR-0031)

A failing eval (`evals.yml`, `pr-evals.yml`, `eval-replay.yml`) is fixed **in the stage**: prompt, parser or production code. Never make it pass by lowering a `min`, raising a `max`, marking a metric `optional`, removing or relabelling the failing cases, or running a filtered subset. `scripts/tests/eval_threshold_floor.test.mjs` enforces it: thresholds only tighten, datasets only grow, and every existing case keeps its id, label and input (pinned). `workflow_gates.test.mjs` forbids `--tags` / `--limit` in `evals.yml` and `pr-evals.yml`. Never copy a dataset case's wording into a stage prompt: examples come from another domain (the floor test fails on a 5-word overlap). A dataset label may be corrected only when it is wrong on its own merits, in a separate PR; loosening a gate needs a new ADR.

**Production misjudgments become cases.** A wrong verdict, a false finding, a missed bug or a wrong validation seen on a real issue or PR gets a dataset case **in the PR that fixes it**, or, when that stage has no suite or no fix is planned yet, a linked issue labelled `eval-case` naming the input and the expected outcome. The case reproduces the incident from the real diff reduced to its minimum (identifiers rewritten if needed), records `"source": "PR #n"`, and is never copied into a prompt. A case the stage is known to fail may carry the `known-gap` tag: it runs and is published but stays out of the gate until the tag is removed, and a gated case can never be tagged (ADR-0031 §7, enforced by the floor test). Stages without a suite go to the incident backlog in `docs/evals.md`.

### Test Coverage Policy

Minimum required path coverage for automation modules, enforced by code review. The exact required paths per module are in [`docs/testing.md` → Required Test Paths per Module](docs/testing.md#required-test-paths-per-module); this table is the invariant each one must keep covered.

| Module | Coverage | Invariant to cover |
|---|---|---|
| `pr_review.mjs` — verdict → review event and labels (ADR-0026) | 100% of verdicts | `APPROVE`, `REQUEST_CHANGES`, `WITHHELD` each yield their event and labels; `review-withheld` is cleared by the next `APPROVE` / `REQUEST_CHANGES` |
| `pr_review.mjs` — verdict parsing | 100% of accepted forms | every documented verdict form; placeholder or missing verdict → `WITHHELD` (`unreadable_verdict`, ADR-0064), `REQUEST_CHANGES` only with a failing check or a guardrail finding |
| `scripts/lib/review_marker.mjs` — per-SHA dedup (ADR-0028) | 100% of branches | `decideReviewRun` / `decideAutofixRun` outcomes, marker parse and trust rules, and the `pr_review.mjs` / `auto_fix_pr.mjs` skip paths (no LLM call, no mutation) |
| `scripts/lib/prompts.mjs` — `loadPrompt`, `interpolatePrompt` | 100% of branches | missing file and empty file raise explicit errors with the path; unknown placeholders stay unchanged |
| Entrypoint startup validation (`auto_fix_pr.mjs`, `pr_review.mjs`) | 100% of failure paths | missing payload fields give path-oriented errors (e.g. `pull_request.number`) |
| `adversarial_review`, `circuit_breaker`, `lessons`, `lessons_loader` in `scripts/lib/` (ADR-0049, ADR-0050, ADR-0051) | every failure branch (c8 ≥ 80 %, `config/coverage-gates.json`) | protocol → `WITHHELD`; breaker opens at 3 equal signatures; lessons fail closed to none |
| `conflicts`, `conflict_resolver`, `conflicts_engine`, `conflicts_github` in `scripts/lib/` — conflicts-fix (ADR-0059) | every failure branch (c8 ≥ 80 %, `config/coverage-gates.json`) | every reason the engine returns leaves the merge aborted and nothing committed; malformed marker or model answer is rejected; a forged marker is ignored |
| `.claude/hooks/test-gate.mjs` — Claude Code test gate (Stop + `git push`) | 100% of branches | watched paths run the suite, others skip; an unchanged change set is never re-run; `git push` tests `HEAD` and is blocked on dirty watched paths |

Any PR that adds a new exported function to `scripts/lib/` must include tests for every failure branch, not only the happy path. PRs that lack these tests are considered incomplete regardless of whether existing tests pass.

## Changelog fragments

PRs that change release-relevant files add `changes/<issue-number>-<slug>.md` containing exactly one `### Added`, `### Changed`, `### Fixed`, or `### Removed` heading and at least one `- ` bullet. A PR without release notes may include the literal `No-Changelog: true` line in its body. Regular PRs must not edit root `CHANGELOG.md`; only the release operator assembles and rolls over that file, using `node scripts/assemble_changelog.mjs` and the procedure in `docs/releasing.md`.

## Workflow Rules _(pipeline only)_

- Issue automation triggers automatically when the validation agent applies the `ready-for-dev` label.
- Branch naming must follow `ai/issue-<number>`.
- PR descriptions should include `Closes #<issue_number>`.
- Do not implement auto-merge in MVP.

## Auto-Fix Rules _(pipeline only)_

- The auto-fix workflow (`auto-fix-pr.yml`) is label-driven: it triggers on `pull_request` `labeled` events and runs when the applied label matches `review.changes.name` from `config/labels.yaml` (default `changes-requested`).
- The maximum number of auto-fix attempts per fix round is **3**, tracked via `auto-fix-attempt-N` labels on the PR. An APPROVE ends the round: `pr_review.mjs` removes the `auto-fix-attempt-N` labels and `needs-human`, so the next REQUEST_CHANGES starts at attempt 1 (ADR-0034).
- When the attempt limit is reached, the workflow posts a comment and exits without making any changes.
- Auto-fix commits use the message format `fix(ai): auto-fix attempt N`.
- Auto-fix only addresses issues explicitly named in the review feedback. It does not make speculative improvements.


## PR Review Comment Workflow (interactive agents)

When reading and acting on review comments or inline threads on a pull request:

1. **Fix the code** — implement the requested change and push the commit. Fix the **class**, not the instance: before the push, name the defect class of each finding (for example "a grader input can bypass the check", "a count includes runs the producer never emits") and enumerate the same class in the touched function, its file and its siblings (callers, mirrored branches, the docs and tests that state it); fix every occurrence in the same commit, each with its regression test. Measured on 250 PRs: 19 of them held 57 % of the Codex threads, 70 % on one file, each round finding a neighbour of the previous fix (#283: nine variants of one grader hardening).
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
- Every side effect a stage performs (LLM call, label, comment, push, escalation, budget cut, skip) emits an event, and every event lands in the run journal of the trace (ADR-0040). The trace is published on the `metrics` branch only through `redactTrace()` (`scripts/lib/run_record.mjs`): a new event's meta stays unpublished until its keys are added to `EVENT_META_ALLOWLIST`, and no prompt, model output, file content, title/body or env value may ever be allowlisted.

## Documentation Rules

- Update `docs/code-generation.md` when workflow inputs, setup requirements, or pipeline behavior change.
- Record major architectural decisions in `docs/adr/` as numbered ADR files.
