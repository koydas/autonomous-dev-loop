# Cross-cutting audit — 2026-10-19

Read-only audit of `main` at `290a484` (after #231). No code, prompt, config, workflow, dataset, ADR or issue was changed; every fix below is a proposal.

**Method.** Evidence is `file:line` on `290a484`, a workflow run ID, or a file on the `metrics` branch (fetched 2026-10-19). **CONFIRMED** = the code path was read end to end (and, where stated, reproduced offline); **SUSPECTED** = the path is plausible, and what is missing to confirm it is named. "Doc ≠ code" and "code wrong" are labelled separately. Offline measurements ran `buildReviewPrompt` through `reviewSuite.run` with a stub LLM (no API call). The live site (`koydas.github.io`) was not reachable from the audit container (proxy 403); the deployed file list was read from the `publish` job log of run 39260535854. Repository variables (`vars.*`) cannot be read from here: where a finding depends on one, the value is the one given in the task and marked so.

Severity: **High** = wrong verdict or patch, secret / public-data leak, unbounded cost, bypassable gate. **Medium** = silent degradation, stale operator docs leading to a wrong action. **Low** = drift, naming, untested non-critical branch.

## Summary

| ID | Axis | Sev | Status | Finding |
|---|---|---|---|---|
| F01 | 7 | Medium | CONFIRMED | Hardening gap: Groq organization ID published on the `metrics` branch through the allowlisted free-text `error` of `retry.wait` / `llm_fallback` (6 records); within ADR-0040:61's accepted risk, not a contract breach |
| F02 | 6 | High | CONFIRMED (read path) / SUSPECTED (exfiltration) | `auto_fix_pr.mjs` reads PR-branch files with a following `readFile`: a symlink to a small secret-bearing file (`.git/config` with the persisted `AI_PR_TOKEN`; `/proc/self/environ` only if it fits the ~5.5k-char file budget) reaches the LLM prompt; `/dev/zero` never reaches EOF |
| F03 | 5 | High | CONFIRMED | In a mixed diff, lock files, `node_modules/` and `dist/` are dropped by `filterDiff` before the unreviewed-code check: not shown, not withheld, APPROVE stands (a diff of excluded files only is shown whole) |
| F04 | 2 | High | SUSPECTED | `GITHUB_OUTPUT` heredocs with a fixed `EOF` delimiter carry model text after `valid=`: a prompt-injected issue can turn `valid` to `true` |
| F05 | 2 | High | SUSPECTED (accepted in ADR-0024) | Evidence file can be rewritten by a detached PR process before upload: forged "all checks pass" |
| F06 | 7 | Medium | CONFIRMED | `code_gen.skipped.detail` is the model's `blocked_reason` (model output), allowlisted for the public record |
| F07 | 3 | Medium | CONFIRMED (code) / SUSPECTED (API) | Anthropic server-side refusal fallback (`fallbacks: "default"`) can answer with another model; the answering model is never read, evals record the requested one |
| F08 | 3 | Medium | CONFIRMED | `meta.model` omits effort / reasoning effort unless overridden by dispatch: the Opus `review` series (effort `high`) would accept a `medium` run |
| F09 | 3 | Medium | CONFIRMED | PR-eval comparison is blocking across two different models whenever both temperatures match (two Anthropic models) |
| F10 | 4 | Medium | SUSPECTED | Weekly `review` × 3 likely does not fit the Groq 200k TPD: input alone ≈ 141k counted with a perfect prompt cache, leaving ≤ 559 output tokens per call for output and the day's production; unmeasured |
| F11 | 4 | Medium | CONFIRMED (publish failure) / SUSPECTED (runbook path) | Every Wednesday `review` publish fails on the model change until a re-baseline; the runbook's re-baseline needs an error-free Groq `review` × 3, which F10 puts in doubt |
| F12 | 4 | Medium | CONFIRMED (doc ≠ code) | `docs/evals.md` token budget / duration figures describe 23–30 cases; the suite has 35 (145.3k input per repeat, system prompt 2831) |
| F13 | 5 | Medium | CONFIRMED | Only code-tier files count as unreviewed: cut tests, agent-rule Markdown (`AGENTS.md`, `CLAUDE.md`, `.claude/skills/**`) never withhold; a REQUEST_CHANGES citing only a cut test/doc is not withheld |
| F14 | 2 | Medium | CONFIRMED | Script injection pattern: `pr-review.yml` interpolates `head.ref` / `ref_name` into `run:` shell |
| F15 | 2 | Medium | CONFIRMED | Over-broad `permissions:` (`actions: write` where read suffices; workflow-level write tokens in label-filter jobs); contradicts ADR-0007 |
| F16 | 1/6 | Medium | CONFIRMED | `PROTECTED_WRITE_PATHS` omits `.claude/` (hooks run commands on developer machines), `AGENTS.md`, `CLAUDE.md` |
| F17 | 8 | Medium | CONFIRMED | Live `validation` gate is red on the latest cron (39260535854) and published with ❌; replay then treats those metrics as pre-existing failures (warning only) |
| F18 | 3/L4 | Medium | CONFIRMED (code; variable value from task) | With `vars.AI_PROVIDER_VALIDATION=anthropic`, the Monday cron measures Haiku and fails its publish on model change every week |
| F19 | 3 | Medium | CONFIRMED (doc ≠ code) | Runbook tells operators to lower `GROQ_<STAGE>_MAX_TOKENS`, a variable that does not exist |
| F20 | 7 | Low | SUSPECTED | Groq `failed_generation` (model output) is kept out of `llm_fallback.error` only because it starts at char 229 of a 200-char cut |
| F21 | 3 | Low | CONFIRMED | Production review/codegen outputs never name the provider/model that answered (only `llm_call` / envelope do) |
| F22 | 6 | Low | CONFIRMED | PR-tree readers in `pr_review.mjs` / `dependency_manifest.mjs` have no size bound before read; lstat-then-read (static tree in CI) |
| F23 | 1 | Low | CONFIRMED (doc ≠ code) | ADR-0017 status and AGENTS.md say `autofix_max_input_tokens` default 3000; `config/models.yaml` has 2500 |
| F24 | 1 | Low | CONFIRMED | ADR-0020: `hasActiveAutoFixRun` filters `event=pull_request`, so an `issue_comment`-triggered auto-fix is invisible to the re-pulse guard |
| F25 | 1/6 | Low | CONFIRMED (doc ≠ code) | CHANGELOG says the review job reads the PR head tree; on `pull_request: opened` it checks out the merge ref, while evidence runs on `head.sha` |
| F26 | 8 | Low | CONFIRMED | Review suite: `no_false_alarm` and `withheld` recall ungated; `flags_issue` is 0 whenever `llm_verdict ≠ REQUEST_CHANGES`; stale "support 8" comment |
| F27 | 2 | Low | CONFIRMED | A third `evals.yml` dispatch can cancel a pending **scheduled** run; docs say "pending", not that the week's publication is lost |
| F28 | 2 | Low | CONFIRMED | Fixed-delimiter `GITHUB_OUTPUT` for the raw issue body in `code-generation.yml` (`__DELIM__`): a body line `__DELIM__` fails the step (stray closing marker) or, if followed by a new heredoc, truncates the body |

## 1. ADRs vs code

Verification depth: each ADR's Status and Decision were checked against the module / workflow / test it names (grep and read of the cited code). Where a full end-to-end read was done it is a finding below; the others are "anchor present".

| ADR | Status | Anchor checked | Result |
|---|---|---|---|
| 0001, 0006 | Accepted | `auto-fix-pr.yml:52-54`, `code-generation.yml:43-47` label gates | implemented |
| 0002 | "Updated" | `config.mjs:45-111` | implemented; status value is non-standard (Low, naming) |
| 0003 | Accepted | `output_writer.mjs:176` `MAX_FILE_COUNT` | implemented |
| 0004 | Accepted | `AI_PR_TOKEN \|\| GITHUB_TOKEN` in 4 workflows | implemented |
| 0005, 0012 | Superseded | — | not checked (superseded) |
| 0007 | Amended | `pr-review.yml:10-14` | **contradicted**: ADR-0007:34 "`actions: read` is the minimum … no broader permissions"; workflow grants `actions: write`, `contents: write`, `issues: write` (F15) |
| 0008 | Accepted | `scripts/tests/smoke.test.mjs` | present |
| 0009, 0019, 0029 | Accepted | `static_verifier.mjs`, `autofix_guard.mjs`, `output_writer.mjs:76-94` | implemented; type-check pass deferred as the ADR states |
| 0010, 0022 | Accepted | `error_taxonomy.mjs`, `retry.mjs:52-70`, `groq_client.mjs:69-99` | implemented |
| 0011 | Accepted | `checkpoint.mjs`, workflow artifact steps | implemented |
| 0013, 0040, 0041 | Accepted | `run_record.mjs`, `commit_run_record.mjs`, `metrics` branch content | implemented; hardening gaps F01, F06, F20 within the free-text risk ADR-0040:61 accepts (ADR-0040:15 "no … model output, secrets or environment") |
| 0014 | Accepted | `anthropic_client.mjs` `cache_control` | implemented |
| 0015 | Accepted | `output_writer.mjs:30-64` three tiers | implemented |
| 0016 | Accepted | `changelog-check.yml` | implemented |
| 0017 | Accepted, amended by 0025 | status line 4: default 3000 | **doc ≠ code** F23 (`models.yaml:62` = 2500) |
| 0018 | Accepted | `observability.mjs`, `check_event_docs.mjs` | implemented |
| 0020 | Accepted | concurrency groups; ADR-0020:44 re-pulse claim | groups implemented; re-pulse claim partly **contradicted** F24 |
| 0021 | Accepted | `output_writer.mjs:76-94` | implemented as written; scope gap F16 |
| 0023 | Accepted | trusted-copy checkouts in `pr-review.yml`, `auto-fix-pr.yml` | implemented; F02 is a PR-tree read inside the trusted script |
| 0024, 0026 | Accepted | `review_evidence.mjs`, `decideVerdict` | implemented; residual risk ADR-0024:94 = F05 |
| 0025 | Accepted | `config/models.yaml` | implemented |
| 0027, 0030, 0031 | Accepted (+amendments) | `eval_harness.mjs`, `pr-evals.yml`, `eval_threshold_floor.test.mjs` | implemented; F09, F17 |
| 0028, 0034 | Accepted | `review_marker.mjs`, `pr_review.mjs:237-250, 511-513` | implemented |
| 0032 (+3 amendments) | Accepted | `llm_client.mjs`, `run_evals.mjs:85-130`, `evals.yml:143-148` | implemented; distortion paths F07–F09, F18 |
| 0033, 0035–0037 | Accepted | gate (c) list test, `stale_refs.mjs`, `related_adrs.mjs`, `prompt_budget.mjs` | implemented |
| 0038 (+2 amendments) | Accepted | `review_prompt.mjs:58-124, 158-192` | implemented as written; coverage gaps F03, F13 |
| 0039 | **Proposed** | see below | no production leak |
| 0042 | Accepted | `pipeline_site.mjs:8` imports `flow_dashboard.mjs` | implemented |

No Accepted ADR was found without an implementation.

**ADR-0039 (Proposed) — prototype isolation: CONFIRMED clean.** `prototypes/langgraph-loop/` is referenced only by `test.yml:353-368` (`prototype-langgraph` job: workflow `contents: read`, no secret, Python unit tests). No `scripts/**/*.mjs` imports or spawns it (`grep -rn "prototypes\|langgraph" scripts .github/workflows` → only `test.yml`). Its checkout keeps the default `persist-credentials` (read-only token on disk; Low, same as the rest of `test.yml`).

## 2. Workflows and permissions

| Workflow / job | Trigger | Token permissions | Secrets in job | Untrusted code / data | persist-credentials |
|---|---|---|---|---|---|
| `pr-review` / evidence | push (non-main), PR opened | `contents: read` (job) | none | **runs PR code** (ADR-0024) | false |
| `pr-review` / review | same | workflow: `contents/issues/pull-requests/actions: write` | `AI_PR_TOKEN`, Groq, Anthropic | PR tree read as data, trusted script | false |
| `auto-fix-pr` / load-labels | every `labeled` + `issue_comment` | workflow write ×4 | `GITHUB_TOKEN` | none (default branch) | false |
| `auto-fix-pr` / auto-fix | label = changes-requested, or trusted checkbox comment | workflow write ×4 | `AI_PR_TOKEN`, Groq, Anthropic | PR branch as data, LLM output written | **true** (`AI_PR_TOKEN`, needed for push) |
| `code-generation` | issues `labeled`, dispatch | workflow write ×4 | `AI_PR_TOKEN`, Groq, Anthropic | issue text, LLM output written | true (default) |
| `validate-issue` | issues opened/edited | `contents/issues/actions: write` | Groq, Anthropic | issue text | true (default) |
| `reset-auto-fix` | dispatch | `pull-requests/issues: write`, `contents: write` | `AI_PR_TOKEN` | dispatching ref's scripts (writers only) | true (default) |
| `evals` / eval | schedule, dispatch | `contents: read` | Groq, Anthropic | none | false |
| `evals` / publish, `pipeline-site` / publish | after eval / `workflow_run` / push metrics | `pages`, `id-token`, `contents: read` | none | eval results, `metrics` data | false |
| `pr-evals` / plan → eval → comment | `pull_request_target: labeled`, dispatch | read → read → `pull-requests: write` | none → LLM keys → none | PR prompts as blobs only | true (plan, read) / false |
| `eval-replay`, `test`, `changelog-check` | `pull_request` | `contents: read` | none | **runs PR code** | false / default / default |

`pull_request_target` is used only by `pr-evals.yml` (YAML from the default branch, PR content as git blobs, size/symlink/path checks, labeler permission checked: sound). `workflow_run` is used only by `pipeline-site.yml` (default-branch builder, `metrics` read as data: sound).

**F14 — script injection pattern (Medium, CONFIRMED).** `pr-review.yml:111` `BRANCH="${{ github.ref_name }}"`, `:126` `BRANCH="${{ github.event.pull_request.head.ref }}"`, `:128` again `ref_name`: expressions expanded into the shell source. Git ref names allow `$`, `(`, `)`, `;`, backticks. On a fork PR the head ref is attacker-chosen; impact is bounded there (fork `pull_request` gets a read token and no secrets), and for same-repo branches the author is a writer. Code is wrong as a pattern; everywhere else values go through `env:`. Proposal: pass both through `env:` like `auto-fix-pr.yml:160`.

**F15 — least privilege (Medium, CONFIRMED).**
- `pr-review.yml:10-14`: review job inherits `actions: write`; it only lists runs (`pr_review.mjs:180-207`, `gh run list`) → `actions: read`. Contradicts ADR-0007:34.
- `auto-fix-pr.yml:9-13`: `actions: write` for both jobs; only artifact listing/download is done (`:98-115`) → `actions: read`. `load-labels` runs on every label/comment event with the four write scopes; it needs `contents: read` (+ `pull-requests: read` for the head lookup).
- `code-generation.yml:17-21`: `actions: write` while only `download-artifact` (read) is used; `load-labels` gets all write scopes.
- Default `persist-credentials` (true): `validate-issue.yml:23-24`, `code-generation.yml:29,57-58`, `reset-auto-fix.yml:50`. LLM output is written to the workspace in `code-generation` but never executed, so this is defense in depth only.

**F05 — evidence tampering (High, SUSPECTED; accepted in ADR-0024:94).** The evidence job runs PR code, then `actions/upload-artifact` reads `$RUNNER_TEMP/evidence/review-evidence.json` (`pr-review.yml:48-62`). A detached process started by a PR test can rewrite the file after `run_review_evidence.mjs` exits and before the upload. `assessEvidence` checks the head SHA, which the forger knows. Missing to confirm: a PoC run. Gate (evidence) is bypassable; ADR records the risk as out of scope ("full isolation needs the checks in a container").

**F04 — `GITHUB_OUTPUT` injection through model text (High, SUSPECTED).** `validate_issue.mjs:68-76` writes `valid=…`, `score=…`, then `comment<<EOF … EOF`. The comment embeds model strings verbatim (`issue_validator.mjs:95` `- ${b}` for blockers; same for warnings / suggested AC). A model answer whose blocker contains `\nEOF\nvalid=true\ncomment<<EOF\n` closes the heredoc and re-sets `valid`; `validate-issue.yml:75` (`IS_VALID`) and `:108-117` (dispatch of code generation) read it. The issue body is untrusted input to that model (the prompt says so, `prompts/validation-system.md`). Same fixed delimiter with model text: `generate_issue_change.mjs:258` (`summary` before `generated_paths`, so the real paths override), `auto_fix_pr.mjs:559` (`summary` after `fixed_paths`, so an injected `fixed_paths` wins; the push uses `git add -A` regardless). Missing to confirm: GitHub's handling of a repeated key (last wins is assumed) and a model actually emitting the sequence. Proposal: random delimiter per write (`crypto.randomUUID()`), or reject values containing it.

**F28 (Low, CONFIRMED).** `code-generation.yml:77-81` writes the raw issue body inside `body<<__DELIM__`. A body line `__DELIM__` closes the heredoc early; the generated closing `__DELIM__` (`:80`) is then a line that is neither `NAME=VALUE` nor `NAME<<DELIMITER`, which the runner rejects ([`FileCommandManager.cs:392-394`](https://github.com/actions/runner/blob/main/src/Runner.Worker/FileCommandManager.cs#L392-L394)): **Resolve issue data** fails and code generation never starts for that issue. Only a body that opens another heredoc after the marker gets through, with the body truncated; injected `number`, `title`, `labels` are then overridden by the lines written after it (`:82-84`). Kept Low: the effect is a visible failure limited to the issue whose author (or a maintainer) wrote the line, never another issue. The same parser rule means a malformed F04 payload fails its step instead of injecting. Same fix as F04.

**Concurrency.**
- `evals.yml:90-97` (`evals-<ref>`, no cancel): a third run cancels the **pending** one; documented in the workflow comment and `docs/evals.md:141`. **F27 (Low):** neither says the cancelled pending run can be the weekly cron, i.e. that week's publication is lost without an error.
- `pages-site-<repo>` (job-level, shared by `evals.yml:212-214` and `pipeline-site.yml:51-53`): the claim that GitHub's one-pending rule never cancels an eval publish holds — each side's workflow-level group keeps at most one of its jobs in the shared group.
- `pr-pipeline-<ref>` shared by three workflows: displacement of a pending run is documented in ADR-0020:45.

## 3. Fallback distortion (ADR-0032)

Paths where the answering provider/model can differ from the configured one:

| Path | Where | Recorded as | Verdict |
|---|---|---|---|
| Per-call primary → fallback (production) | `llm_client.mjs:108-155` | `llm_call` meta `{provider, model, fallback}`, span `gen_ai.response.model`, envelope `llm_calls[]` | correct in the record; not in user-facing output (F21) |
| Eval pinning `fallback: false` | `run_evals.mjs:85-99` | `calls[].provider/model` from `onAnswer` | correct for the client-side fallback |
| Anthropic server-side refusal fallback | `anthropic_client.mjs:44-48` sends `fallbacks: "default"` for Opus/Sonnet 5.5, Opus 5, Fable 5.1 | `onAnswer` gets `args.model` (`llm_client.mjs:103-104`); the response's own `model` is never read (`anthropic_client.mjs:95` keeps only the text) | **F07** |
| Provider/model resolution via `vars.*` | `config.mjs:59-89` (`provider_config_fallback`) | `meta.model` = resolved provider:model | correct |
| Effort / reasoning effort | `run_evals.mjs:113-116` | tag only for a dispatch override | **F08** |
| PR eval vs published run | `pr_evals.mjs:215-228` | "model differs" note | **F09** |

**F07 (Medium; code CONFIRMED, API behaviour SUSPECTED).** With `fallbacks: "default"`, a classifier refusal is re-run server-side "on the model Anthropic picks for its category" (comment at `anthropic_client.mjs:43`). The client never reads `raw.model`, so production `llm_call`, eval `calls[].model`, `partitionPublishable` and the re-baseline "single model" check (`eval_scorecard.mjs:161-174`) all trust the requested model. A refused-then-rescued eval call is published as the primary model's answer, which is exactly what pinning (ADR-0032 amendment 2026-10-13) was meant to prevent; cost is priced on the wrong model. Missing to confirm: an API response showing a different `model` value on a rescued refusal. Proposal: return `raw.model` from `callAnthropic` and pass it to `onAnswer` / `llm_call`; or omit `fallbacks` when `fallback: false`.

**F08 (Medium, CONFIRMED).** `meta.model` = `${provider}:${model}` plus `+effort=` only when `EVAL_ANTHROPIC_EFFORT` is set. `vars.ANTHROPIC_EFFORT`, `anthropic_<stage>_effort`, `GROQ_REASONING_EFFORT` and `<stage>_reasoning_effort` changes are invisible to `partitionByPublishedModel`. Concrete: the published `review` series (runs 38994398984, 39000563980) ran at `anthropic_review_effort: high` (`git show 2142c90:config/models.yaml:77`, same at `3bd05fc`); today's value is `medium` (`config/models.yaml:89`). A dispatch `provider: anthropic, anthropic_model: claude-opus-5-5, anthropic_effort: models-yaml` yields `anthropic:claude-opus-5-5`, equal to the series, and is appended with another effort.

**F09 (Medium, CONFIRMED).** `pr_evals.mjs:215-221` makes the gate advisory only when temperatures differ or are unknown, or the dataset changed. A model mismatch only adds a note (`:226`). Two Anthropic models both record `temperature: null`, which `temperatureKnown` accepts (`:215`), so a PR eval of the `review` suite on Sonnet (`vars.AI_PROVIDER_REVIEW=anthropic`, `anthropic_review: claude-sonnet-5-5`) against the published Opus series can print a blocking ❌ that is a model difference.

**F21 (Low, CONFIRMED).** `review.start` / `review.llm_request` log the primary's `model` (`pr_review.mjs:98, 360`); the review comment, the GitHub review body (`:418-449`), `review.verdict` (`:546-553`) and the `type: pr` metric (`:558-571`) carry no provider/model. A fallback-produced verdict is indistinguishable on the PR. Same for code generation (PR body, `code-generation.yml:145-150`).

## 4. Groq budget

**Per-stage input budgets vs the formula** (`config/models.yaml:17-20`: `input × 1.10 + max_tokens ≤ 8000`) — CONFIRMED arithmetic:

| Stage | max_input | max_tokens | input × 1.10 + max | Margin |
|---|---|---|---|---|
| validation | 6300 | 1024 | 7954 | 46 |
| generation | 3500 | 4096 | 7946 | 54 |
| review | 6300 | 1024 | 7954 | 46 |
| autofix | 2500 (+583 system) | 4096 | 7487 | 513 |

**Review suite × 3 vs the 200k TPD** (offline, `reviewSuite.run` with a stub LLM on Groq limits, `evals/datasets/review.jsonl` at `290a484`):

| Quantity | Value |
|---|---|
| Cases / runs (× 3) | 35 / 105 |
| System prompt (chars/4) | 2,831 per call |
| Input per repeat (chars/4) | 145,273 (avg 4,151, max 6,297, 6 cases ≥ 6,000, 6 cut = the 6 `requires_cut` cases) |
| Input × 3 | 435,819 (of which system 297,255) |
| Output ceiling × 3 | 105 × 1,024 = 107,520 |
| Counted input, perfect prompt cache (non-system input + one system prompt) | 138.6k + 2.8k ≈ **141.4k** |
| Room left under 200k for output (reasoning included) and same-day production | ≈ 58.6k, i.e. **≤ 559 tokens per call** with no production usage; the output is only capped (1,024/call), not measured |
| Counted at validation's measured ratio (≤ 0.65 × estimate) | 0.65 × 543k ≈ **353k** |
| `tokensPerRunEst` pre-flight (`eval_suites.mjs:214`) | 35 × 3 × 5,700 = 598,500 |

Reference: validation × 3 today (run 39260535854) = 274.7k est in + 20.3k est out over 105 calls, completed under the TPD. Run 38561304861 (23 cases) tripped the breaker at 40/69 runs, but those calls were `400 json_validate_failed` (the `responseFormat` bug fixed by #217, `docs/evals.md:265`), so it does not measure the current suite.

**F10 (Medium, SUSPECTED).** Even with every system prompt cached, the weekly `review` × 3 on Groq spends ≈ 141.4k counted input tokens, leaving ≈ 58.6k for all 105 outputs (reasoning tokens count) and for the same day's production: ≤ 559 output tokens per call on a TPD with no production usage. No output floor is enforced (`review_max_tokens` 1,024 is a ceiling), so this does not prove the run overflows; at validation's measured ratio (≈ 353k) it would. If it overflows, the breaker stops it at the first TPD 429 and nothing is published. Missing to confirm: one live Groq `review` × 3 on a quiet TPD with counted usage per call (`x-ratelimit-*` headers or Groq `usage`, not recorded by the client today).

**`docs/evals.md#token-budget` is stale (F12, Medium, doc ≠ code, CONFIRMED):** `:158` "review × 3 (69 calls) ≈ 200k in" (now 105 calls, 435.8k); `:213` built on 28 cases / 315.6k / "system ≈ 2.6k"; `:277` "averages ≈ 2.9k … system prompt ≈ 1.9k … one repeat ≈ 66k input" (now 4.15k, 2.83k, 145.3k); `:134`, `:277` durations (11–12 min per repeat) measured on 23 cases; `:171` "5 of 30, 17%" (now 6 of 35, 17%). `:163` (598,500) is current. Operators reading the table conclude the cron "≈ 130–175k" fits.

**F11 (Medium; publish failure CONFIRMED, runbook path SUSPECTED).** The `review` series is `anthropic:claude-opus-5-5` (runbook `:249`; deployed site file list of run 39260535854 holds only `38994398984-review` / `39000563980-review`). Every Wednesday cron runs Groq → `model_mismatch` → `--fail-on-model-change` (`evals.yml:225`, `build_eval_site.mjs:299-301`) → publish fails. The runbook fix (`docs/runbook.md:251-253`) is a dispatch with `rebaseline`, which requires `error_rate 0` and no circuit breaker (`eval_scorecard.mjs:173`): per F10 that run may not complete on the free tier. If F10 holds, the documented operator path cannot succeed as written; and the replay / PR-eval baseline for `review` stays an Opus run.

## 5. Review coverage since ADR-0038

Cut paths: `filterDiff` (`file_filters.mjs:28-39`: drop excluded files, context lines > 200 chars cut, char cap), `fitReviewPrompt` (`token_budget.mjs:39-76`: diff then body, always re-cut from the full diff), Anthropic cap (`review_prompt.mjs:161`, `reviewMaxDiffChars` 200000). `findUnreviewedCodeFiles` (`review_prompt.mjs:58-69`) compares the shown prefix with `fullDiff = filterDiff(ordered, Infinity)` (`:160`). `withholdOnUnreviewedCode` (`:114-124`). WITHHELD → COMMENT review + `review-withheld`, approve/changes labels removed, no auto-fix (`pr_review.mjs:480-487`) — CONFIRMED.

**APPROVE on unseen content:**
- **F03 (High, CONFIRMED).** `shouldIncludeFile` (`file_filters.mjs:1-7`) removes `node_modules/`, `dist/` at any depth and 9 lock-file names before both the shown diff and `fullDiff`. In a diff that also has other files, their hunks are never in the prompt and never in `unreviewedCodeFiles`, so an APPROVE stands. A lock-file change (resolved URL / integrity swap) or committed `dist/*.js` is approved unseen; the reviewer is not told (no marker). When *every* file is excluded, `filtered || rawDiff` (`:38`) shows the raw diff instead — inconsistent. Proposal: list excluded files in the prompt and treat an excluded non-lock code file as unreviewed; treat a lock-file change as WITHHELD or as a mandatory human note.
- **F13 (Medium, CONFIRMED).** Only `CODE_TIER` files count (`review_prompt.mjs:23-28, 66`). `isDocumentationFile` (`change_classifier.mjs:7-14, 51-57`) classifies every `.md` outside `scripts/`, `prompts/` and `docs/code-generation.md` as documentation, including `AGENTS.md`, `CLAUDE.md` and `.claude/skills/**/SKILL.md` (agent behaviour). A cut test file or one of those never withholds. Accepted by ADR-0038 for tests/docs; not discussed for agent-rule files.
- PR body truncation never withholds (`token_budget.mjs:61-65`); claims in the cut part are invisible. Low, by design.

**REQUEST_CHANGES on unseen content:**
- `withholdOnUnreviewedCode` withholds only when every finding cites only files in `unreviewedCodeFiles` (`:120-121`). A finding on a cut **test or doc** file keeps REQUEST_CHANGES and starts auto-fix on content neither model saw (the #187 shape, ADR-0034); only the prompt rule mitigates it (F13).
- A finding citing a cut file plus a shown file keeps REQUEST_CHANGES (by design, `:100-101`); a finding with no path keeps it (`:121`).
- A model REQUEST_CHANGES with failing checks is never withheld (`:119`) — correct per the #220 review.

## 6. PR-tree readers

| Reader | Tree | Symlink / non-regular | Size bound | Trust effect |
|---|---|---|---|---|
| `pr_review.mjs:260-292` `repoFiles` (stale refs, related ADRs, prompt budget head side, `config/models.yaml`) | review checkout (merge ref on `opened`, push SHA on push; F25) | per-component `lstat`, regular files only | **none before read** (F22) | informational blocks only; budget from trusted `config.mjs:8-12` |
| `pr_review.mjs:318-335` PR `config/models.yaml` | same | as above; error → `review.models_config_ignored` | none | only `computePromptBudgetImpact` (never a verdict input) — CONFIRMED |
| `pr_review.mjs:298-331` `git show <merge-base>:<path>` | git objects | n/a | `maxBuffer` 16 MiB | informational |
| `dependency_manifest.mjs` (`readPackageJsonDependencies`, review + autofix + codegen) | PR head / PR branch / default branch | `O_NOFOLLOW` + `fstat` (#195) | **none** (`:68` `handle.readFile`) | declared deps shown to reviewer; import-check snapshot |
| `file_injector.mjs:54` (codegen file context) | default branch | follows symlinks | after read | trusted tree (merged content only) |
| **`auto_fix_pr.mjs:390-397`** shown-file content | PR branch checkout (`auto-fix-pr.yml:76-81`) | **follows symlinks**; lexical `startsWith(repoRoot)` only | after read (`MAX_FILE_SIZE` 8000 checked post-read) | **content enters the LLM prompt** |
| `auto_fix_pr.mjs:525` pre-patch content of targets | PR branch | follows symlinks | none | guard input only (not sent) |
| `run_review_evidence.mjs` | PR head | executes PR code by design | n/a | F05 |
| `plan_pr_evals.mjs` | git blobs | symlink / submodule refused, 64 KiB | yes | prompts only, scripts/config refused — sound |

**F02 (High; read path CONFIRMED, exfiltration SUSPECTED).** `allChangedFiles` comes from the diff headers (`auto_fix_pr.mjs:362`); a committed symlink appears there as a path. `fsPromises.readFile(absPath)` (`:395`) follows it; the only check is lexical (`:392`). A file is shown only when it is ≤ `MAX_FILE_SIZE` (8000) **and** its wrapped part fits `fileCharsLeft` (`:399`), i.e. the file budget: `autofix_max_input_tokens` 2500 minus the user-template wrapper, minus the 15% diff / 25% feedback shares (`:344-348`), ≈ 1385 tokens ≈ 5.5k chars on Groq; otherwise it is withheld with a marker and nothing leaks. Targets that fit: a relative link to `.git/config`, where `actions/checkout@v4` with the default `persist-credentials` (`auto-fix-pr.yml:76-81`) stores the `AI_PR_TOKEN` as an `http.extraheader` (a few hundred chars; SUSPECTED, the file was not read on a runner); `/proc/self/environ` (holds `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `auto-fix-pr.yml:135-144`) only if the runner environment is under ~5.5k chars, not measured. A shown secret goes to the provider in the prompt, and the model can echo it into `summary` (posted in the escalation comment, `auto_fix_pr.mjs:505-510`) or into a file it writes. `-> /dev/zero` never reaches EOF: the read grows until Node's buffer limit or the 20-min job timeout. Who can trigger: anyone who can push a branch of this repo that gets `changes-requested` (the checkout uses `head.ref` of the base repo, so fork PRs fail earlier). Same class as #190/#195, not covered by their fix. Proposal: reuse the `pathKind` component-`lstat` + `O_NOFOLLOW`/`fstat` reader (`dependency_manifest.mjs`) for both reads, with a size cap before reading.

**F22 (Low, CONFIRMED).** `repoFiles.readFile` (`pr_review.mjs:286-291`) and `handle.readFile` (`dependency_manifest.mjs:68`) read whole files; `MAX_LIVE_SOURCE_CHARS` (`stale_refs.mjs:16,158`) is checked after the read. GitHub caps blobs at 100 MB, so the risk is memory/time, not a hang. The `lstat` → `readFileSync` sequence is the TOCTOU shape of `incident-toctou-untested-claim`, harmless here (no concurrent writer in the review job).

## 7. Run-record redaction (ADR-0040/0041)

Coverage (CONFIRMED by script over `scripts/*.mjs` + `scripts/lib/*.mjs`, literal `event: '…'`): 77 emitted names, 63 allowlisted. Not allowlisted (published with `meta: {}`): `eval.*`, `eval_replay.*`, `pr_evals.*`, `pr_evals_report.*`, `review_evidence.*` — none of their workflows commits a record (the evidence job's trace `<run_id>-evidence.json` is not committed either), so this is safe and only means evidence outcomes never reach the record. `pr_prepare.skipped` is allowlisted and emitted dynamically (`generate_issue_change.mjs:79`). `llm_provider_error` (#230) is allowlisted with `provider`, `error_type`, `status` only (`run_record.mjs:77`) — correct.

OTLP: side-effect spans and span events reuse `EVENT_META_ALLOWLIST` (`run_record.mjs:114-116, 253`), `llm_call` span attributes are numeric/enum (`:109-111`). Trace indexes are built from the redacted record (`appendTraceIndex`, `:408-450`). Pages pipeline views read only the `metrics` branch (`pipeline-site.yml:69-76`). So the OTLP and index paths inherit exactly the event allowlist's exposure — including F01/F06/F20.

**F01 (Medium, CONFIRMED; hardening gap).** `error` is allowlisted on `retry.wait` (`run_record.mjs:80`), `llm_fallback` (`:75`), `llm_fallback_disabled` (`:76`) and every `*.error`. Its value is the HTTP error message, which embeds the provider's response body (`groq_client.mjs:98`, `anthropic_client.mjs:66`; `retry.mjs:65`, `llm_client.mjs:92,143`). Groq 429 bodies name the organization: `metrics/runs/2026-10/39193212735-1.json`, `38848182099-1.json` and 4 other records on the `metrics` branch contain `organization \`org_01kp6a0j…\` service tier \`on_demand\``. The 200-char cut keeps it (it sits at ~100 chars). The scrubber only knows env values and credential shapes (`run_record.mjs:118-142`). The same string is in the job logs (e.g. run 39260535854), which are less public than a Pages-rendered branch. Not a credential and not an env value: an account identifier from the provider's response. ADR-0040:61 accepts that allowlisted free-text fields (`error`, `reason`, `detail`) publish up to 200 scrubbed characters, so this is within the accepted risk, not a breach; it is a new hardening requirement (raw provider bodies were the reason raw stderr was rejected, ADR-0040:49). Proposal: allowlist `error_type` / `status` only for these events, or replace the body by `err.code` as `llm_provider_error` does; scrub `org_[a-z0-9]+`; rewrite the six records.

**F06 (Medium, CONFIRMED).** `code_gen.skipped` allowlists `detail` (`run_record.mjs:41`), set to `blocked.reason` (`generate_issue_change.mjs:115`), which for `source: model` is the model's `blocked_reason` (`generation_blocked.mjs:74,128`) and for `denylist` appends it (`:125-126`). Model output in the public record: ADR-0040:61 accepts that a free-text `detail` may quote content, but here the field is model text by construction, not incidentally, against the intent of ADR-0040:15. Mitigation: the same text is already public in the issue comment (`generate_issue_change.mjs:151`). Proposal: drop `detail` from the allowlist (keep `source`, `reason`).

**F20 (Low, SUSPECTED).** For a Groq `400 json_validate_failed`, `llm_fallback.error` = `groq: Groq API HTTP error 400: {"error":{"message":…,"code":"json_validate_failed","failed_generation":"…`. With Groq's current message and key order the model output starts at char 229 (computed), past the 200-char cut. Any shorter message, key reordering or a `*.error` without the `groq: ` prefix moves model output into the record. Missing to confirm: a real Groq body (tests use a synthetic one, `groq_client.test.mjs:400`). Same fix as F01.

## 8. Eval coverage per stage

| Stage | Suite | Dataset | Gated | Measured, not gated | Replay (`eval-replay.yml`) | Live PR eval | Production incidents without a case |
|---|---|---|---|---|---|---|---|
| validation | yes | 35 (12 valid / 23 invalid) | `verdict_match ≥ 0.8`, `invalid` recall ≥ 0.8, `valid` recall ≥ 0.8, `consistency ≥ 0.9` (repeats > 1), `error_rate ≤ 0.05` | `score_in_range`, `suggested_ac_count`, `blocker_match`, per-class precision/F1 | yes | yes (`prompts/validation-*`) | none found |
| review | yes | 35 (16 RC / 15 approve / 4 withheld); 34 gated + 1 `known-gap` | `verdict_match ≥ 0.75`, `request_changes` recall ≥ 0.8, `approve` recall ≥ 0.6, `consistency ≥ 0.8`, `error_rate ≤ 0.05` | `flags_issue`, `no_false_alarm`, `advisory`, `no_spurious_flag`, `withheld` precision/recall | yes | yes (`prompts/pr-review-*`) | `incident-toctou-untested-claim` stays `known-gap`; none new found |
| generation | no | — | — | — | — | "nothing to run" | backlog: #191/#196 handoff note; ADR-0028 deletions (`docs/evals.md:337-338`) |
| autofix | no | — | — | — | — | — | backlog: #207/#187 unactionable findings (`:339`) |

**F26 (Low, CONFIRMED).** `reviewSuite.thresholds` (`eval_suites.mjs:305-317`) gate neither `no_false_alarm` nor `per_class.withheld.recall`; a regression where the model starts flagging High/Medium on clean code that the ADR-0038 backstop still withholds is invisible to the gate. `flags_issue` returns 0 whenever `llm_verdict !== 'REQUEST_CHANGES'` (`:257`): it also scores 0 on an expected-RC case turned RC by failing evidence after a model APPROVE, and cannot score a truncation note on an APPROVE case (acknowledged `docs/evals.md:311`). The comment "support 8" (`:313`) is stale (15 approve cases). Adding thresholds is a tightening (ADR-0031): allowed, once a baseline exists.

**F17 (Medium, CONFIRMED).** Cron run 39260535854 (`validation`, Groq, 2026-10-19 13:29 UTC, 7 h after its 06:23 schedule): `invalid` recall 0.7826 < 0.8, `consistency` 0.8857 < 0.9; published with ❌ (`runs/39260535854-validation.json` in the deploy). Misses: `invalid-partial-ac-style` 3/3 (documented), `invalid-role-ambiguous` 3/3, `invalid-scope-environment-open` 3/3, two `injection` cases. Per ADR-0031 the stage needs a fix. Side effect: `eval_replay_ci` classifies these two thresholds as already failing on the published side → warning only, so the replay gate cannot block a parser regression on them until a green run is published.

## Leads

| Lead | Verdict | Evidence |
|---|---|---|
| **L1** network `TypeError` non-retryable in `anthropic_client.mjs` | **Refuted.** A fetch rejection is retryable unless `cause.code` is `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` (`anthropic_client.mjs:61`); `ECONNRESET` (`cause.code: 'ECONNRESET'`) is retried. Tested: retry then success (`anthropic_client.test.mjs:129-143`), exhaustion at 4 calls (`:145-155`), timeout not retried (`:277`), AbortError (`:328-342`). Gap (Low): no test with an explicit `ECONNRESET` cause; same branch as the tested one. |
| **L2** #150 regression tests | **Present.** Malformed (non-JSON) 400 body (`groq_client.test.mjs:415`), other 400s without / with non-identifier code (`:427`), `json_validate_failed` single request (`:402`), "both providers failed" text with both statuses (`llm_client.test.mjs:829-837`), 400 without code still falls back (`:843`). |
| **L3** runbook "Current case" / evals.md token row | Runbook `:249` (review series = Opus) **accurate** as of the 13:46 UTC deploy of run 39260535854 (only the two Opus review runs on the site); the two later deploys (39275034484, 39275083357) were `validation` dispatches whose logs were not read. `docs/evals.md:158` **stale** (F12): 69 calls / ≈ 200k / "not measured" describes the 23-case suite; current offline figure 435.8k est input × 3, ≈ 141.4k counted input with a perfect cache, output unmeasured (F10). |
| **L4** `vars.AI_PROVIDER_VALIDATION=anthropic` (value as given; cron 39260535854 at 13:29 UTC still ran on Groq, so the variable was set later or not at all) | **Confirmed from code (F18).** Monday cron: `evals.yml:145` forwards the variable on `schedule` → validation runs on `anthropic:claude-haiku-5-5` (`run_evals.mjs:113-129`) → model ≠ published `groq:openai/gpt-oss-120b` → `MODEL_CHANGE_FAILS=true` on schedule (`evals.yml:225`) → `build_eval_site.mjs:299-301` throws, nothing deployed, every week until a re-baseline (documented as the intended consequence, `docs/evals.md:182`). `pr-evals.yml:183` forwards it too: the PR run is Haiku (`temperature: null`) vs Groq (`0`) → `sameTemperature` false → thresholds advisory + "model differs" note (`pr_evals.mjs:215-226`); no false ❌. `eval-replay.yml` sets no provider variable: replays the published Groq run; validation has no provider-dependent prompt logic → unaffected; it keeps comparing against the red 39260535854 baseline (F17). |
| **L5** dispatch `provider=anthropic` + `anthropic_model` with publish on | **Partly refuted.** No reset without `rebaseline` (`evals.yml:227`, `build_eval_site.mjs:280-286`): confirmed. "Never appends" is false in two cases: (a) `anthropic_model` equal to the published model id with `anthropic_effort: models-yaml` produces the same `meta.model` and is appended (`eval_scorecard.mjs:144-159`), even at another effort (F08: series at `high`, current `medium`); (b) a suite with no published series takes the first run's model (`:154`, `published[suite] ??= model`) — this is how `review` became an Opus series. A mismatching run is skipped with a notice (`MODEL_CHANGE_FAILS` false, `evals.yml:225`). |

## Other findings

- **F16 (Medium, CONFIRMED).** `PROTECTED_WRITE_PATHS` (`output_writer.mjs:76-94`) has no `.claude/`, `AGENTS.md`, `CLAUDE.md`. Code generation and auto-fix may write `.claude/settings.json` (hooks: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/test-gate.mjs"`, `.claude/settings.json:20-40`), `.claude/hooks/*.mjs` or the agent rules. The human merge gate remains, but a developer who opens the AI branch in Claude Code runs its hooks after trusting the folder. ADR-0021's rationale ("run with secrets on push") covers developer-side execution only implicitly.
- **F18** — see L4.
- **F19 (Medium, doc ≠ code, CONFIRMED).** `docs/runbook.md:151` says "lower `GROQ_<STAGE>_MAX_TOKENS` truncation". No such variable exists (`config.mjs:163` reads `<stage>_max_tokens` from `config/models.yaml`; no env override), and a truncated JSON answer needs a *higher* cap, bounded by the TPM formula.
- **F23 (Low, doc ≠ code).** `AGENTS.md:27` and `docs/adr/0017-configurable-token-budget.md:4`: default `autofix_max_input_tokens` 3000; `config/models.yaml:62`: 2500 (CHANGELOG #188 follow-up).
- **F24 (Low, CONFIRMED).** `hasActiveAutoFixRun` queries `…/runs?branch=…&event=pull_request&status=…` (`pr_review.mjs:187`). A run started by the "Relancer Auto Fixer" checkbox (`issue_comment`) is not found, so the review re-pulses `changes-requested` behind it. ADR-0020:44 states the guard covers pending auto-fix runs without this restriction.
- **F25 (Low, doc ≠ code).** CHANGELOG (#195 entry) says "`pr-review.yml` checks out `pull_request.head.sha`". The review job checkout has no `ref` (`pr-review.yml:83-87`): on `pull_request: opened` it is `refs/pull/N/merge`, while the evidence job uses `head.sha` (`:31`). Stale-ref, related-ADR, prompt-budget and `package.json` reads then see the merge result, not the head the evidence describes.

## Proposed follow-ups

| Group | Proposed issue title | Files in scope | ADR |
|---|---|---|---|
| F01, F20, F06 | Redact provider error bodies and model text from the public run record; rewrite affected `metrics` records | `scripts/lib/run_record.mjs`, `scripts/lib/llm_client.mjs`, `scripts/lib/retry.mjs`, `scripts/lib/groq_client.mjs`, `scripts/lib/anthropic_client.mjs`, `metrics` branch (6 records), tests | ADR-0040 amendment |
| F02, F22 | Auto-fix reads PR-branch files without following symlinks; size cap before read on every PR-tree reader | `scripts/auto_fix_pr.mjs`, `scripts/lib/dependency_manifest.mjs` (shared reader), `scripts/pr_review.mjs`, tests | no (ADR-0023 scope) |
| F03, F13 | Excluded and non-code files in the review cut: name excluded files, withhold on lock/dist changes, decide agent-rule Markdown tier, withhold RC on cut tests | `scripts/lib/file_filters.mjs`, `scripts/lib/review_prompt.mjs`, `scripts/lib/change_classifier.mjs`, `prompts/pr-review-system.md`, eval cases | ADR-0038 amendment |
| F04, F28 | Random delimiters for every multi-line `GITHUB_OUTPUT` write | `scripts/validate_issue.mjs`, `scripts/generate_issue_change.mjs`, `scripts/auto_fix_pr.mjs`, `.github/workflows/code-generation.yml`, tests | no |
| F14, F15, F27 | Workflow hardening: env-passed refs, least-privilege tokens, `persist-credentials: false`, document cron cancellation | `.github/workflows/pr-review.yml`, `auto-fix-pr.yml`, `code-generation.yml`, `validate-issue.yml`, `reset-auto-fix.yml`, `workflow_gates.test.mjs`, `docs/evals.md` | ADR-0007 amendment (permissions) |
| F05 | Isolate evidence checks from the evidence file (container or separate job writes) | `.github/workflows/pr-review.yml`, `scripts/run_review_evidence.mjs` | ADR-0024 amendment |
| F07, F08, F21 | Record the answering model (Anthropic response `model`) and the effective effort in `meta.model` / `llm_call`; name the model in review output | `scripts/lib/anthropic_client.mjs`, `scripts/lib/llm_client.mjs`, `scripts/run_evals.mjs`, `scripts/lib/eval_scorecard.mjs`, `scripts/pr_review.mjs` | ADR-0032 amendment |
| F09 | PR-eval gate advisory on any model mismatch | `scripts/lib/pr_evals.mjs`, tests | no |
| F10, F11, F12 | Measure `review` × 3 Groq-counted usage; update the token-budget section and the re-baseline runbook path to one that can complete | `docs/evals.md`, `docs/runbook.md`, `scripts/lib/eval_suites.mjs` (comments) | ADR-0027 amendment if the schedule changes |
| F17 | Validation prompt fix for B3 role/scope and injection misses (live gate red) | `prompts/validation-system.md` | no (ADR-0031 applies) |
| F18 | Weekly validation vs a per-stage provider variable: decide re-baseline or schedule override | `.github/workflows/evals.yml`, `docs/runbook.md` | no |
| F16 | Protect `.claude/`, `AGENTS.md`, `CLAUDE.md` from AI writes | `scripts/lib/output_writer.mjs`, both system prompts, tests | ADR-0021 amendment |
| F19, F23, F25 | Doc drift: runbook max_tokens row, autofix budget default, review checkout tree | `docs/runbook.md`, `AGENTS.md`, `docs/adr/0017-…md`, `CHANGELOG.md` or `pr-review.yml` | no |
| F24 | Re-pulse guard sees `issue_comment` auto-fix runs | `scripts/pr_review.mjs`, tests | no |
| F26 | Baseline then gate `no_false_alarm` / `withheld` recall; refresh threshold comments | `scripts/lib/eval_suites.mjs`, `eval_threshold_floor.test.mjs` | no (tightening) |
