# ADR-0024: Switch Groq defaults to `openai/gpt-oss-120b` with per-stage reasoning effort

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Groq retired both default models used by `config/models.yaml` on its free and developer tiers:

| Model | Stages | Shutdown |
|---|---|---|
| `qwen/qwen3-32b` | `validation`, `review` | 2026-07-17 |
| `llama-3.3-70b-versatile` | `generation`, `autofix` | 2026-08-16 |

Every Groq call has since failed with `404 model_not_found` (observed on the `review` job of PR #159). With the Anthropic key also invalid, the whole loop was down. Groq's recommended replacement for both is `openai/gpt-oss-120b`.

`gpt-oss-120b` is not a drop-in rename:

- It is a **reasoning model**. Reasoning tokens count toward `max_tokens` and toward the per-minute token limit (TPM). The default effort is `medium`.
- It accepts `reasoning_effort` = `low` | `medium` | `high` (not `none`); non-reasoning models reject the parameter.
- Reasoning is returned in a separate `reasoning` field, so `choices[0].message.content` stays the answer the parsers expect. `response_format: json_object` is supported.
- Context window 131,072 tokens; free-tier limit **8,000 TPM** (the retired `llama-3.3-70b-versatile` had 12,000, which ADR-0017's auto-fix budget was sized for).

## Decision

1. All four stages default to `openai/gpt-oss-120b` (`GROQ_MODEL` still overrides every stage).
2. New optional key `<stage>_reasoning_effort` in `config/models.yaml`, validated by `loadLLMConfig()` (`low` | `medium` | `high`) and returned as `reasoningEffort`. `callGroq()` sends `reasoning_effort` only when it is set; `callAnthropic()` ignores it. All four entrypoints forward it. The `GROQ_REASONING_EFFORT` variable overrides every stage, and `off` stops sending the parameter, so a non-reasoning `GROQ_MODEL` override needs no `config/models.yaml` change (that file is read from the default branch, ADR-0023). All stages are set to `low`: validation and generation/auto-fix emit strict JSON where reasoning only costs output budget, and on an 8K TPM tier review cannot afford `medium` either (its prompt alone is ~6.5K tokens).
3. `autofix_max_input_tokens` is lowered from 7,400 to **3,000** so that system (~890 tokens: `auto-fix-system.md` has grown since ADR-0017's ~460 estimate) + input + `autofix_max_tokens` (4,096) ≈ 7,986 stays within 8K TPM. A config test asserts the sum with the system prompt measured by `estimateTokens()`, not a hard-coded constant.
4. Every stage sets `<stage>_max_tokens` explicitly (`validation` 1,024, `generation` 4,096, `review` 1,024, `autofix` 4,096). Groq rejects a request with 413 when prompt + max output exceeds the TPM, and reasoning tokens count as output, so an unset output cap leaves the request size undefined. A truncated review has no verdict line and fails closed to `REQUEST_CHANGES`.
5. `auto_fix_pr.mjs` knows the model's 131,072-token context window.

Assumption: the repository runs on Groq's **free tier**, as ADR-0017 assumed for "on_demand". On the Developer plan (much higher TPM), raise or remove `autofix_max_input_tokens`.

## Alternatives Considered

- **`qwen/qwen3.6-27b`** (Groq's other listed replacement) — itself withdrawn since, per third-party reports. Rejected.
- **Set `GROQ_MODEL` as a repository variable only** — fixes nothing for anyone running without the variable and leaves retired IDs as defaults. Rejected; the variable remains available as an override.
- **Leave `reasoning_effort` at the model default (`medium`)** — reasoning would consume the 4,096-token auto-fix output budget and the 8K TPM, truncating JSON patches. Rejected.
- **Infer `reasoning_effort` from the model name in `groq_client.mjs`** — hidden coupling to model naming. Rejected for an explicit per-stage key.

## Consequences

- ✅ The Groq path works again with a supported model; a test fails if any stage defaults to a retired model.
- ✅ Reasoning effort is explicit, per stage, and validated.
- ⚠️ On the free tier, auto-fix sees less than half the previous input budget (3,000 tokens): long diffs and feedback are truncated earlier.
- ⚠️ Free-tier 8K TPM is marginal for `review` (~6.5K prompt tokens) and `generation` (no input cap): large PRs or issues can hit `413`/`429`. The Developer plan or Anthropic is the durable fix.
- ⚠️ If `GROQ_MODEL` points at a non-reasoning model, set `GROQ_REASONING_EFFORT=off`, or Groq rejects the request with 400.
- ⚠️ `review` output is capped at 1,024 tokens (reasoning included); a long review can be cut before its verdict line and then counts as `REQUEST_CHANGES`.
- ⚠️ Shutdown dates (2026-07-17, 2026-08-16), the recommended replacement and the 8K TPM / 30 RPM / 200K TPD free-tier limits were cross-checked against Groq's deprecations page as indexed by search and several independent reports; the console itself was not reachable from the authoring environment. Re-check https://console.groq.com/docs/deprecations and the account's limits page if a 413/429 pattern appears.
