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

### Amendment (2026-10-03, later): publish through a PR

The first live run with publishing ([37088738181](https://github.com/koydas/autonomous-dev-loop/actions/runs/37088738181)) was rejected by the repository ruleset on `main`: "Changes must be made through a pull request" (GH013). Rulesets cannot exempt `GITHUB_TOKEN`, and pushing with an admin PAT that bypasses the ruleset would put a branch-protection bypass credential in a workflow. The `publish` job therefore no longer pushes to the default branch:

- It owns the `evals/scorecard` branch. Each run rebuilds the branch from the default-branch head and carries over `evals/scorecard.json` from the pending branch (runs not merged yet). It records the new run and force-pushes **that branch only**. `workflow_gates.test.mjs` asserts that this is the only `git push`.
- It opens a PR (`chore(evals): scorecard update`) or updates the open one (`gh pr edit`), with `pull-requests: write`. A human merges it, which restores the human-merge rule this amendment had relaxed.
- ⚠️ Prerequisite: the repository setting "Allow GitHub Actions to create and approve pull requests".
- ⚠️ A PR opened with `GITHUB_TOKEN` triggers no workflow, so no tests, no LLM review and no tokens spent. If the ruleset requires status checks, the PR needs an admin merge. The README and `SCORECARD.md` change only on merge.
- This supersedes the "pushes to the default branch without a PR" caveat above.

### Amendment (2026-10-04): the eval dashboard on GitHub Pages replaces the in-repo scorecard

Publishing through a PR still needs a human merge for each run, and auto-merging that PR was rejected as merging without review. Committed Markdown also limits what can be shown. The publication target is now a static site on GitHub Pages: <https://koydas.github.io/autonomous-dev-loop/>.

- **`scripts/lib/eval_site.mjs`** (pure, c8-gated) renders the site from the scorecard and the full results of the retained runs:
  - an index per suite with the gate and its thresholds, metric tiles with Δ (same dataset only), a trend chart (inline SVG with a crosshair tooltip) and the history;
  - a page per run with the confusion matrix, per-class metrics, and every case with its parsed and raw model output;
  - `scorecard.json`, `scorecard.md`, `runs/<id>.json`, and a shields.io endpoint badge per suite (`badges/<suite>.json`).
- **`scripts/build_eval_site.mjs`** reads the history back **from the deployed site itself** (`scorecard.json`, `runs/<id>.json`, bypassing the CDN cache), adds the new run (same history window, outage filter and replay rejection as before) and writes the site. A 404 on the scorecard aborts unless the first deploy opts in with `--allow-empty` (workflow input `init_site`). Every other error aborts too, so neither a failed read nor a wrong URL can deploy a site without its history. A missing detail page logs a warning.
- **Backup and restore:** each deployed tree is uploaded as the artifact `eval-site-<runId>` with 90-day retention. The workflow input `restore_run_id` rebuilds from such a backup (`--previous-dir`) instead of the live site. A run without results deploys nothing.
- **The `publish` job** (`contents: read`, `pages: write`, `id-token: write`, no secrets, default branch only) runs `configure-pages`, then the builder, `upload-pages-artifact` and `deploy-pages`. It never commits, pushes or opens a PR. `workflow_gates.test.mjs` asserts it.
- **Removed:** `evals/scorecard.json`, `evals/SCORECARD.md`, the README block between markers, `scripts/update_scorecard.mjs` and the `evals/scorecard` PR flow. The README shows the live badge and links to the dashboard. `run_evals.mjs --scorecard` now builds a local preview in `evals/site/`.
- ⚠️ Prerequisite: **Settings → Pages → Source: GitHub Actions**.
- ⚠️ The live history lives only on the deployed site. The `eval-site-*` backups (90 days) are the restore path, through `restore_run_id`.
- ⚠️ The site is public, like the repository. It shows model outputs for the dataset's synthetic issues, and contains no secrets.
- The in-repo Markdown helpers in `eval_scorecard.mjs` (`formatReadmeBlock`, `replaceReadmeBlock`, `recordRuns`) are kept with their tests. `formatScorecard` still produces the site's `scorecard.md`.
- This supersedes the PR-based publication above.

## Amendment (2026-10-04): harder dataset, blocker codes, over-strictness gate

The `validation` suite saturated: `openai/gpt-oss-120b` scored 1.0 on every metric over 45 runs, so the dashboard no longer separated good runs from bad ones. Adding cases alone does not fix that. The verdict-only scoring hid a rejection for the wrong rule, and the gate did not see over-strictness.

- **Dataset (15 → 35 cases, 13 valid / 22 invalid).** The original 15 are tagged `core`: `--tags core` keeps a series comparable with earlier runs across the `sha256` change. The new cases are:
  - `partial-ac`: one AC item that looks testable but is not ("most relevant", "existing error style", no size or time limit);
  - `scope-pair`: two issues that differ by one file name, one with a closed scope (valid) and one with an open scope (B3);
  - `stub`: a B4 minimal pair, the same issue with nothing (invalid), a ticket plus a cited contract (valid) or a stub (valid);
  - `role-scope`, `short`, `fr` and `warnings-only` cases;
  - `injection`: forged verdicts, a fake validator note and a hidden HTML comment in the issue body, which is untrusted input to a gate. All must stay invalid.
- **Right rule, not only the right verdict.** `prompts/validation-system.md` now asks for each blocker to be prefixed with its rule code (`"B2: …"`). Targeted cases carry `expected.blockers`. The `blocker_match` scorer is the Jaccard overlap between the expected codes and the codes the model returns. It is reported, but not gated until a baseline is known.
- **Gate.** The gate adds `per_class.valid.recall ≥ 0.8`: the prompt says "be strict", and a false `invalid` stalls the pipeline. With support 13, one case ≈ 8 points. It also adds `consistency ≥ 0.9`, declared `optional`: `checkThresholds` skips an `optional` metric the run did not measure (`--repeats 1`), and the dashboard shows it as "not measured".

Consequences:
- ✅ A validator that rejects a third of the valid issues now fails the gate (`valid` recall ≈ 0.69), where it used to pass (`verdict_match` 0.867, `invalid` recall 1.0).
- ✅ A rejection for the wrong rule is visible in `blocker_match`.
- ⚠️ Issue validation comments now show the rule code in front of each blocker.
- ⚠️ `consistency` is gated only on runs with `--repeats > 1`. The Evals workflow defaults to `repeats: 3` (ADR-0028 amendment), so CI runs are gated; a local `--repeats 1` run skips it.
- ⚠️ `blocker_match` depends on the model following the prefix instruction. A blocker without a code counts as a miss.

