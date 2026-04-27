# ADR-0005: Switch Groq default model to Qwen3 and per-stage temperature strategy

- **Date:** 2026-04-27
- **Status:** Accepted

## Context

The Groq default model was `llama-3.3-70b-versatile`. Three problems prompted a change:

1. **Model quality**: the project wanted to evaluate Qwen as an alternative to Llama on Groq.
2. **Model decommission**: `qwen-qwq-32b` (the first candidate) was removed from Groq shortly after being set; `qwen/qwen3-32b` is its supported successor.
3. **Temperature mismatch**: a single global temperature value was propagated to all pipeline stages, which conflicted with the different output contracts each stage requires.

An additional issue surfaced during this session: the `pull_request` GitHub Actions event never fires for pushes made through the Claude Code token, which GitHub classifies as a bot actor and for which it suppresses `pull_request` triggers to prevent loops.

## Decision

### 1. Default Groq model

Switch the default Groq model for all pipeline stages to `qwen/qwen3-32b`.

### 2. Per-stage temperatures

Replace the single `temperature` key in `config/models.yaml` with stage-specific keys. This separates the concerns of structured-output stages (which need determinism) from free-text stages (which benefit from some variance):

| Stage | Temperature | Rationale |
|---|---|---|
| `validation` | `0` | Parses JSON, emits binary valid/invalid verdict |
| `generation` | `0` | Produces deterministic file patches |
| `review` | `0.6` | Generates free-form review text |
| `autofix` | `0` | Produces deterministic file patches |

`loadLLMConfig(stage)` resolves temperature via `temperature_${stage}` first, falling back to a global `temperature` key if present.

### 3. PR Review workflow trigger

Change `.github/workflows/pr-review.yml` from `on: pull_request` to `on: push: branches: ["**"]`, mirroring `test.yml`. When triggered by a push event the script resolves the PR number via the GitHub API (`/pulls?head=owner:branch&state=open`) and exits 0 silently if no open PR exists.

### 4. PR Review quality improvements

- **Inject PR context**: fetch the PR title and body and interpolate them into `{{issueTitle}}` / `{{issueBody}}` in the review prompt. Without this the reviewer operated without intent context and flagged intentional changes as regressions.
- **Strip `<think>` tags**: `qwen/qwen3-32b` outputs chain-of-thought reasoning in `<think>...</think>` blocks. These are stripped from the response before posting the GitHub comment.

## Consequences

- ✅ `qwen/qwen3-32b` is the current supported Qwen model on Groq and replaces the decommissioned `qwen-qwq-32b`.
- ✅ Validation and generation remain fully deterministic; review output gains appropriate variance.
- ✅ PR Review now triggers reliably on every push regardless of the actor's token type.
- ✅ The reviewer receives PR intent context, reducing false-positive change requests.
- ✅ Review comments no longer expose internal model reasoning.
- ⚠️ The `push` trigger runs the review script on every branch push, including branches without open PRs (handled by a silent exit 0).
- ⚠️ Per-stage temperature keys must be added to `models.yaml` when a new pipeline stage is introduced.
