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
- **Scorecard** — `evals/scorecard.json` (committed, last 10 live runs per suite) is the published record; `scripts/update_scorecard.mjs` (or `run_evals.mjs --scorecard`) appends a run and regenerates `evals/SCORECARD.md` and the README block between `<!-- eval-scorecard:start/end -->` markers. Recording is a manual commit, never a CI push to the default branch; replay runs are rejected; a test fails when the committed views drift from the JSON.
- **`.github/workflows/evals.yml`** — `workflow_dispatch` only; uploads results and trace as artifacts.

Metrics produced for every suite: per-scorer mean, `error_rate` (run threw — parse failure, provider failure), per-class precision/recall/F1 from the confusion matrix, `consistency` (share of cases whose repeats agree, when `--repeats > 1`), latency p50/p95, LLM call count and estimated tokens.

The first suite is `validation` (16 cases, B1–B4 blockers + valid issues), gated on `verdict_match ≥ 0.8`, `invalid` recall ≥ 0.8 (the gate's job is to stop bad issues) and `error_rate ≤ 0.05`.

## Alternatives Considered

- **External eval framework (promptfoo, OpenAI Evals, Braintrust)** — rejected for now: adds a dependency and a second config language, and would call prompts outside the production code path (`validateIssue`, `parseGroqResponse`), so it would not catch parser regressions. The JSONL + results format can be exported to one later.
- **Run evals in `test.yml` on every PR** — rejected: spends tokens on every push and is non-deterministic (review stage runs at temperature 0.6). Replay mode can be added to CI cheaply instead.
- **LLM-as-judge scorers** — deferred: the first suite has a deterministic ground truth (valid / invalid). Generation and review suites will need it; a scorer is just a function, so a judge scorer fits the same contract (async scorers would be the only harness change).

## Consequences

- ✅ A prompt or model change can be compared on the same inputs before merge (`evals/history.jsonl` keeps the trend).
- ✅ Adding a stage = one suite object + one dataset file; adding a metric = one scorer.
- ✅ Replay makes scorer/parser changes free and reproducible.
- ⚠️ A 16-case dataset gives coarse metrics (one case ≈ 6 points). Thresholds are a starting point, to be tightened once a baseline over several runs is known.
- ⚠️ Labels are hand-written against `prompts/validation-system.md`; when the prompt's rules change, the dataset must be reviewed in the same PR.
- ⚠️ Token counts are estimates (`estimateTokens`, chars/4), not provider usage.
