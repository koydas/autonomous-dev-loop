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
- **Mixed models:** a run with any call whose `calls[].provider:calls[].model` differs from `meta.model` (`replay:` prefix ignored) is skipped with a warning (`partitionPublishable`). Live runs are pinned to the primary provider (see [Provider pinning](#provider-pinning)), so this is defense in depth. Results recorded without `calls[].provider` are not checked.
- **One model per history** (ADR-0032 amendment 2026-10-14): a run whose `meta.model` differs from the suite's latest published run is not appended (`partitionByPublishedModel`, `::notice::`). The first run of an empty suite sets its model. Such a run stays in its `eval-results-*` artifact and the step summary. On `schedule` or `provider: repo-variable`, the mismatch is model drift on the configured provider (a `GROQ_MODEL` bump, a retirement): the `publish` job fails (`--fail-on-model-change`, `::error::`) instead of freezing the history behind a notice. Re-baselining is [#209](https://github.com/koydas/autonomous-dev-loop/issues/209).
- **Safety:** a 404 on `scorecard.json` aborts the job unless the `init_site` input is ticked. Tick it **for the first deploy only**: a 404 can also come from a wrong URL or an edge glitch, and must never silently start a new history. Any other read error aborts too. A missing `runs/<id>.json` logs a warning and keeps the history row without its detail page. Replays are rejected.
- **Restore:** every deployed tree is kept as `eval-site-<runId>` for 90 days. To roll back after a bad build, run the workflow with `restore_run_id` set to the last good run's ID. The history then comes from that backup instead of the live site, and the eval run that comes with the restore is added on top. Locally: `npm run eval:site -- --out <dir> --previous-dir <unzipped eval-site artifact>`.
- **Least privilege:** the `publish` job has `pages: write` and `id-token: write`, no `contents: write` and no secrets. The `eval` job, which holds the API keys and handles LLM output, is read-only.
- **Prerequisite:** **Settings → Pages → Build and deployment → Source: GitHub Actions**, set before the first run. Without it, `actions/configure-pages` fails with an explicit error. The first run also needs `init_site` ticked.
- ⚠️ The live history exists only on the deployed site. The `eval-site-*` backups cover 90 days.

### Weekly run

`evals.yml` also runs on `schedule`, **one cron per suite: `validation` Mondays 06:23 UTC (`23 6 * * 1`), `review` Wednesdays 06:23 UTC (`23 6 * * 3`)**, off the hour (GitHub delays `:00` schedules). The [replay gate](#pr-replay-gate) and the [live PR eval](#live-pr-eval-run-evals-label) compare with the last published run; without a regular run that reference goes stale.

- **What runs:** each scheduled run evaluates **one** suite, `repeats: 3`, on the default branch, published. The matrix maps the cron string (`github.event.schedule`) to its suite through a JSON literal; `workflow_gates.test.mjs` checks that every cron is mapped and every registered suite has exactly one cron (a new suite needs its own cron day). On `schedule` the workflow inputs are empty, so the defaults are explicit: `publish` on, `repeats` 3, **`init_site` off and no `restore_run_id`**, **no `EVAL_TOKEN_BUDGET`** ([why](#token-budget)). An unattended run never starts an empty history nor restores a backup; a 404 on the deployed scorecard fails the run instead. `workflow_gates.test.mjs` pins this.
- **Why one suite per run:** one suite × 3 repeats fills most of Groq's free-tier 200k TPD; two in a row do not fit ([Token budget](#token-budget), run 38271632735). The two days are 48 h apart: GitHub can delay a schedule by hours (that run started 15:37 UTC), and the next suite must start on a TPD the previous one no longer holds, whether Groq's window is a rolling 24 h or a bucket refilling over 24 h. `workflow_gates.test.mjs` fails on two suite days less than 48 h apart.
- **One suite at a time:** the matrix keeps `max-parallel: 1` (manual runs) and `fail-fast: false`. Each suite job has its own 120 min timeout.
- **One deploy per run:** the `publish` job downloads every `eval-results-<runId>-<suite>` artifact (`pattern` + `merge-multiple`) and passes all results files to `build_eval_site.mjs` in one build, then deploys once. A weekly run publishes its one suite; the two runs of a week are two deploys, 48 h apart and serialized by the `evals-<ref>` concurrency group, so they never race on the site. A suite that failed on `error_rate` (provider outage, circuit breaker) is skipped with a warning. A suite whose job produced no results is simply absent.
- **Run IDs:** every run of `evals.yml` (weekly or manual) records `meta.run_id = <workflow run ID>-<suite>` (`EVAL_RUN_ID`) and `meta.workflow_run_id = <workflow run ID>`. The dashboard keys `runs/<id>.json` by `run_id` alone, so two suites of one workflow run must not share it; `build_eval_site.mjs` refuses a build where two suites use the same `run_id`. Runs published before this change keep their bare numeric IDs. The run page links the workflow run through `workflow_run_id`.
- **Duration:** validation ≈ 18 min (3 repeats, run 38271632735), review ≈ 11–12 min per repeat, ≈ 35–40 min. Worst case: the 120 min timeout.
- **Tokens per week:** see [Token budget](#token-budget). Each suite day spends up to the whole TPD, shared with production.

**Concurrency with other eval runs:**

| Overlap | Behavior |
|---|---|
| Weekly run + manual `evals.yml` run on the default branch | Same group (`evals-<ref>`): the second one waits. GitHub keeps one pending run per group, so a third run cancels the **pending** one, never the running one (`cancel-in-progress: false`). |
| Weekly run + `pr-evals.yml` | Different groups (`evals-<ref>` vs `pr-evals-<PR>`): neither waits for the other. Both call Groq with the same key and share its TPM: each waits out the other's 429s (ADR-0028), so both run slower while they overlap but neither fails for it. A weekly review suite overlapping a 3-repeat PR review eval can roughly double in duration, still inside its timeout in the usual case. |
| Weekly run + `eval-replay.yml` | No LLM call in the replay. A replay that reads the site during the deploy sees either the previous or the new tree. |

There is deliberately no global group serializing LLM workflows: GitHub would cancel every pending run beyond the first (`workflow_gates.test.mjs`).

**Locally:** `npm run eval -- --suite validation --repeats 3 --scorecard` adds the run to a preview in `evals/site/`; open `evals/site/index.html`. To rebuild from downloaded artifacts, run `npm run eval:site -- --out evals/site --previous-dir evals/site <results.json…>`, or `--site-url https://koydas.github.io/autonomous-dev-loop` to start from the live history.

## Token budget

> **The Groq free tier caps `openai/gpt-oss-120b` at 200k tokens per day (TPD) per organization, shared with the production pipeline** (validation, generation, review, auto-fix use the same `GROQ_API_KEY`). The 8K TPM is waited out (ADR-0028); the TPD is not: once spent, every call fails until tokens age out of the window.

Groq does not count cached prompt tokens against its rate limits ([Groq rate limits](https://console.groq.com/docs/rate-limits), [prompt caching](https://console.groq.com/docs/prompt-caching)); cache hits are best-effort. Every case of a suite shares its system prompt (≈ 1.9k of ≈ 2.7–2.9k estimated input tokens), so the counted cost of a run is well under its chars/4 estimate.

| Run | Estimate (`tokens_est`, chars/4) | Groq-counted | Source |
|---|---|---|---|
| `validation` × 3 (105 calls) | 283k in + 21k out | **≤ 199k**: the run completed under the TPD, and the next job found `Used 199205` (that figure also holds the previous 24 h of production) | run 38271632735 |
| `review` × 3 (69 calls) | ≈ 200k in (≈ 66k per repeat) + ≤ 70k out (`max_tokens`) | not measured. If the cache discount is the same as validation's (≤ 0.65 × estimate): ≈ 130–175k | assumption |
| both suites × 3, back to back | ≈ 575k | > 200k: review hit the TPD on every call (`Used 199205`, `Requested 2687`) | run 38271632735 |

`try again in` on a TPD 429 is exactly `(used + requested − 200000) / (200000 / 86400 s)` (e.g. 1892 tokens → 13m37s, 8366 → 1h0m14s): about 8.3k tokens come back per hour, the whole quota in 24 h.

**Pre-flight estimate.** `eval.start` logs `meta.cases`, `meta.tokens_est`, `meta.tokens_est_per_run` and `meta.tokens_est_source`: runs (cases × repeats) × tokens per run, the larger of the newest error-free live run of the suite in `EVAL_HISTORY_FILE` (`history:<run_id>`; local only, a CI runner starts with no history) and the suite's static `tokensPerRunEst` (`static`). A replay costs nothing (`replay`, 0). `eval.start` is logged once the dataset is loaded; a failure before that still logs a bare `eval.start` before `eval.error`. The estimate is cache-blind, so it overstates a Groq run: validation × 3 = 35 × 3 × 2700 = **283,500**, review × 3 = 28 × 3 × 5300 = **445,200** (23 × 3 × 4200 = 289,800 before the [incident cases](#incident-cases)).

**`EVAL_TOKEN_BUDGET`** (env; repository variable `EVAL_TOKEN_BUDGET` in `evals.yml` and `pr-evals.yml`, unset = no cap): a live run whose estimate exceeds it is refused before any LLM call (`eval.error`, exit 1, no results file). A non-integer value, or a budget with no estimate available, is refused too. Replays ignore it. **Scheduled runs never read it** (`evals.yml` passes `''` on `schedule`): any cap under the TPD would refuse both weekly suites before their first call, and a cap above 290k protects nothing. Manual and PR runs keep it.

**Another provider for one run** (issue #199, ADR-0032 amendment 2026-10-14). The `provider` input (`repo-variable` default, `groq`, `anthropic`) sets `AI_PROVIDER` for the eval step only; `schedule` ignores it, and production keeps `vars.AI_PROVIDER`. A run on a model other than the suite's published one is never added to the dashboard history (see [Dashboard](#dashboard)), so dispatch it with `publish` off, e.g. `suite: review, provider: anthropic, publish: false`. The step **Report run vs published baseline** (`build_eval_site.mjs --report`, no API key, never fails the job) writes to the step summary, for this run and the suite's latest published run:

- scores and `error_rate`;
- **cost** for priced models (`PRICES_USD_PER_MTOK` in `eval_scorecard.mjs`, the one price table, list price: Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 per MTok, Haiku's for a prompt ≤ 100K tokens per call, `unpriced` above; Groq free tier: `—`; any other model missing from the table: `unpriced`), on the **chars/4 estimate**, labelled `chars/4 estimate, thinking tokens excluded`: `anthropic_client.mjs` does not return the API's usage. It ignores the prompt cache (input over-estimated) and thinking tokens (output under-estimated, more so at a higher effort);
- **review coverage**: share of runs whose diff was cut to the input budget / with code files cut (`unreviewed_code_files`) / with a `WITHHELD` verdict (ADR-0038). On Anthropic the review has no input budget, only the 12,000-char diff cap. Published runs recorded before ADR-0038 show `—` for code cut.

Both fields (`cost_est`, `coverage`) are also recorded in every scorecard row and shown in `scorecard.md`.

### Measuring a model

<a id="measuring-a-model"></a>A stage moves to a provider or model in production only after its eval suite passes the ADR-0031 gates on that model (ADR-0032 amendment 2026-10-17). The `anthropic_<stage>` defaults in `config/models.yaml` (Haiku 5.5 for validation, Sonnet 5.5 elsewhere) are provisional until then. Protocol:

1. Dispatch `evals.yml` with `suite: <stage suite>`, `provider: anthropic`, `anthropic_model: <model>` (empty = the stage's `anthropic_<stage>`), optionally `anthropic_effort: <level>` (`models-yaml` = `anthropic_<stage>_effort`), `repeats: 3` (the consistency gate needs it), `publish: false`. Both inputs reach the eval step only, as `EVAL_ANTHROPIC_MODEL` / `EVAL_ANTHROPIC_EFFORT`; `schedule` ignores them, and production keeps `config/models.yaml` and `vars.ANTHROPIC_MODEL`. A stage that does not run on Anthropic in that dispatch fails before any call.
2. The run's `meta.model` is `anthropic:<model>`, with `+effort=<level>` for an effort override. A `meta.model` other than the suite's published one is never appended to the dashboard history (results artifact + step summary only), even with `publish` on; an effort override always differs (the published model never carries the tag).
3. Read the job result (gate pass / fail, per-class metrics) and the step summary's **Report run vs published baseline**: scores, cost per call and review coverage next to the published baseline.
4. The stage moves (a `config/models.yaml` change, `AI_PROVIDER_<STAGE>` for its provider) only with a run that passed every gate, linked from the PR that moves it. Moving a primary changes the suite's published model: the weekly run then fails on the model change until it is re-baselined (#209).

Stages without a suite (`generation`, `autofix`) cannot pass the gate: their default is the fallback's model only, and they do not become a primary on a new model until they have a suite.

**Provider pinning** (ADR-0032 amendment 2026-10-13). <a id="provider-pinning"></a>Live runs call `callLLM()` with `fallback: false`: no per-call fallback to the other provider, even with both keys set. `meta.model` (`<primary provider>:<model>`) is the model of every call, and each call records who answered in `calls[].provider` / `calls[].model`. A primary failure is a run error (`providerErrors` marks the other provider `skipped: 'disabled'`, `llm_fallback_disabled` warn event). Before, a Groq TPD 429 moved the rest of the run to Anthropic with `error_rate` 0, and the dashboard published the mix as a Groq run. Production stages keep the fallback.

**Circuit breaker.** The first LLM call that fails on an exhausted quota stops the run (`detectQuotaExhaustion`, `eval_harness.mjs`):
- a provider message naming a daily quota (`tokens per day (TPD)`, `requests per day (RPD)`), whatever the fallback provider answered (on a pinned live run, no fallback is called); or
- every provider called refused with 401, 403 or 429 (`providerErrors` on the `callLLM` error), e.g. Groq 429 then Anthropic 401 (invalid key). A provider skipped without a call (ADR-0032: fallback without API key, prompt over its input budget, fallback disabled on a live eval) is ignored; at least one provider must have been called. Any other status, e.g. Anthropic 400 `not scoped to a workspace` (a config error), never trips the breaker.

A TPM 429 that outlasts the retries, a 5xx or a network error does not trip it. Once open, no further case starts; the remaining case × repeat are recorded as skipped (`skipped: true`, no call). The run is a **provider failure**: `summary.error_rate = 1` (by definition, not a ratio), `summary.circuit_breaker = { provider, quota, limit, used, retry_after, skipped_runs }`, an `error_rate` threshold failure even for a suite that does not gate it (so `partitionPublishable` never publishes it), a ⛔ section in the report, one `::error::` (`eval/eval.error`, `meta.reason: "provider_quota"`) naming quota, usage and retry-after, exit 1. The results file and trace are still uploaded. Before this, run 37719923057 made 45 calls that all failed (Groq TPD 429, then Anthropic 401).

**Swallowed LLM errors.** <a id="swallowed-llm-errors"></a>A run whose LLM call threw is an errored run, whatever the stage returned: a stage that catches the error and returns a fallback output (or retries) is not scored as a model answer (`runOne`, `eval_harness.mjs`). The run keeps the first LLM error as `error` (`LLM call failed` when its message is empty; the first quota message when the [circuit breaker](#token-budget) tripped, even if a later call failed otherwise), scores 0 on every applicable scorer, has no label, and counts in `error_rate`, so a run above the `error_rate` gate is not published. The failed call is recorded in `calls[]` as `{ raw: null, error, latency_ms: null, tokens_in_est, tokens_out_est: 0 }`; a replay throws it again at the same position, so it reproduces the error and the stage's fallback path. `llm_calls`, `tokens_est` and the scorers' `calls` count answered calls only. Before, only a quota error was forced into `error`: any other swallowed error (5xx, network) was scored on the fallback output with `error_rate` 0. Production stages are unchanged. Neither registered suite swallows one today (`validateIssue` and `reviewSuite.run` let the LLM error propagate); the harness rule covers any stage that does.

**Weekly schedule vs the TPD** (ADR-0027 amendment 2026-10-12). Options evaluated on run 38271632735:

| Option | Numbers | Verdict |
|---|---|---|
| One cron per suite, ≥ 48 h apart, `repeats: 3` | validation ≤ 199k counted (measured); review ≈ 130–175k (assumed cache ratio); one suite per TPD | **Applied.** No gate change |
| Lower `repeats` on schedule | 1 repeat: ≈ 95k estimated per suite, but `consistency` is `null` and its `optional` gate is skipped. 2 repeats: 189k / 193k estimated (no headroom for production), and agreement over pairs passes `min` 0.9 / 0.8 more easily than over triples | Rejected: loosens the consistency gate on the published reference (ADR-0031) |
| `EVAL_TOKEN_BUDGET` per suite | estimates 283.5k / 289.8k against a 200k TPD | Rejected as the fix: refuses the run, publishes nothing. Not read on schedule |
| Evals on Anthropic | — | Excluded: evals measure the production primary model (Groq `openai/gpt-oss-120b`) |

**Review suite with the incident cases** (2026-10-16, chars/4 from `estimateRunTokens` and the fitted prompts, no live run):

| | cases | input / repeat | × 3 input | × 3 output (`max_tokens` ceiling) | × 3 total, chars/4 |
|---|---|---|---|---|---|
| before | 23 | 81.5k | 244.6k | ≤ 70.7k | ≤ 315k |
| after | 28 | 105.2k (+23.7k: two cases sit at the 6300 budget) | 315.6k | ≤ 86.0k | ≤ 402k |

- **Why validation fit under the TPD (run 38847780079: ≈ 275k estimated input, completed).** Not because chars/4 overestimates: the code takes it to be ≈ 25% *under* provider usage (`estimateRunTokens`, and the 1.34 Groq-reported / chars/4 ratio behind `tokensPerRunEst`). The gap is the prompt cache: Groq does not count cached prompt tokens against its limits, and every call of a suite repeats the same system prompt ([ADR-0027 amendment](./adr/0027-offline-eval-harness.md)).
- **Review under the same model:** the system prompt (≈ 2.6k of 3.76k per call) is ≈ 218k of the 315.6k input. With every call after the first a cache hit, the counted cost is ≈ 98k input + the real output (≤ 86k) ≈ **≤ 185k**: it fits, without much margin. With validation's measured ratio instead (counted ≤ 0.65 × estimate), ≈ 261k: it does not. Cache hits are best-effort, so the first Wednesday run decides; the circuit breaker stops it at the first TPD 429 and nothing is published.
- **If it trips:** a separate Groq organization for evals (same model, its own TPD) keeps every gate and every case. Not proposed: fewer repeats (loosens `consistency`, rejected above), a `--tags` split across two days (a filtered run skips thresholds, which `workflow_gates.test.mjs` forbids under ADR-0031 §2: it needs a new ADR), dropping cases (ADR-0031).

Residual risk: a suite day spends up to the whole TPD that production shares (≈ 8.3k tokens back per hour), and cache hits are not guaranteed. A run that hits the TPD anyway is stopped by the circuit breaker at the first 429 and not published; the following week retries. If review × 3 trips it, the remaining levers keep the gates: a separate Groq organization for evals (same model, own TPD) or the Groq Dev tier.

## Gates only tighten (ADR-0031)

### Known-gap cases

A case tagged **`known-gap`** (ADR-0031 §7) is run, scored, published and shown (run page: the tag on its rows, a "known-gap (not gated)" block in the metrics), but stays out of the gate: `summarize` computes `error_rate`, `scores`, `consistency`, `confusion` and `per_class`, the metrics `checkThresholds` reads, over the other cases only, and reports the known-gap cases under `summary.known_gap`. Run size and cost (`n_cases`, `n_runs`, latency, `llm_calls`, `tokens_est`) and the circuit breaker cover every run. A threshold on a `known_gap.*` path fails as such.

- It is for an incident the stage is known to fail today (`incident-toctou-untested-claim`), so the case is measured without turning the gate red until the stage is fixed.
- **Removing the tag is the only way in**, and it is one-way: `eval_threshold_floor.test.mjs` requires every untagged case to be pinned and every tagged case to be listed in its `KNOWN_GAP` map and not pinned. Removing the tag therefore pins the case in the same PR, and a pinned case can never be tagged again.
- The floor's minimum case count counts gated cases only.
- Where it shows: `cases / runs` (report, scorecard `n_cases` / `n_runs`) counts every case run; the report and the run page add `known-gap` rows, and the scorecard entry a `known_gap` field (`n_cases`, `n_runs`, `error_rate`, scorer means). A history entry whose known-gap case errored is not used to calibrate the [pre-flight estimate](#token-budget).

A red eval is fixed in the stage (prompt, parser, production code), never by loosening its gate: no lower `min`, higher `max`, new `optional`, dropped or relabelled case, or filtered run. `scripts/tests/eval_threshold_floor.test.mjs` pins every suite's thresholds, minimum case count and each case's id, label and input hash (a relabelled, removed or rewritten case fails it), and fails when a suite's prompts share a 5-word run with one of its cases (prompt examples must not quote the dataset); tightening a threshold or adding cases raises the floor in the same PR. Loosening needs a new ADR.

## Metrics

Every quality metric but `known_gap` leaves the [known-gap cases](#known-gap-cases) out; they are the only metrics thresholds read.

| Metric | Meaning |
|---|---|
| `scores.<scorer>.mean` | Mean over runs where the scorer applies (`null` = not applicable) |
| `known_gap` | The same quality metrics (`n_cases`, `n_runs`, `error_rate`, `scores`, `consistency`, `confusion`, `per_class`) over the [known-gap cases](#known-gap-cases) only; absent when the run has none. Never gated |
| `error_rate` | Share of runs that threw (unparseable output, provider failure) or whose LLM call threw although the stage returned an output ([swallowed LLM errors](#swallowed-llm-errors)); 1 for a run the [circuit breaker](#token-budget) stopped |
| `per_class.<label>.{precision,recall,f1}` | From the expected × predicted confusion matrix; errors count as misses |
| `consistency` | Share of cases whose repeats all produced the same label |
| `latency_ms.{p50,p95}` | Per run, including retries |
| `llm_calls`, `tokens_est` | Answered call count and chars/4 token estimates (a failed call is not counted) |

### `validation`

`validation` thresholds: `scores.verdict_match.mean ≥ 0.8`, `per_class.invalid.recall ≥ 0.8`, `per_class.valid.recall ≥ 0.8` (over-strictness), `consistency ≥ 0.9` (only with `--repeats > 1`), `error_rate ≤ 0.05`.

`validation` scorers: `verdict_match`, `score_in_range` (cases with `score_min`/`score_max`), `suggested_ac_count`, and `blocker_match`. `blocker_match` is the Jaccard overlap between `expected.blockers` and the `B1`–`B4` codes the model prefixes its blockers with. It applies only to cases with `expected.blockers` and is not gated.

Dataset tags: `core` marks the original 15 cases, so `--tags core` compares with runs from before the dataset grew. The edge-case tags are `partial-ac`, `role-scope`, `scope-pair`, `stub` (B4 minimal pair), `short`, `fr`, `warnings-only` and `injection`.

`invalid-partial-ac-style` (one AC item measured against "the existing error style" of a directory) is still missed 3/3 on live run 38847780079, with every gate met (invalid recall 0.884). No prompt change is applied: the B2 rule already covers it generically ("Measured against a reference the issue does not state … Naming where the reference lives does not state it"), with an example from another domain (the tone of `src/i18n/` strings). A further edit would restate that rule or paraphrase the case (ADR-0031 §6), and its effect on the miss and on valid recall cannot be measured without a live run. The case stays gated and unedited.

### `review`

`run` goes through the production code of `scripts/pr_review.mjs`: `buildReviewPrompt` (diff filter, classification / automation-gate / dependency / evidence contexts, token budget) and `parseReviewVerdict` from `scripts/lib/review_prompt.mjs`, then `decideVerdict` (ADR-0024/0026). The label is the **final pipeline verdict**: `approve`, `request_changes` or `withheld`.

- Dataset (`evals/datasets/review.jsonl`, 28 cases: 16 `request_changes`, 10 `approve`, 2 `withheld`; 27 gated, 1 [`known-gap`](#known-gap-cases)): `{ id, tags, source?, input: { title, body, diff, dependencies?, evidence?, head_sha?, stale_refs?, related_adrs?, prompt_budget? }, expected: { verdict, must_flag?, must_note? } }`. `dependencies` replaces the target repo's `package.json` (dependency manifest context). `evidence` is an evidence file as written by `run_review_evidence.mjs`; a case without it is a repository that has not opted in, so missing evidence does not withhold an approval.
- **Context parity.** `stale_refs`, `related_adrs` and `prompt_budget` are precomputed in the shapes `findStaleReferences` (ADR-0035), `findRelatedAdrs` (ADR-0036) and `computePromptBudgetImpact` (ADR-0037) return, since a case has no PR tree to search, and go through the same formatters and `buildReviewPrompt` fields as in `pr_review.mjs` (related ADRs: one at most on Groq, dropped first under budget pressure). `eval_suites.test.mjs` parses both `buildReviewPrompt({ … })` call sites and fails when `pr_review.mjs` passes a field the suite does not, or formats it with another function.
- Cases: real bugs (`off-by-one`, `null`, `shell-injection` via `execSync`, `deleted-test`, `undeclared-import`, the prompt's named checks, an unawaited `forEach`, `missing-tests`), unrequested docs deletion, minimal `pair`s (same issue, buggy vs clean diff), clean `docs` and `test-only` diffs (`tests_expected: false` per `change_classifier`), a complete `automation` change (tests + docs + c8 gate), `injection` in the PR body and in a code comment, `evidence` (pass, fail, timeout) and a `truncated` diff whose bug stays visible.
- Sections (`flags_issue`, `no_false_alarm`, #178): only a top-level section heading ends a section, i.e. a `#`–`###` heading or a bold-only line whose whole text, emoji, `:` and whitespace aside, is `Change Classification`, `Summary`, `Issues Found` or `Verdict` (`**🚀 Verdict**`). A `#### scripts/foo.mjs` sub-heading, a `**scripts/foo.mjs**` group line or a `**Summary of risks**` line inside Issues Found stays in it, so the findings after it are read.
- A review without a verdict line is an **errored run** (`error_rate`), not a `REQUEST_CHANGES`: production fails closed, but counting it as a rejection would inflate `request_changes` recall.
- **LLM call.** The live eval sends the same `callLLM` options as `pr_review.mjs` (`llmCall`): `responseFormat: null` (the review is Markdown) and no `maxInputTokens` (the prompt is fitted by `buildReviewPrompt`). `eval_suites.test.mjs` parses both production call sites and fails when a suite's `llmCall` disagrees.
- **Results before this fix are not a model measurement on Groq.** The live eval used to call Groq with its `response_format: { type: 'json_object' }` default, which Groq rejects for a Markdown review (`400 Failed to generate JSON`). Every live `review` run on Groq up to and including [38561304861](https://github.com/koydas/autonomous-dev-loop/actions/runs/38561304861) (4 of 40 calls answered before the TPD circuit breaker tripped) measured that rejection, not the model; the failed calls still spent the Groq daily quota. Do not compare a later `review` run with them. Anthropic ignores `response_format`, so Anthropic runs are unaffected; `validation` always sent `json_object`, as production does.

| Scorer | Applies to | Meaning |
|---|---|---|
| `verdict_match` | all | Final verdict = `expected.verdict` |
| `flags_issue` | cases with `must_flag` / `must_note` | Share of entries the review raises. `must_flag` is searched in the Issues Found section only (a Summary that describes the diff is not a finding); `must_note` (the truncation note the prompt puts under the summary) anywhere outside the Change Classification section. An approving review scores 0. An entry is `"a\|b\|c"`: any alternative, case-insensitive substring. Not gated |
| `no_false_alarm` | expected `APPROVE` / `WITHHELD` | The model approved and listed no `[High]` / `[Medium]` finding in Issues Found. Not gated |

`review` thresholds: `scores.verdict_match.mean ≥ 0.75`, `per_class.request_changes.recall ≥ 0.8` (a missed bug reaches the merge gate unflagged), `per_class.approve.recall ≥ 0.6` (over-severity: a false `REQUEST_CHANGES` starts auto-fix on a correct PR; support 8, one case ≈ 12 points), `consistency ≥ 0.8` (only with `--repeats > 1`; looser than `validation` because `review_temperature` is 0.6), `error_rate ≤ 0.05`.

**Duration and tokens.** Each prompt is fitted to `review_max_input_tokens` (6300 estimated tokens; × 1.10 + `review_max_tokens` 1024 = 7954 ≤ 8000 TPM), exactly like production. The dataset averages ≈ 2.9k estimated input tokens per call (system prompt ≈ 1.9k); the `truncated` case sits at the budget. One repeat ≈ 66k input + ≤ 24k output tokens. On the Groq free tier (8K TPM, `--concurrency 1`, TPM is the bottleneck) that is **≈ 11–12 min per repeat, ≈ 35–40 min for the default `--repeats 3`** with the 60 s rate-limit waits; worst case (every call at the budget, TPM shared with live pipeline runs) ≈ 70 min, inside the 120 min job timeout. Anthropic has no budget: the diff keeps the 12,000-char cap.

**Replay fixture.** `scripts/tests/fixtures/review-replay.json` holds hand-written model outputs in the production format (`<think>` block, bold and inline verdict headings) with four planted failures: a truncated review without verdict, a missed bug, an over-severe docs review and a right verdict for the wrong reason. The incident cases add their outputs. The `known-gap` TOCTOU case is missed, as expected on Groq, and stays out of the pinned gated metrics. The two #219 cases replay the recorded false REQUEST_CHANGES, which the ADR-0038 backstop withholds: right verdict, `no_false_alarm` 0. `eval_suites.test.mjs` replays it through `run_evals.mjs` and pins the resulting metrics. Adding a case to the dataset means adding its recorded output to the fixture.

### Incident cases

Cases reproduced from a production misjudgment (AGENTS.md → Eval Gates), tag `incident`, `source: "PR #n"`, diff reduced to the minimum with identifiers rewritten:

| Case | Source | Production did | Expected |
|---|---|---|---|
| `incident-note-instead-of-fix` | PR #191 (#196 same shape) | approved a bug-fix PR that only adds a Markdown note with the planned fix | `REQUEST_CHANGES`, must_flag `no code\|not implemented\|does not fix\|only a note` |
| `incident-stale-refs-shared-phrasing` | PR #207 | a High "missing documentation update" from stale-reference hits that were shared phrasing (fixed by #212) | `APPROVE`, `no_false_alarm` (at most a Low "Verify stale reference"); the stale-refs, related-ADR and prompt-budget contexts are in the prompt |
| `incident-toctou-untested-claim` | PR #194 | approved an `lstat`-then-read path check (TOCTOU) whose PR body claims a test the diff does not hold | `REQUEST_CHANGES`, must_flag `race\|toctou\|symlink`; **`known-gap`** (expected missed on Groq; the #199 provider comparison case) |
| `incident-finding-on-cut-hunks` | PR #187 | a High finding whose fix sat in a test / doc past the budget cut | `APPROVE`, `no_false_alarm` (ADR-0034): the workflow is shown in full, the tests are cut mid-way, the docs are not shown |
| `incident-clean-code-cut` | PR #206 | `WITHHELD`, correct: regression case | `WITHHELD` (ADR-0038): clean change, a code file cut by the budget |
| `incident-cut-mid-step-name` | PR #219 (`c00e670`) | a High "broken workflow syntax, stray `- n`": the character cut ended `- name: Check … coverage (≥80%)` mid-token in `test.yml` | `WITHHELD`, `no_false_alarm` (ADR-0038 amendment): the cut ends on a hunk boundary before `test.yml`, named by the marker; code files are cut |
| `incident-missing-step-in-cut` | PR #219 (`d7aa937`) | a Medium "new module added without a c8 step": the step was in the cut part of `test.yml` | `WITHHELD`, `no_false_alarm`: same cut; a REQUEST_CHANGES citing only cut files is withheld in code |

`incident-note-instead-of-fix` is classified documentation (`tests_expected: false`), so no gate of the prompt caught it: `prompts/pr-review-system.md` gained one generic rule (a PR that changes no code when the issue asks for a code change does not resolve it; example from another domain), +110 tokens, headroom 3471 of 6300 (55%, ADR-0037). Not measured live: the replay gate cannot measure a prompt change; a `run-evals` label run will.

### Incident backlog

Misjudgments of stages without a suite, recorded so a future suite starts from them. Each line is the case it would need.

| Stage | Incident | Input it needs | Expected |
|---|---|---|---|
| generation | #191, #196: a bug issue whose files are protected or withheld produced a PR holding only a handoff note | issue title/body, the file context the stage was given (withheld / protected paths) | no PR: `blocked` (ADR-0029 amendment, #206), never a note under `notes/` or `patches/` |
| generation / autofix | ADR-0028 deletions: a patch that drops content the issue did not target | the issue or the review feedback, the shown file, the model's `changes[]` | rejected by `static_verifier` / `autofix_guard` (`mass_deletion`), or no deletion in `changes[]` |
| autofix | #207, #187: auto-fix ran on findings it could not act on (protected `docs/`, a withheld file) and proposed no change | review feedback, shown files, protected paths | `changes: []` with a reason naming the protected / unseen path, `needs-human` (ADR-0034), no speculative edit |

Each needs a suite (`run` through the stage's production code, `llmCall` parity, a cron day): see [Add a suite](#extend).

## Extend

**Add a case** — one line in `evals/datasets/<suite>.jsonl`: `{ "id", "tags", "input", "expected" }`. Ids are unique; `//` lines are comments.

**Add a scorer** — one entry in the suite's `scorers`: `(expected, output, { error, calls }) → 0..1 | boolean | null`. It shows up in the summary and the report automatically, and can be gated in `thresholds` as `scores.<name>.mean`. A threshold marked `optional: true` is skipped when the run did not measure the metric (e.g. `consistency` with `--repeats 1`) instead of failing.

**Add a suite** (new stage) — add an object to `SUITES` in `scripts/lib/eval_suites.mjs`, and the name to the `suite` choice in `.github/workflows/evals.yml` (`workflow_gates.test.mjs` checks both lists match):

```js
export const autofixSuite = {
  name: 'autofix',
  stage: 'autofix',                         // loadLLMConfig stage
  dataset: 'evals/datasets/autofix.jsonl',
  // The production callLLM call: loadLLMConfig fields it forwards + literal options (auto_fix_pr.mjs: responseFormat null).
  // A computed argument (autofix maxTokens: maxOutputBudget) is neither: the parity test rejects it until it supports one.
  llmCall: { configKeys: ['apiKey', 'model', 'apiUrl', 'temperature', 'reasoningEffort'], options: { responseFormat: null } },
  run: async (input, { llm }) => { /* call the stage's production logic with llm */ },
  scorers: { /* ... */ },
  label: (output) => output.verdict,        // optional: confusion matrix + consistency
  expectedLabel: (expected) => expected.verdict,
  thresholds: { 'scores.verdict_match.mean': { min: 0.8 } },
};
```

`run` must go through the stage's production code (prompt builder + parser), not a copy, so parser regressions are caught. When an entrypoint script keeps that logic inline (`pr_review.mjs` did), extract it to `scripts/lib/` first, as `review_prompt.mjs` was. `llmCall` must match the stage's `callLLM({ … })` call site: add the stage file to `PRODUCTION_CALL_SITES` in `scripts/tests/eval_suites.test.mjs`, whose parity test fails on any drift (a stage's `responseFormat` default is `json_object` on Groq). Add a test in `scripts/tests/eval_suites.test.mjs`. The dashboard needs no change: it renders one section, badge (`badges/<suite>.json`) and trend per suite.

## Tests and coverage

- `scripts/lib/eval_harness.mjs`, `scripts/lib/eval_scorecard.mjs`, `scripts/lib/eval_site.mjs` and `scripts/lib/eval_suites.mjs` are under the CI-enforced **80% minimum coverage** gate (`c8 --check-coverage --lines 80 --branches 80 --functions 80 --statements 80` in `.github/workflows/test.yml`), each measured with its own test file.
- `scripts/run_evals.mjs` is exercised end to end in replay mode by `eval_suites.test.mjs` (thresholds, repeats, filtered runs, dataset hash). `scripts/build_eval_site.mjs` is covered by `build_eval_site.test.mjs`: history read from a stubbed site (404, errors, invalid format), history window pruning, outage skipping, and the CLI.
- `scripts/lib/review_prompt.mjs` (review prompt builder and verdict parser, shared with `pr_review.mjs`) is under the same c8 gate, measured with `review_prompt.test.mjs`; `pr_review.test.mjs` and `entrypoints.test.mjs` still exercise it end to end through the script.
- `scripts/lib/eval_replay_ci.mjs` (PR replay gate) is under the same c8 gate, measured with `eval_replay_ci.test.mjs`, which also runs `scripts/replay_evals_ci.mjs` end to end against a local copy of the site.
- **Weekly run / per-suite `run_id` (minimum coverage policy):** `scripts/lib/eval_site.mjs` stays under the CI-enforced 80% c8 gate (lines, branches, functions, statements) in `test.yml`, including the `workflow_run_id` link. `scripts/build_eval_site.mjs` joins the same CI-enforced 80% c8 gate (`test.yml`, measured with `build_eval_site.test.mjs`: 100% lines, 93% branches), which covers its `run_id` collision guard (same batch, against the history, same-suite re-run, skipped outage, missing `run_id`) and the multi-suite build. `EVAL_RUN_ID` and its fallback are exercised end to end by `eval_suites.test.mjs`.
- The workflow is YAML, which c8 cannot measure. `workflow_gates.test.mjs` pins its shape instead: the job split, the default-branch condition, the Pages permissions and actions, and that it never pushes, commits or opens a PR. For the weekly run: one cron per suite (early morning, off the hour, suite days ≥ 48 h apart), the cron → suite map against the registry (every cron mapped, every suite once), `repeats` 3 and no `EVAL_TOKEN_BUDGET` on schedule, `max-parallel: 1` / `fail-fast: false`, the per-suite `EVAL_RUN_ID` and artifact names, the merged download, a single deploy, the disjoint `evals` / `pr-evals` concurrency groups, and that `init_site` and `restore_run_id` are read only behind the `schedule` guard. For `eval-replay.yml`, it pins `pull_request` only, the read-only token, no secret, the paths filter (docs-only changes do not trigger it), the per-PR concurrency group and the trace upload.

## Results file

`evals/results/<suite>-<runId>.json` = `{ meta, summary, failures, results[] }`. Each result keeps `case_id`, `repeat`, `output`, `label`, `scores`, `error` and `calls[]` (`raw`, `latency_ms`, token estimates, and on live runs `provider` / `model`: who answered) — the `raw` responses are what `--replay` serves.
