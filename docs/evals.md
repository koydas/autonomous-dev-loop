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

CI: **Actions → Evals → Run workflow** (`workflow_dispatch` only). The report is on the run's summary page, results and trace are uploaded as artifacts, and, on the default branch, the run is added to the [eval dashboard](#dashboard) on GitHub Pages (`publish` input, on by default).

Δ on the dashboard only compares runs on the same dataset content: each run records the dataset's `sha256`, and when it changes the dashboard shows "dataset changed" instead of a Δ, so a label fix never reads as a model improvement.

| Option | Default | Effect |
|---|---|---|
| `--suite` | — | Suite name from `scripts/lib/eval_suites.mjs` |
| `--repeats` | `1` | Runs per case; `> 1` fills `consistency` |
| `--concurrency` | `1` | Parallel runs. Keep `1` on the Groq free tier (8K TPM) |
| `--tags` | all | Comma-separated; a case runs if it has any of them |
| `--limit` | all | First N cases after tag filtering |
| `--replay` | — | Serve LLM responses from a previous results file |
| `--out-dir` | `evals/results` | Where `<suite>-<runId>.json` is written |
| `--scorecard` | off | Add the run to a local dashboard preview in `EVAL_SITE_DIR` (default `evals/site/`, git-ignored; live full-dataset runs only) |

`EVAL_HISTORY_FILE` (default `evals/history.jsonl`) receives one summary line per run. It is a history only locally: a CI runner is ephemeral, so the uploaded `history.jsonl` always holds exactly one line — across CI runs, the [dashboard](#dashboard) is the history. Exit code is `1` when a suite threshold fails.

## Dashboard

**[koydas.github.io/autonomous-dev-loop](https://koydas.github.io/autonomous-dev-loop/)** is the published record of live runs, a static site on GitHub Pages.

- **Index, per suite:** the gate with each threshold (rule, value, pass/fail), metric tiles with Δ against the previous run on the same dataset, a trend chart of every scorer (hover for values), and the last 10 runs.
- **Run page:** metrics, per-class precision/recall/F1, the confusion matrix, and every case × repeat with expected and predicted verdict, scores, latency, errors, the parsed output and the raw model responses.
- **Machine-readable files:** `scorecard.json`, `scorecard.md`, `runs/<id>.json` (full results) and `badges/<suite>.json`, a [shields.io endpoint](https://shields.io/badges/endpoint-badge) that the README badge reads live.

**In CI (default):** the `publish` job runs after `eval` on the **default branch** only; runs on other refs stay artifact-only. Untick the `publish` input for a throwaway run.

1. It reads the history back from the deployed site: `scorecard.json`, then `runs/<id>.json` for each retained run. **The site is the history store; nothing is committed.**
2. It adds the run (`scripts/build_eval_site.mjs`, reusing `eval_scorecard.mjs` for the history window and `eval_site.mjs` for rendering).
3. It deploys with `actions/upload-pages-artifact` and `actions/deploy-pages`.

Rules:
- **Failing runs:** a run that misses a metric threshold is published with a ❌ gate. A run that misses `error_rate` is skipped with a warning: a provider outage (429, 401) is not a model result, and it would evict real history.
- **Safety:** a first deploy (404 on `scorecard.json`) starts empty. Any other read error aborts the job, so a transient failure never deploys a site without its history. Replays are rejected.
- **Least privilege:** the `publish` job has `pages: write` and `id-token: write`, no `contents: write` and no secrets. The `eval` job, which holds the API keys and handles LLM output, is read-only.
- **Prerequisite:** **Settings → Pages → Build and deployment → Source: GitHub Actions**. Without it, `actions/configure-pages` fails with an explicit error.
- ⚠️ Disabling Pages loses the history. Each run's results artifact stays available for 90 days.

**Locally:** `npm run eval -- --suite validation --repeats 3 --scorecard` adds the run to a preview in `evals/site/`; open `evals/site/index.html`. To rebuild from downloaded artifacts, run `npm run eval:site -- --out evals/site --previous-dir evals/site <results.json…>`, or `--site-url https://koydas.github.io/autonomous-dev-loop` to start from the live history.

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

## Tests and coverage

- `scripts/lib/eval_harness.mjs`, `scripts/lib/eval_scorecard.mjs` and `scripts/lib/eval_site.mjs` are under the CI-enforced **80% minimum coverage** gate (`c8 --check-coverage --lines 80 --branches 80 --functions 80 --statements 80` in `.github/workflows/test.yml`), each measured with its own test file.
- `scripts/run_evals.mjs` is exercised end to end in replay mode by `eval_suites.test.mjs` (thresholds, repeats, filtered runs, dataset hash). `scripts/build_eval_site.mjs` is covered by `build_eval_site.test.mjs`: history read from a stubbed site (404, errors, invalid format), history window pruning, outage skipping, and the CLI.
- The workflow is YAML, which c8 cannot measure. `workflow_gates.test.mjs` pins its shape instead: the job split, the default-branch condition, the Pages permissions and actions, and that it never pushes, commits or opens a PR.

## Results file

`evals/results/<suite>-<runId>.json` = `{ meta, summary, failures, results[] }`. Each result keeps `case_id`, `repeat`, `output`, `label`, `scores`, `error` and `calls[]` (`raw`, `latency_ms`, token estimates) — the `raw` responses are what `--replay` serves.
