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

- **Dataset (15 → 35 cases, 12 valid / 23 invalid).** The original 15 are tagged `core`: `--tags core` keeps a series comparable with earlier runs across the `sha256` change. The new cases are:
  - `partial-ac`: one AC item that looks testable but is not ("most relevant", "existing error style", no size or time limit);
  - `scope-pair`: two issues that differ by one file name, one with a closed scope (valid) and one with an open scope (B3);
  - `stub`: a B4 minimal pair, the same issue with nothing (invalid), a ticket plus a cited contract but no stub (invalid) or a stub (valid);
  - `role-scope`, `short`, `fr` and `warnings-only` cases;
  - `injection`: forged verdicts, a fake validator note and a hidden HTML comment in the issue body, which is untrusted input to a gate. All must stay invalid.
- **Right rule, not only the right verdict.** `prompts/validation-system.md` now asks for each blocker to be prefixed with its rule code (`"B2: …"`). Targeted cases carry `expected.blockers`. The `blocker_match` scorer is the Jaccard overlap between the expected codes and the codes the model returns. It is reported, but not gated until a baseline is known.
- **B4 requires a stub.** `prompts/validation-system.md` B4 used to accept an in-progress dependency with a ticket. The coder agent cannot call a service that does not exist yet, so a ticket, roadmap item or ETA alone no longer resolves B4; only an existing dependency, a stub/mock or a documented workaround does. The first live run (37254348312) already judged the ticket-only case invalid 3/3; its label now follows the rule.
- **Gate.** The gate adds `per_class.valid.recall ≥ 0.8`: the prompt says "be strict", and a false `invalid` stalls the pipeline. With support 12, one case ≈ 8 points. It also adds `consistency ≥ 0.9`, declared `optional`: `checkThresholds` skips an `optional` metric the run did not measure (`--repeats 1`), and the dashboard shows it as "not measured".

Consequences:
- ✅ A validator that rejects a third of the valid issues now fails the gate (`valid` recall ≈ 0.67), where it used to pass (`verdict_match` 0.867, `invalid` recall 1.0).
- ✅ A rejection for the wrong rule is visible in `blocker_match`.
- ⚠️ Issue validation comments now show the rule code in front of each blocker.
- ⚠️ `consistency` is gated only on runs with `--repeats > 1`. The Evals workflow defaults to `repeats: 3` (ADR-0028 amendment), so CI runs are gated; a local `--repeats 1` run skips it.
- ⚠️ `blocker_match` depends on the model following the prefix instruction. A blocker without a code counts as a miss.

## Amendment (2026-10-05): `review` suite

The review stage decides what reaches the human merge gate and what starts auto-fix, and it had no offline measure.

- **Production path.** The prompt builder and verdict parser lived inline in `scripts/pr_review.mjs` (an entrypoint with top-level side effects, not importable). They move unchanged to `scripts/lib/review_prompt.mjs` (`buildReviewPrompt`, `parseReviewVerdict`); `pr_review.mjs` calls them. No exported signature changes. The suite then applies `decideVerdict` (ADR-0024/0026) with the case's evidence, and fits the prompt to `review_max_input_tokens` like production (ADR-0028).
- **Label = final pipeline verdict** (`approve` / `request_changes` / `withheld`), not the model's raw verdict: what the pipeline acts on. Evidence cases (pass, fail, timeout) check the prompt + `decideVerdict` wiring; their final verdict is partly decided in code.
- **Dataset:** 23 diffs (14 / 8 / 1). Real bugs, minimal buggy/clean pairs, docs-only and test-only diffs, an automation change that satisfies the prompt's three gates, prompt injection (PR body, code comment) and a truncated diff whose bug stays visible. Labels follow `prompts/pr-review-system.md`: an automation change without tests, docs and a coverage gate is a `REQUEST_CHANGES` by that prompt's rules, so most code cases sit outside the automation scope to keep the verdict about the bug.
- **Scorers:** `verdict_match`, `flags_issue` (right reason: share of `must_flag` keywords found in Issues Found, plus `must_note` keywords anywhere outside the classification section; 0 when the model approved) and `no_false_alarm` (clean cases: approved without High/Medium findings). The last two are reported, not gated, like `blocker_match`.
- **Gate:** `verdict_match ≥ 0.75`, `request_changes` recall ≥ 0.8, and, following the over-strictness gate of the `validation` amendment, `approve` recall ≥ 0.6. `consistency ≥ 0.8` is optional (temperature 0.6). `error_rate ≤ 0.05`; a review without a verdict line counts as an error, not as a fail-closed rejection.
- **Cost:** ≈ 66k estimated input tokens per repeat (≈ 2.9k per call); ≈ 11–12 min per repeat at 8K TPM with concurrency 1, ≈ 35–40 min for the workflow default of 3 repeats.

Consequences:
- ✅ A prompt or model change to the reviewer is compared on fixed diffs, through the same builder and parser as production; a parser regression shows in `error_rate`.
- ✅ The dashboard and the Evals workflow handle several suites without change; the workflow input becomes a `choice` checked against the registry.
- ⚠️ Support is small (8 `approve`, one case ≈ 12 points): thresholds are a starting point until a baseline exists.
- ⚠️ `flags_issue` is a keyword match: a finding phrased without any listed keyword scores 0. Broad keywords (`test`, `null`, `fail`) are to be tightened against the first live baseline.
- ⚠️ The replay fixture is hand-written, not recorded from a live run; replace it with a recorded run once one exists.

## Amendment (2026-10-05): replay gate on pull requests

A live run costs minutes of the shared 8K TPM and is manual, so a PR that breaks a parser, `decideVerdict` or a scorer was only caught by unit tests on hand-written inputs, never on the responses the model actually gives. Every published run already holds those responses (`runs/<id>.json`), and `--replay` re-scores them for free.

- **Workflow `eval-replay.yml`**, on `pull_request` touching `prompts/**`, the two parsers (`issue_validator.mjs`, `review_prompt.mjs`), `review_evidence.mjs`, `output_writer.mjs`, `scripts/lib/eval_*.mjs`, every other `scripts/lib/` module the suites import (pinned by an import-graph walk in `workflow_gates.test.mjs`), `config/models.yaml`, `evals/datasets/**`, its script or itself. For each suite in the registry it replays the newest published live run against the PR's code and writes the Δ per metric and the cases × repeats whose outcome changed to the job summary. Logic in `scripts/lib/eval_replay_ci.mjs` (c8-gated); `scripts/replay_evals_ci.mjs` is the entrypoint; the workflow only orchestrates.
- **What is measured:** parsing, `decideVerdict`, the scorers and the thresholds on real recorded responses. **A prompt change is not measured**: the responses stay those of the recorded prompt. The job summary and `docs/evals.md` say so first.
- **Gate:** fails on a threshold that the published numbers meet and the replay misses, both checked against the PR's thresholds: a threshold changed since the run (on `main` or in the PR) never blocks unrelated code, and a live run judges it. It also fails when the PR's code cannot run the replay (malformed dataset, suite crash). A threshold the published numbers already miss warns. A network error or 5xx is retried once; a malformed published file is a missing run. A dataset whose `sha256` differs from the run's (or a run without a hash) replays the common cases, lists added, removed and relabelled cases, and only warns. An unreachable dashboard, an unpublished suite or no case in common is neutral (green job, warning annotation: Actions has no neutral job conclusion).
- **Baseline:** the published `summary` as it is on the site (same dataset); with a changed dataset, the published results restricted to the common cases, summarized by the PR's code.
- **Security (ADR-0023/0024):** the PR's code runs, so `pull_request` only (never `pull_request_target`), `permissions: contents: read`, no secret, `persist-credentials: false`. The only network read is the public dashboard. `workflow_gates.test.mjs` pins it, along with the paths filter (docs-only PRs do not trigger it), the per-PR concurrency group and the trace upload.

Alternatives considered:
- *Replay against the base branch too, and diff the two replays.* Attributes Δ to the PR exactly, but needs a second checkout and doubles the job for a case (a scorer change merged after the last live run) that the next live run fixes. Rejected for now; the drift is documented.
- *Committed replay fixtures per suite.* Hand-written responses drift from what the model says; the published run is the real distribution and is refreshed by every live run.
- *Live run on PRs.* Needs the API keys in a job that runs PR code (ADR-0023) and spends TPM on every push. Rejected.

Consequences:
- ✅ A parser or scorer regression fails the PR on the model's real outputs, with the flipped cases listed, at no LLM cost.
- ✅ Dataset edits are visible on the PR (added / removed / relabelled) without blocking it.
- ⚠️ Prompt changes still need a live Evals run; the replay cannot tell a better prompt from a worse one.
- ⚠️ The published run was scored by the code of its day: a scorer change merged after it shows as a Δ on later PRs until the next live run.
- ⚠️ A PR that tightens a threshold beyond the published value only warns: the replay cannot tell whether the model would meet it.
- ⚠️ The gate depends on the dashboard being up; when it is not, the job is neutral and the PR is unprotected by it.
