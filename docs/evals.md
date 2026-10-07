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

CI: **Actions → Evals → Run workflow** (`workflow_dispatch`), plus a [weekly run](#weekly-run) of every suite. The report is on the run's summary page, results and trace are uploaded as artifacts, and, on the default branch, the run is added to the [eval dashboard](#dashboard) on GitHub Pages (`publish` input, on by default).

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

## PR replay gate

> **A prompt change is not measured.** The replay serves the responses the model gave to the *recorded* prompt, so changing `prompts/*.md` cannot move the scores here. The replay validates what runs on those responses: the parsers (`issue_validator.mjs`, `review_prompt.mjs`), `decideVerdict` (`review_evidence.mjs`), the scorers and the thresholds, plus the prompt wiring (a template that no longer loads or interpolates makes every case error). To measure a prompt change on a PR, use the [live PR eval](#live-pr-eval-run-evals-label); for a model change, run the [Evals workflow](#run) live.

`.github/workflows/eval-replay.yml` runs on `pull_request` when the PR touches `prompts/**`, `scripts/lib/issue_validator.mjs`, `scripts/lib/review_prompt.mjs`, `scripts/lib/review_evidence.mjs`, `scripts/lib/output_writer.mjs`, `scripts/lib/eval_*.mjs`, every other `scripts/lib/` module the suites import (`prompts.mjs`, `config.mjs`, `token_budget.mjs`, … — `workflow_gates.test.mjs` walks the import graph and fails on an uncovered one), `config/models.yaml`, `scripts/replay_evals_ci.mjs`, `evals/datasets/**` or the workflow itself. A PR that only changes docs does not trigger it. For each suite in the registry, `scripts/replay_evals_ci.mjs` (logic in `scripts/lib/eval_replay_ci.mjs`):

1. reads `scorecard.json` from the [dashboard](#dashboard), then `runs/<id>.json` of the newest run of the suite (a run without a detail page is skipped, with a warning, for the previous one);
2. replays it against the PR's code with the recorded repeat count, as `--replay` does;
3. writes the job summary: published vs replay value and Δ for `error_rate`, every `scores.*.mean`, `consistency` and per-class precision/recall/F1 (latency and tokens are left out because a replay does not measure them), then every case × repeat whose outcome (label, or error) changed.

| Situation | Outcome |
|---|---|
| A threshold the published numbers meet fails in the replay | ❌ job fails (`::error::`) |
| The PR's code cannot run the replay (malformed dataset, suite module that throws on import) | ❌ job fails (`eval_replay.error`) |
| A threshold the published numbers already miss still fails | ⚠️ warning, not blocking |
| Dataset changed since the run (`meta.dataset_sha256` ≠ current file), or the run recorded no hash | ⚠️ only the common cases are replayed; added, removed and relabelled cases are listed; thresholds are advisory (warnings) |
| Dashboard unreachable (network, 404, unsupported format), suite never published, or no case in common | ⚪ neutral: warning, exit 0 |

- **Thresholds:** both sides are checked against the PR's `thresholds`, the published numbers included (not the `failures` recorded with the thresholds of the run's day). Only the code's effect on the recorded responses can block; a threshold changed since the run, on `main` or in the PR, never does — a live run judges it.
- **Robustness:** a network error or a 5xx on the site is retried once. A malformed published file is treated as a missing run (neutral), never as a crash.
- **Baseline:** with an unchanged dataset, the published `summary` as it is on the site. With a changed dataset, the published results restricted to the common cases, summarized by the PR's code.
- ⚠️ The published run was scored by the code of its day. A scorer change merged to the default branch after the last live run therefore shows up as a Δ on every PR until the next live run.
- **Security:** the PR's code runs, so the workflow uses `pull_request` (never `pull_request_target`), `permissions: contents: read`, no secret, `persist-credentials: false` (ADR-0023/0024). The site URL defaults to `https://<owner>.github.io/<repo>`; the repository variable `EVAL_SITE_URL` overrides it.
- GitHub Actions has no "neutral" job conclusion: a neutral outcome is a green job with a warning annotation and a ⚪ summary.
- **Locally:** `node scripts/replay_evals_ci.mjs --site-url https://koydas.github.io/autonomous-dev-loop [--suite review]`, or `--site-dir <unzipped eval-site-<runId> artifact>` offline.

## Live PR eval (`run-evals` label)

Measures a PR's **prompt** change live, with the PR's prompts and the default branch's everything else, and comments the comparison with the last published run ([ADR-0030](./adr/0030-live-pr-prompt-evals.md)). `.github/workflows/pr-evals.yml`, logic in `scripts/lib/pr_evals.mjs`.

**Trigger** (a human with write access, never automatic):
- add the **`run-evals`** label to the PR → `repeats: 1`;
- or **Actions → PR evals → Run workflow** from the default branch with `pr_number` and `repeats: 3` (consistency; `review` ≈ 35 min).

The label is removed after the run, whatever the outcome; add it again to re-run. A label set by someone without `write`/`maintain`/`admin` permission, or a push to the PR between the label and the run, gets a ⛔ refusal comment.

**Suites** come from the changed prompts: `prompts/validation-*` → `validation` (≈ 4–6 min per repeat on the Groq free tier), `prompts/pr-review-*` → `review` (≈ 11–12 min). Other prompts (`generation-*`, `auto-fix-*`) have no suite: "nothing to run".

**What runs where:**

| Job | Does | Token | Secrets |
|---|---|---|---|
| `plan` | checks the trigger, lists the PR's changes from its merge base, keeps `prompts/**` as git blobs → `plan.json` | `contents: read`, `pull-requests: read` | none |
| `eval` | default-branch checkout, writes the PR's prompts over `prompts/`, runs the default branch's `run_evals.mjs` per suite | `contents: read` | LLM keys |
| `comment` | compares with the dashboard (`scripts/report_pr_evals.mjs`), posts the comment, removes the label | `pull-requests: write` | none |

- **Refused** when the PR also touches `scripts/` or `config/` (the run would use the default branch's code, not the PR's: split the prompt change out), or ships a prompt that is a symlink, a submodule, over 64 KiB, or has an unsafe path (incl. control characters). Other files (docs, datasets, `.github/`) are ignored: the default branch's version is used and the comment lists them.
- **Comparison:** same table as the [replay gate](#pr-replay-gate) — published vs PR value and Δ per quality metric, thresholds (❌ a threshold the published run meets and the PR misses; ⚠️ already failing; advisory when the dataset changed since the published run, Δ then over the common cases), and every case × repeat that changes verdict. A different model or repeat count is flagged: the Δ then mixes causes. An unreachable dashboard or an unpublished suite still shows the PR's numbers, without a baseline.
- **Noise:** with `repeats: 1`, one flipped case moves `verdict_match` by 1/cases, and `review` samples at temperature 0.6. Confirm a small Δ with `repeats: 3`.
- **Never published** to the dashboard: the PR's results stay in the `pr-evals-results-<runId>` artifact.
- ⚠️ The PR's changed prompt files replace the default branch's wholesale. If the default branch changed the same prompt since the PR branched, rebase before running.
- **Locally**, the same comparison over a downloaded results file: `node scripts/report_pr_evals.mjs --plan plan.json --results-dir <dir> --site-url https://koydas.github.io/autonomous-dev-loop --out report.md`.

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

### Weekly run

`evals.yml` also runs on `schedule`, **Mondays 06:23 UTC** (`23 6 * * 1`, off the hour: GitHub delays `:00` schedules). The [replay gate](#pr-replay-gate) and the [live PR eval](#live-pr-eval-run-evals-label) compare with the last published run; without a regular run that reference goes stale.

- **What runs:** every suite of the registry (`validation`, `review`), `repeats: 3`, on the default branch, published. On `schedule` the workflow inputs are empty, so the defaults are explicit: `publish` on, `repeats` 3, **`init_site` off and no `restore_run_id`**. An unattended run never starts an empty history nor restores a backup; a 404 on the deployed scorecard fails the run instead. `workflow_gates.test.mjs` pins this.
- **One suite at a time:** a matrix job per suite with `max-parallel: 1` (they share the 8K TPM) and `fail-fast: false`: a threshold miss, a crash or a timeout in one suite never cancels the next. Each suite job has its own 120 min timeout.
- **One deploy:** the `publish` job downloads every `eval-results-<runId>-<suite>` artifact (`pattern` + `merge-multiple`) and passes all results files to `build_eval_site.mjs` in one build, then deploys once. A suite that failed on `error_rate` (provider outage) is skipped with a warning; the other suites are published. A suite whose job produced no results is simply absent.
- **Run IDs:** every run of `evals.yml` (weekly or manual) records `meta.run_id = <workflow run ID>-<suite>` (`EVAL_RUN_ID`) and `meta.workflow_run_id = <workflow run ID>`. The dashboard keys `runs/<id>.json` by `run_id` alone, so two suites of one workflow run must not share it; `build_eval_site.mjs` refuses a build where two suites use the same `run_id`. Runs published before this change keep their bare numeric IDs. The run page links the workflow run through `workflow_run_id`.
- **Duration:** validation ≈ 4–6 min per repeat, review ≈ 11–12 min per repeat: **≈ 50–60 min end to end** (≈ 15 + 35 min of evals, plus runner setup and the deploy). Worst case: each suite up to its 120 min timeout.
- **Tokens per week** (chars/4 estimate, the harness's `tokens_est`): validation ≈ 71k input per repeat (35 calls × ≈ 1.9k system prompt + the issue), review ≈ 66k (23 calls × ≈ 2.9k); × 3 repeats ≈ **410k input tokens per week**, plus at most ≈ 180k output tokens (`max_tokens` × calls; actual output is far lower).

**Concurrency with other eval runs:**

| Overlap | Behavior |
|---|---|
| Weekly run + manual `evals.yml` run on the default branch | Same group (`evals-<ref>`): the second one waits. GitHub keeps one pending run per group, so a third run cancels the **pending** one, never the running one (`cancel-in-progress: false`). |
| Weekly run + `pr-evals.yml` | Different groups (`evals-<ref>` vs `pr-evals-<PR>`): neither waits for the other. Both call Groq with the same key and share its TPM: each waits out the other's 429s (ADR-0028), so both run slower while they overlap but neither fails for it. A weekly review suite overlapping a 3-repeat PR review eval can roughly double in duration, still inside its timeout in the usual case. |
| Weekly run + `eval-replay.yml` | No LLM call in the replay. A replay that reads the site during the deploy sees either the previous or the new tree. |

There is deliberately no global group serializing LLM workflows: GitHub would cancel every pending run beyond the first (`workflow_gates.test.mjs`).

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

- Dataset (`evals/datasets/review.jsonl`, 23 cases: 14 `request_changes`, 8 `approve`, 1 `withheld`): `{ id, tags, input: { title, body, diff, dependencies?, evidence?, head_sha? }, expected: { verdict, must_flag?, must_note? } }`. `dependencies` replaces the target repo's `package.json` (dependency manifest context). `evidence` is an evidence file as written by `run_review_evidence.mjs`; a case without it is a repository that has not opted in, so missing evidence does not withhold an approval.
- Cases: real bugs (`off-by-one`, `null`, `shell-injection` via `execSync`, `deleted-test`, `undeclared-import`, the prompt's named checks, an unawaited `forEach`, `missing-tests`), unrequested docs deletion, minimal `pair`s (same issue, buggy vs clean diff), clean `docs` and `test-only` diffs (`tests_expected: false` per `change_classifier`), a complete `automation` change (tests + docs + c8 gate), `injection` in the PR body and in a code comment, `evidence` (pass, fail, timeout) and a `truncated` diff whose bug stays visible.
- A review without a verdict line is an **errored run** (`error_rate`), not a `REQUEST_CHANGES`: production fails closed, but counting it as a rejection would inflate `request_changes` recall.

| Scorer | Applies to | Meaning |
|---|---|---|
| `verdict_match` | all | Final verdict = `expected.verdict` |
| `flags_issue` | cases with `must_flag` / `must_note` | Share of entries the review raises. `must_flag` is searched in the Issues Found section only (a Summary that describes the diff is not a finding); `must_note` (the truncation note the prompt puts under the summary) anywhere outside the Change Classification section. An approving review scores 0. An entry is `"a\|b\|c"`: any alternative, case-insensitive substring. Not gated |
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
- `scripts/lib/eval_replay_ci.mjs` (PR replay gate) is under the same c8 gate, measured with `eval_replay_ci.test.mjs`, which also runs `scripts/replay_evals_ci.mjs` end to end against a local copy of the site.
- **Weekly run / per-suite `run_id` (minimum coverage policy):** `scripts/lib/eval_site.mjs` stays under the CI-enforced 80% c8 gate (lines, branches, functions, statements) in `test.yml`, including the `workflow_run_id` link. `scripts/build_eval_site.mjs` is an entrypoint outside the c8 gates; its `run_id` collision guard (same batch, against the history, same-suite re-run, skipped outage, missing `run_id`) and the multi-suite build are covered by `build_eval_site.test.mjs` (100% lines, 94% branches with `node --test --experimental-test-coverage`; keep it ≥ 80%). `EVAL_RUN_ID` and its fallback are exercised end to end by `eval_suites.test.mjs`.
- The workflow is YAML, which c8 cannot measure. `workflow_gates.test.mjs` pins its shape instead: the job split, the default-branch condition, the Pages permissions and actions, and that it never pushes, commits or opens a PR. For the weekly run: the cron (Monday, off the hour), the suite matrix against the registry, `max-parallel: 1` / `fail-fast: false`, the per-suite `EVAL_RUN_ID` and artifact names, the merged download, a single deploy, the disjoint `evals` / `pr-evals` concurrency groups, and that `init_site` and `restore_run_id` are read only behind the `schedule` guard. For `eval-replay.yml`, it pins `pull_request` only, the read-only token, no secret, the paths filter (docs-only changes do not trigger it), the per-PR concurrency group and the trace upload.

## Results file

`evals/results/<suite>-<runId>.json` = `{ meta, summary, failures, results[] }`. Each result keeps `case_id`, `repeat`, `output`, `label`, `scores`, `error` and `calls[]` (`raw`, `latency_ms`, token estimates) — the `raw` responses are what `--replay` serves.
