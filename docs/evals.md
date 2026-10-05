# Evals

Offline evaluation of LLM pipeline stages against labelled datasets ([ADR-0027](./adr/0027-offline-eval-harness.md)).
Unit/smoke tests prove the wiring with a mocked LLM; evals measure the quality of the decisions with the real one.

## Run

```bash
# Live (needs GROQ_API_KEY or ANTHROPIC_API_KEY, same env as the pipeline)
npm run eval -- --suite validation
npm run eval -- --suite validation --repeats 3          # + consistency
npm run eval -- --suite validation --tags b3,b4 --limit 5
npm run eval -- --suite review --repeats 3              # PR review stage, ≈ 11 min per repeat on Groq free tier

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

1. It reads the history back from the deployed site: `scorecard.json`, then `runs/<id>.json` for each retained run. The requests bypass the CDN cache (`cache: 'no-store'` plus a `?v=<timestamp>` query). **The site is the history store; nothing is committed.**
2. It adds the run (`scripts/build_eval_site.mjs`, reusing `eval_scorecard.mjs` for the history window and `eval_site.mjs` for rendering).
3. It backs up the built tree as the artifact `eval-site-<runId>` (90 days).
4. It deploys with `actions/upload-pages-artifact` and `actions/deploy-pages`. When the eval job produced no results, the job builds and deploys nothing.

Rules:
- **Failing runs:** a run that misses a metric threshold is published with a ❌ gate. A run that misses `error_rate` is skipped with a warning: a provider outage (429, 401) is not a model result, and it would evict real history.
- **Safety:** a 404 on `scorecard.json` aborts the job unless the `init_site` input is ticked. Tick it **for the first deploy only**: a 404 can also come from a wrong URL or an edge glitch, and must never silently start a new history. Any other read error aborts too. A missing `runs/<id>.json` logs a warning and keeps the history row without its detail page. Replays are rejected.
- **Restore:** every deployed tree is kept as `eval-site-<runId>` for 90 days. To roll back after a bad build, run the workflow with `restore_run_id` set to the last good run's ID. The history then comes from that backup instead of the live site, and the eval run that comes with the restore is added on top. Locally: `npm run eval:site -- --out <dir> --previous-dir <unzipped eval-site artifact>`.
- **Least privilege:** the `publish` job has `pages: write` and `id-token: write`, no `contents: write` and no secrets. The `eval` job, which holds the API keys and handles LLM output, is read-only.
- **Prerequisite:** **Settings → Pages → Build and deployment → Source: GitHub Actions**, set before the first run. Without it, `actions/configure-pages` fails with an explicit error. The first run also needs `init_site` ticked.
- ⚠️ The live history exists only on the deployed site. The `eval-site-*` backups cover 90 days.

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

### `validation`

`validation` thresholds: `scores.verdict_match.mean ≥ 0.8`, `per_class.invalid.recall ≥ 0.8`, `per_class.valid.recall ≥ 0.8` (over-strictness), `consistency ≥ 0.9` (only with `--repeats > 1`), `error_rate ≤ 0.05`.

`validation` scorers: `verdict_match`, `score_in_range` (cases with `score_min`/`score_max`), `suggested_ac_count`, and `blocker_match`. `blocker_match` is the Jaccard overlap between `expected.blockers` and the `B1`–`B4` codes the model prefixes its blockers with. It applies only to cases with `expected.blockers` and is not gated.

Dataset tags: `core` marks the original 15 cases, so `--tags core` compares with runs from before the dataset grew. The edge-case tags are `partial-ac`, `role-scope`, `scope-pair`, `stub` (B4 minimal pair), `short`, `fr`, `warnings-only` and `injection`.

### `review`

`run` goes through the production code of `scripts/pr_review.mjs`: `buildReviewPrompt` (diff filter, classification / automation-gate / dependency / evidence contexts, token budget) and `parseReviewVerdict` from `scripts/lib/review_prompt.mjs`, then `decideVerdict` (ADR-0024/0026). The label is the **final pipeline verdict**: `approve`, `request_changes` or `withheld`.

- Dataset (`evals/datasets/review.jsonl`, 23 cases: 14 `request_changes`, 8 `approve`, 1 `withheld`): `{ id, tags, input: { title, body, diff, dependencies?, evidence?, head_sha? }, expected: { verdict, must_flag? } }`. `dependencies` replaces the target repo's `package.json` (dependency manifest context). `evidence` is an evidence file as written by `run_review_evidence.mjs`; a case without it is a repository that has not opted in, so missing evidence does not withhold an approval.
- Cases: real bugs (`off-by-one`, `null`, `shell-injection` via `execSync`, `deleted-test`, `undeclared-import`, the prompt's named checks, an unawaited `forEach`, `missing-tests`), unrequested docs deletion, minimal `pair`s (same issue, buggy vs clean diff), clean `docs` and `test-only` diffs (`tests_expected: false` per `change_classifier`), a complete `automation` change (tests + docs + c8 gate), `injection` in the PR body and in a code comment, `evidence` (pass, fail, timeout) and a `truncated` diff whose bug stays visible.
- A review without a verdict line is an **errored run** (`error_rate`), not a `REQUEST_CHANGES`: production fails closed, but counting it as a rejection would inflate `request_changes` recall.

| Scorer | Applies to | Meaning |
|---|---|---|
| `verdict_match` | all | Final verdict = `expected.verdict` |
| `flags_issue` | cases with `must_flag` | Share of `must_flag` entries found in the review, outside its Change Classification section (whose "Tests expected" line would match any test keyword). An entry is `"a\|b\|c"`: any alternative, case-insensitive substring. Not gated |
| `no_false_alarm` | expected `APPROVE` / `WITHHELD` | The model approved and listed no `[High]` / `[Medium]` finding in Issues Found. Not gated |

`review` thresholds: `scores.verdict_match.mean ≥ 0.75`, `per_class.request_changes.recall ≥ 0.8` (a missed bug reaches the merge gate unflagged), `per_class.approve.recall ≥ 0.6` (over-severity: a false `REQUEST_CHANGES` starts auto-fix on a correct PR; support 8, one case ≈ 12 points), `consistency ≥ 0.8` (only with `--repeats > 1`; looser than `validation` because `review_temperature` is 0.6), `error_rate ≤ 0.05`.

**Duration and tokens.** Each prompt is fitted to `review_max_input_tokens` (6300 estimated tokens; × 1.10 + `review_max_tokens` 1024 = 7954 ≤ 8000 TPM), exactly like production. The dataset averages ≈ 2.9k estimated input tokens per call (system prompt ≈ 1.9k); the `truncated` case sits at the budget. One repeat ≈ 66k input + ≤ 24k output tokens. On the Groq free tier (8K TPM, `--concurrency 1`, TPM is the bottleneck) that is **≈ 11–12 min per repeat, ≈ 35–40 min for the default `--repeats 3`** with the 60 s rate-limit waits; worst case (every call at the budget, TPM shared with live pipeline runs) ≈ 70 min, inside the 120 min job timeout. Anthropic has no budget: the diff keeps the 12,000-char cap.

**Replay fixture.** `scripts/tests/fixtures/review-replay.json` holds hand-written model outputs in the production format (`<think>` block, bold and inline verdict headings) with four planted failures: a truncated review without verdict, a missed bug, an over-severe docs review and a right verdict for the wrong reason. `eval_suites.test.mjs` replays it through `run_evals.mjs` and pins the resulting metrics. Adding a case to the dataset means adding its recorded output to the fixture.

## Extend

**Add a case** — one line in `evals/datasets/<suite>.jsonl`: `{ "id", "tags", "input", "expected" }`. Ids are unique; `//` lines are comments.

**Add a scorer** — one entry in the suite's `scorers`: `(expected, output, { error, calls }) → 0..1 | boolean | null`. It shows up in the summary and the report automatically, and can be gated in `thresholds` as `scores.<name>.mean`. A threshold marked `optional: true` is skipped when the run did not measure the metric (e.g. `consistency` with `--repeats 1`) instead of failing.

**Add a suite** (new stage) — add an object to `SUITES` in `scripts/lib/eval_suites.mjs`, and the name to the `suite` choice in `.github/workflows/evals.yml` (`workflow_gates.test.mjs` checks both lists match):

```js
export const autofixSuite = {
  name: 'autofix',
  stage: 'autofix',                         // loadLLMConfig stage
  dataset: 'evals/datasets/autofix.jsonl',
  run: async (input, { llm }) => { /* call the stage's production logic with llm */ },
  scorers: { /* ... */ },
  label: (output) => output.verdict,        // optional: confusion matrix + consistency
  expectedLabel: (expected) => expected.verdict,
  thresholds: { 'scores.verdict_match.mean': { min: 0.8 } },
};
```

`run` must go through the stage's production code (prompt builder + parser), not a copy, so parser regressions are caught. When an entrypoint script keeps that logic inline (`pr_review.mjs` did), extract it to `scripts/lib/` first, as `review_prompt.mjs` was. Add a test in `scripts/tests/eval_suites.test.mjs`. The dashboard needs no change: it renders one section, badge (`badges/<suite>.json`) and trend per suite.

## Tests and coverage

- `scripts/lib/eval_harness.mjs`, `scripts/lib/eval_scorecard.mjs`, `scripts/lib/eval_site.mjs` and `scripts/lib/eval_suites.mjs` are under the CI-enforced **80% minimum coverage** gate (`c8 --check-coverage --lines 80 --branches 80 --functions 80 --statements 80` in `.github/workflows/test.yml`), each measured with its own test file.
- `scripts/run_evals.mjs` is exercised end to end in replay mode by `eval_suites.test.mjs` (thresholds, repeats, filtered runs, dataset hash). `scripts/build_eval_site.mjs` is covered by `build_eval_site.test.mjs`: history read from a stubbed site (404, errors, invalid format), history window pruning, outage skipping, and the CLI.
- `scripts/lib/review_prompt.mjs` (review prompt builder and verdict parser, shared with `pr_review.mjs`) is under the same c8 gate, measured with `review_prompt.test.mjs`; `pr_review.test.mjs` and `entrypoints.test.mjs` still exercise it end to end through the script.
- The workflow is YAML, which c8 cannot measure. `workflow_gates.test.mjs` pins its shape instead: the job split, the default-branch condition, the Pages permissions and actions, and that it never pushes, commits or opens a PR.

## Results file

`evals/results/<suite>-<runId>.json` = `{ meta, summary, failures, results[] }`. Each result keeps `case_id`, `repeat`, `output`, `label`, `scores`, `error` and `calls[]` (`raw`, `latency_ms`, token estimates) — the `raw` responses are what `--replay` serves.
