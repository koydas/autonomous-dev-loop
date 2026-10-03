# ADR-0027: Offline eval harness for LLM pipeline stages

- **Date:** 2026-10-02
- **Status:** Accepted

## Context

Every pipeline stage (validation, generation, review, auto-fix) delegates its decision to an LLM, and the model, prompts and parameters change regularly (ADR-0005, ADR-0025, `config/models.yaml`). The unit and smoke tests mock the LLM at the network boundary: they prove the wiring, not the quality of the decisions. Production metrics (`metrics/runs.jsonl`, ADR-0013) arrive after the fact and are not comparable across changes because the inputs differ.

There is no way to answer "did this prompt / model change make the validator better or worse?" before merging it.

## Decision

Add an offline eval harness that runs a stage against a fixed, labelled dataset and produces comparable metrics.

- **`scripts/lib/eval_harness.mjs`** — stage-agnostic: dataset loading (JSONL), runner (repeats, bounded concurrency), LLM call recording, metrics (`summarize`), threshold check, Markdown report.
- **`scripts/lib/eval_suites.mjs`** — one suite per stage, a plain object: `run(input, { llm })` reuses the stage's production logic (`validateIssue` for `validation`), `scorers` return `0..1 | boolean | null` (null = not applicable), `label`/`expectedLabel` feed the confusion matrix, `thresholds` gate the run.
- **`evals/datasets/<suite>.jsonl`** — golden cases `{ id, tags, input, expected }`, versioned with the prompts they test.
- **`scripts/run_evals.mjs`** — CLI entrypoint. Writes the full run to `evals/results/<suite>-<runId>.json`, appends a summary to `evals/history.jsonl`, prints the report (and to `GITHUB_STEP_SUMMARY`), exits 1 when a threshold fails.
- **Replay** — every raw LLM response is stored in the results file; `--replay <file>` re-scores a run with no LLM call. Changing a parser or a scorer is evaluated for free and deterministically.
- **Scorecard** — `evals/scorecard.json` (committed, last 10 live runs per suite) is the published record; `scripts/update_scorecard.mjs` (or `run_evals.mjs --scorecard`) appends a run and regenerates `evals/SCORECARD.md` and the README block between `<!-- eval-scorecard:start/end -->` markers. Recording is done by the Evals workflow (see the amendment below) or by a manual commit; replay runs are rejected; a test fails when the committed views drift from the JSON.
- **`.github/workflows/evals.yml`** — `workflow_dispatch` only; uploads results and trace as artifacts.

Metrics produced for every suite: per-scorer mean, `error_rate` (run threw — parse failure, provider failure), per-class precision/recall/F1 from the confusion matrix, `consistency` (share of cases whose repeats agree, when `--repeats > 1`), latency p50/p95, LLM call count and estimated tokens.

The first suite is `validation` (15 cases, B1–B4 blockers + valid issues; deterministic guards such as the tag-only title check are left to unit tests so they do not inflate LLM metrics), gated on `verdict_match ≥ 0.8`, `invalid` recall ≥ 0.8 (the gate's job is to stop bad issues) and `error_rate ≤ 0.05`.

## Alternatives Considered

- **External eval framework (promptfoo, OpenAI Evals, Braintrust)** — rejected for now: adds a dependency and a second config language, and would call prompts outside the production code path (`validateIssue`, `parseGroqResponse`), so it would not catch parser regressions. The JSONL + results format can be exported to one later.
- **Run evals in `test.yml` on every PR** — rejected: spends tokens on every push and is non-deterministic (review stage runs at temperature 0.6). Replay mode can be added to CI cheaply instead.
- **LLM-as-judge scorers** — deferred: the first suite has a deterministic ground truth (valid / invalid). Generation and review suites will need it; a scorer is just a function, so a judge scorer fits the same contract (async scorers would be the only harness change).

## Consequences

- ✅ A prompt or model change can be compared on the same inputs before merge (`evals/history.jsonl` keeps the trend).
- ✅ Adding a stage = one suite object + one dataset file; adding a metric = one scorer.
- ✅ Replay makes scorer/parser changes free and reproducible.
- ⚠️ A 15-case dataset gives coarse metrics (one case ≈ 7 points). Thresholds are a starting point, to be tightened once a baseline over several runs is known.
- ⚠️ Labels are hand-written against `prompts/validation-system.md`; when the prompt's rules change, the dataset must be reviewed in the same PR.
- ⚠️ Token counts are estimates (`estimateTokens`, chars/4), not provider usage.

## Amendment (2026-10-03): the Evals workflow publishes the scorecard

A run whose results stay in an artifact is not visible, and a manual download-and-commit step was skipped in practice. `.github/workflows/evals.yml` now has a `publish` input (on by default) and two jobs:

- **`eval`** (`contents: read`, checkout with `persist-credentials: false`) runs the suite and uploads the results. It holds the API keys and handles LLM output, so no push credential is on disk (the ADR-0023 posture).
- **`publish`** (`contents: write`, no secrets) needs `eval`. It runs only when `!cancelled() && inputs.publish` and the ref is the **default branch**: runs on other refs stay artifact-only, so unmerged prompt or dataset changes never enter the history and the generated files never conflict at merge. It downloads the results artifact, runs `scripts/update_scorecard.mjs` and commits `evals/scorecard.json`, `evals/SCORECARD.md` and `README.md`.

Rules:
- Only those three generated files are staged. They are produced by deterministic code from metrics; no LLM-written text is committed. `workflow_gates.test.mjs` asserts the `git add` line and the job split.
- A run that misses a metric threshold is published with a ❌ gate. A run that misses the `error_rate` threshold is **skipped** with a warning (`partitionPublishable`): a provider outage (429, 401) measures the provider, not the model, and would evict real history from the 10-run window.
- Before each push (3 attempts, never forced), the views are rebuilt on the latest default-branch head (`git reset --hard origin/<branch>`, then `update_scorecard.mjs`), so a concurrent commit is never overwritten. The concurrency group is per ref.
- Each run records the dataset's `sha256`. `SCORECARD.md` shows Δ only against a previous run on the same dataset content and says "dataset changed" otherwise, so a label fix never reads as a model change.
- ⚠️ This is the one workflow that pushes to the default branch without a PR. That is acceptable because the change is generated data, not code. If the branch is protected against `github-actions[bot]`, the job fails visibly and the artifact remains the fallback.
- ⚠️ A push made with `GITHUB_TOKEN` does not trigger `test.yml`, so the drift test does not run on these commits. The views are deterministic output, and the next regular CI run checks them.
