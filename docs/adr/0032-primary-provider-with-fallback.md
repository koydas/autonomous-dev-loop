# ADR-0032: Primary LLM provider with the other as fallback

- **Date:** 2026-10-08
- **Status:** Accepted

## Context

`callLLM()` already tried the second provider when the first one failed, but it called it with the arguments built for the first: `loadLLMConfig()` returned only the primary provider's key, model, URL and budgets. A Groq → Anthropic fallback sent the Groq key and `openai/gpt-oss-120b` to Anthropic, an Anthropic → Groq fallback sent the Anthropic key and a `claude-*` model to Groq: the fallback could only fail (401 or unknown model). The existing fallback test passed because its fetch mock did not check the key. A 401/403 from the primary stopped the chain altogether.

The Anthropic path itself could not succeed on its default model: `callAnthropic()` always sent `temperature: 0`, which Opus 4.7+ and Opus 5.x reject (400); it read `content[0].text`, which is a thinking block when adaptive thinking runs (on by default on Opus 5.x); a 529 (`overloaded_error`) was not retried; a refusal (HTTP 200, `stop_reason: "refusal"`) surfaced as a parsing error. Stage settings (`max_tokens`, effort) were Groq-only: every Anthropic stage ran with `max_tokens: 4096`.

An `AI_PROVIDER` other than `groq`/`anthropic` (typo) silently resolved to Groq in `loadLLMConfig()` while `callLLM()` started with Anthropic.

## Decision

**Provider choice.**
- `AI_PROVIDER` (`groq` | `anthropic`, case-insensitive) picks the **primary** provider. Unset or blank: Anthropic when only `ANTHROPIC_API_KEY` is set, Groq (`DEFAULT_PROVIDER`) otherwise.
- A bad value never fails the job. An unknown value uses that same key-based default; a provider whose key is not set yields to the provider that has one. Each case logs one `provider_config_fallback` warn event per process.

**Fallback.**
- The other provider is the **fallback**, active when its API key is set (`detectFallbackProvider()`). No key: the fallback is skipped and the error reads `<provider>: skipped (no API key configured)`.
- It triggers on **any** primary failure, 401/403 included. Each fallback logs an `llm_fallback` event (`from`, `to`, `error_type`, primary error): `error` level, which also emits a GitHub Actions annotation, on a misconfiguration: 401/403 (`PERMANENT`, the primary's key is wrong or revoked) or 400/404 (unknown model, unsupported parameter such as `output_config.effort` on an older model); `warn` otherwise.
- The primary's input budget is checked too: validation and generation pass their `maxInputTokens` to `callLLM()`, which skips an over-budget Groq primary without a request (it could only end in a 413 retried until the job timeout, ADR-0028) and hands the prompt to the Anthropic fallback (no input budget). Before, `assertInputBudget` failed the job ahead of `callLLM()`, so the one provider able to take the prompt was never tried.
- The fallback call is built from its own config: `loadProviderConfig(provider, stage)`. Only the call itself is carried over: `prompt`, `systemPrompt`, `responseFormat`. Callers pass `stage` to `callLLM()` (`generation` when absent). `loadLLMConfig(stage)` is `loadProviderConfig(detectProvider(), stage)`.

**Anthropic stage settings** (`config/models.yaml`, `anthropic_*` keys).
- `anthropic_<stage>` model (default `claude-opus-5-5`; `ANTHROPIC_MODEL` overrides every stage), `anthropic_<stage>_effort` sent as `output_config.effort` (`ANTHROPIC_EFFORT` overrides every stage, `off` sends none), `anthropic_<stage>_max_tokens` (default 16000; requests are not streamed).
- No temperature is sent unless a caller sets one explicitly.
- The answer is the first `text` block. `stop_reason: "refusal"` throws with its category and `stop_reason: "max_tokens"` throws as truncated (thinking counts toward the cap), so the provider fallback runs. 529 is retried like 5xx. A fetch that hits undici's 300 s headers/body timeout is not retried: the request is not streamed and the same long turn would time out again.
- `output_config.effort` is sent whatever the model: Sonnet 4.5 / Haiku 4.5 reject it and Opus 4.5 has no `xhigh`/`max`. With such an `ANTHROPIC_MODEL`, set `ANTHROPIC_EFFORT=off`.
- Models that support it (`claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`, `claude-fable-5-1`) send `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` when `ANTHROPIC_API_URL` is unset (Claude API only): a classifier refusal is re-run server-side on another Claude model before the provider fallback is needed.

## Alternatives Considered

- **Explicit `AI_FALLBACK_PROVIDER` variable**: with two providers, the fallback is fully determined by the primary; a second variable only adds an inconsistent state (primary = fallback).
- **No fallback on 401/403**: surfaces a revoked key by failing the job, at the cost of availability. Rejected: the fallback keeps the pipeline running and the `error`-level event keeps the misconfiguration visible.
- **Fail the job on an invalid `AI_PROVIDER`**: strict, but one typo in a repository variable stops every LLM workflow. Rejected for a logged default.
- **Pass both configs from every caller**: five call sites to change for a decision `callLLM()` can take from the environment.
- **Anthropic SDK instead of `fetch`**: would bring retries and typed errors, but adds the repository's first runtime dependency (ADR-0009 guardrail 4); the raw request stays small.

## Consequences

- ✅ Both directions work: set both keys, choose the primary with `AI_PROVIDER`.
- ✅ A misconfigured `AI_PROVIDER` or missing key degrades to a working provider instead of failing.
- ✅ The Anthropic path works on current models, with per-stage effort and output caps.
- ⚠️ A 401/403 no longer fails the job when the fallback succeeds: watch for `llm_fallback` errors (annotations) or the key stays broken unnoticed.
- ⚠️ The prompt is sized for the primary. Anthropic primary → Groq fallback: the input budgets (`<stage>_max_input_tokens`, ADR-0028) were not applied. Groq would answer a prompt over its budget with 413 `rate_limit_exceeded`, retried as a rate limit until the job timeout, so `callLLM()` checks the fallback's `maxInputTokens` first (estimated system + user prompt; user prompt only for autofix) and skips the call when it is exceeded: `groq: skipped (prompt ~N tokens over <stage>_max_input_tokens M)`. The fallback only covers prompts that fit Groq.
- ⚠️ Fallback output comes from a different model: evals and reviews of that run are not comparable with the primary's (the `llm_fallback` event identifies them).
- ⚠️ Anthropic runs are paid, and thinking tokens count as output: `high` effort on three stages costs more than the model default (`medium`).

## Amendment (2026-10-13): live evals are pinned to the primary provider

**Context.** A live eval run stamps `meta.model = "<primary provider>:<model>"` once (`run_evals.mjs`), but every `callLLM()` fell back per call. With both keys set, a Groq TPD 429 (one suite ≈ 285k tokens against the 200k TPD) moved the rest of the run to Anthropic: the circuit breaker did not trip (it needs every provider called to refuse), `error_rate` stayed 0, and the dashboard published a Groq/Anthropic mix as a Groq measurement — Δ, trend and the ADR-0031 gates then compared models, not prompts.

**Decision.**
- `callLLM()` takes an optional `fallback: false` in its args object: a primary failure throws without calling the fallback, `providerErrors` records it as `{ provider, status: null, skipped: 'disabled' }`, the error reads `<provider>: skipped (fallback disabled)`, and a `llm_fallback_disabled` warn event is logged instead of `llm_fallback`. Absent or any other value: the fallback above, unchanged. Production stages do not pass it.
- `callLLM()` takes an optional `onAnswer({ provider, model })`, called once with the provider and model that actually answered (the primary's, or the fallback's own config).
- Live evals (`run_evals.mjs`) pass `fallback: false`. A primary failure is a run error. A Groq TPD 429 is now the only provider called, so the circuit breaker trips on it (`detectQuotaExhaustion` ignores the `disabled` entry like any skipped provider); the run is not published.
- Evidence: every live call records `calls[].provider` / `calls[].model` (from `onAnswer`); a replay serves them back. `partitionPublishable` refuses a run with any call answered by another `provider:model` than `meta.model` (`replay:` prefix ignored). Results recorded before this change carry no provider and are judged on `error_rate` only.

**Why not keep the fallback and stamp the mix.** A run is a measurement of one model: a per-call mix has no scorecard row it can be compared with, and re-labelling `meta.model` would only hide it. Losing a weekly run to a quota is cheaper than publishing a wrong one; the next scheduled run retries.

**Consequences.**
- ✅ A published run was answered by `meta.model` on every call, checked twice (pinning, then `partitionPublishable`).
- ✅ Groq TPD exhaustion during an eval trips the breaker at the first 429 instead of spending the Anthropic budget.
- ⚠️ With both keys set, an eval no longer survives a transient primary outage that outlasts the retries: those runs error instead of being published.

## Amendment (2026-10-14): eval history is per suite and model; a manual run can pick its provider

**Context.** Issue #199 step 1: measure the `review` stage on Anthropic (`anthropic_review`, `claude-opus-5-5`) against the Groq baseline. Since ADR-0038 the Groq input budget (`review_max_input_tokens` 6300) leaves ≈ 3k tokens for the diff, so most non-trivial PRs get WITHHELD (#206: 7 code files unseen). `evals.yml` took the provider from `vars.AI_PROVIDER`, which also drives production. The amendment above keeps one run from mixing models, but a pure Anthropic run would still be appended to the Groq history: Δ, trend, the replay gate's baseline and the ADR-0031 ratchet would then compare models.

**Decision.**
- `evals.yml` has a `workflow_dispatch` input `provider` (`repo-variable` | `groq` | `anthropic`, default `repo-variable`), passed as `AI_PROVIDER` to the eval step only. `schedule` ignores it. `repo-variable` stands for "empty": a choice input with an empty option is not reliable.
- `partitionByPublishedModel(scorecard, resultsList)` (`eval_scorecard.mjs`), applied by `assembleSite` after `partitionPublishable`: a run whose `meta.model` differs from the model of the suite's latest published run is not appended (`kind: 'model_mismatch'`, `::notice::`, not the provider-failure `::warning::`). The first run of an empty suite sets its model. The results artifact is always uploaded.
- Every run records `cost_est` (`PRICES_USD_PER_MTOK`, list price; `null` for Groq's free tier) and `coverage` (`n`, `diff_truncated`, `code_cut` = `unreviewed_code_files` non-empty, `withheld` shares; `null` for a suite without `diff_truncated`) in its scorecard row, shown in `scorecard.md`. `anthropic_client.mjs` does not return the API's `usage`, so the cost is priced on the harness's chars/4 estimate and labelled `chars/4 estimate`.
- A new eval-job step runs `build_eval_site.mjs --report` (no API key, `continue-on-error`): model, scores, cost and coverage next to the suite's latest published run, in the step summary. The published baseline is best effort.

**Why skip, not key the history by suite + model.** `scorecard.json` v1 is keyed by suite name, and so are its readers: `eval_replay_ci.mjs` and `pr_evals.mjs` read `suites[name].runs[0]` as the baseline, `badges/<suite>.json` and the dashboard tiles show `runs[0]`, `SUITES[name].thresholds` are per suite. A `suite@model` key would be a v2 format that each reader must learn, plus a rule for which model is "the" suite's. A second model's history has no consumer until the stage actually moves (#199 step 2). Skipping keeps v1 and every reader unchanged, and the run is still fully kept (artifact + step summary).

**Consequences.**
- ✅ Δ, trend, the replay/PR-eval baseline and the ADR-0031 ratchet only ever compare runs of one model.
- ✅ The comparison covers coverage (diff cut, WITHHELD) and cost, not only accuracy.
- ⚠️ The cost line ignores the prompt cache (input over-estimated: the system prompt is cached) and thinking tokens (output under-estimated at effort `high`). An order of magnitude, not the bill; measured usage needs `anthropic_client.mjs` to return it.
- ⚠️ On Anthropic the review prompt has no input budget but keeps the 12,000-char diff cap (`reviewInputBudget`), so `diff_truncated` can still be non-zero there.
- ⚠️ Moving the review stage to Anthropic (#199 step 2) makes every weekly `review` run a model mismatch against the Groq history: that change must re-baseline the suite explicitly (a new history, thresholds re-checked under ADR-0031), or the history goes stale.
