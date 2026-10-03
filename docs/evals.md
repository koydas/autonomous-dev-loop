# Evals

Offline evaluation of LLM pipeline stages against labelled datasets ([ADR-0027](./adr/0027-offline-eval-harness.md)).
Unit/smoke tests prove the wiring with a mocked LLM; evals measure the quality of the decisions with the real one.

## Run

```bash
# Live (needs GROQ_API_KEY or ANTHROPIC_API_KEY, same env as the pipeline)
npm run eval -- --suite validation
npm run eval -- --suite validation --repeats 3          # + consistency
npm run eval -- --suite validation --tags b3,b4 --limit 5

# Re-score a recorded run, no LLM call (parser / scorer changes)
npm run eval -- --suite validation --replay evals/results/validation-<runId>.json
```

CI: **Actions → Evals → Run workflow** (`workflow_dispatch` only). The report is on the run's summary page, results and trace are uploaded as artifacts, and, on the default branch, a [scorecard](#scorecard) PR is opened or updated (`publish` input, on by default).

Δ in `SCORECARD.md` only compares runs on the same dataset content: each run records the dataset's `sha256`, and when it changes the scorecard shows "dataset changed" instead of a Δ, so a label fix never reads as a model improvement.

| Option | Default | Effect |
|---|---|---|
| `--suite` | — | Suite name from `scripts/lib/eval_suites.mjs` |
| `--repeats` | `1` | Runs per case; `> 1` fills `consistency` |
| `--concurrency` | `1` | Parallel runs. Keep `1` on the Groq free tier (8K TPM) |
| `--tags` | all | Comma-separated; a case runs if it has any of them |
| `--limit` | all | First N cases after tag filtering |
| `--replay` | — | Serve LLM responses from a previous results file |
| `--out-dir` | `evals/results` | Where `<suite>-<runId>.json` is written |
| `--scorecard` | off | Record the run on the scorecard (live runs only) |

`EVAL_HISTORY_FILE` (default `evals/history.jsonl`) receives one summary line per run. It is a history only locally: a CI runner is ephemeral, so the uploaded `history.jsonl` always holds exactly one line — across CI runs, the [scorecard](#scorecard) is the history. Exit code is `1` when a suite threshold fails.

## Scorecard

Live results are published in [`evals/SCORECARD.md`](../evals/SCORECARD.md) (latest metrics with Δ vs previous run, last 10 runs per suite) and in the README's **Latest results** block. Both are generated from `evals/scorecard.json`, which is committed.

**In CI (default):** a run on the **default branch** is recorded. The default branch only accepts changes through a PR, so the workflow commits the three generated files (`evals/scorecard.json`, `evals/SCORECARD.md`, `README.md`) as `github-actions[bot]` to the `evals/scorecard` branch, with the message `chore(evals): record <suite> run <runId> on the scorecard`. It then opens a PR titled **chore(evals): scorecard update**, or updates the one already open. **Merge that PR to publish.** Untick the `publish` input for a throwaway run.

- **Other branches:** runs stay artifact-only, so unmerged prompt or dataset changes never enter the published history and the generated files never conflict at merge.
- **Separate `publish` job:** it holds `contents: write` and gets the results through the artifact. The `eval` job, which holds the API keys and handles LLM output, runs read-only, with no push credential on disk.
- **Failing runs:** a run that misses a metric threshold is published with a ❌ gate. A run that misses the `error_rate` threshold is skipped with a warning, because a provider outage (429, 401) is not a model result and would evict real history.
- **One PR accumulates runs:** the bot owns `evals/scorecard`. Each run rebuilds it from the default-branch head, carries over `evals/scorecard.json` from the pending PR (runs not merged yet), records the new run and force-pushes that branch only; it never pushes to the default branch. Only those three files are staged. To discard pending runs, close the PR and delete the branch.
- **Prerequisite:** **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** must be on; otherwise `gh pr create` fails and the branch is pushed without a PR.
- **No CI on the scorecard PR:** a PR opened with `GITHUB_TOKEN` does not trigger other workflows (`test.yml`, `pr-review.yml`), so no LLM tokens are spent on it and the drift test does not run on it. The views are deterministic output of `update_scorecard.mjs`, and the next regular CI run on the default branch covers them. If the ruleset requires status checks, merge it as an admin.

**Locally:**

```bash
npm run eval -- --suite validation --repeats 3 --scorecard        # live run, then record it
npm run eval:scorecard -- evals/results/validation-<runId>.json  # record a downloaded CI artifact
npm run eval:scorecard                                           # regenerate the views only
```

Then commit `evals/scorecard.json`, `evals/SCORECARD.md` and `README.md`. Replay runs are rejected (`--scorecard` with `--replay` fails, and so does a replay results file) — they re-score old responses and say nothing about the current model. A failing run is still recorded, with its gate shown as ❌. `scripts/tests/eval_scorecard.test.mjs` fails when the committed views drift from `scorecard.json`.

## Metrics

| Metric | Meaning |
|---|---|
| `scores.<scorer>.mean` | Mean over runs where the scorer applies (`null` = not applicable) |
| `error_rate` | Share of runs that threw (unparseable output, provider failure) |
| `per_class.<label>.{precision,recall,f1}` | From the expected × predicted confusion matrix; errors count as misses |
| `consistency` | Share of cases whose repeats all produced the same label |
| `latency_ms.{p50,p95}` | Per run, including retries |
| `llm_calls`, `tokens_est` | Call count and chars/4 token estimates |

`validation` thresholds: `scores.verdict_match.mean ≥ 0.8`, `per_class.invalid.recall ≥ 0.8`, `error_rate ≤ 0.05`.

## Extend

**Add a case** — one line in `evals/datasets/<suite>.jsonl`: `{ "id", "tags", "input", "expected" }`. Ids are unique; `//` lines are comments.

**Add a scorer** — one entry in the suite's `scorers`: `(expected, output, { error, calls }) → 0..1 | boolean | null`. It shows up in the summary and the report automatically, and can be gated in `thresholds` as `scores.<name>.mean`.

**Add a suite** (new stage) — add an object to `SUITES` in `scripts/lib/eval_suites.mjs`:

```js
export const reviewSuite = {
  name: 'review',
  stage: 'review',                          // loadLLMConfig stage
  dataset: 'evals/datasets/review.jsonl',
  run: async (input, { llm }) => { /* call the stage's production logic with llm */ },
  scorers: { /* ... */ },
  label: (output) => output.verdict,        // optional: confusion matrix + consistency
  expectedLabel: (expected) => expected.verdict,
  thresholds: { 'scores.verdict_match.mean': { min: 0.8 } },
};
```

`run` must go through the stage's production code (prompt builder + parser), not a copy, so parser regressions are caught. Add a test in `scripts/tests/eval_suites.test.mjs`.

## Results file

`evals/results/<suite>-<runId>.json` = `{ meta, summary, failures, results[] }`. Each result keeps `case_id`, `repeat`, `output`, `label`, `scores`, `error` and `calls[]` (`raw`, `latency_ms`, token estimates) — the `raw` responses are what `--replay` serves.
