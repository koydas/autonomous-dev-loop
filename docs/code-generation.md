# Code Generation MVP Setup

This repository includes an MVP workflow that converts validated issues into AI-generated draft pull requests. The default AI provider is **Groq** with stage-specific defaults: `validation`/`review` use `qwen/qwen3-32b`, while `generation`/`autofix` use `llama-3.3-70b-versatile`. Anthropic (Claude models) is also supported and can be selected via the `AI_PROVIDER` environment variable when both provider keys are configured. The workflow triggers automatically when the validation agent applies the `ready-for-dev` label.

## Quick Start (Operator)

For a first-time setup, complete these steps in order:

1. Configure required secrets in **Settings → Secrets and variables → Actions**:
   - `ANTHROPIC_API_KEY` and/or `GROQ_API_KEY`
   - `AI_PR_TOKEN` (recommended for reliable PR/label/review writes)
2. (Optional) Configure provider variables:
   - `AI_PROVIDER` — `anthropic` or `groq`. Only needed when both keys are configured; Groq is the default.
   - `ANTHROPIC_MODEL` — Anthropic model name (defaults to `claude-opus-4-7` if unset).
   - `GROQ_MODEL` — Groq model name override for all stages (if unset, stage defaults from `config/models.yaml` are used: `generation`/`autofix` = `llama-3.3-70b-versatile`, `validation`/`review` = `qwen/qwen3-32b`).
   - `GROQ_API_URL` — Groq endpoint URL (defaults to `https://api.groq.com/openai/v1/chat/completions` if unset).

### Per-workflow environment variable matrix

All four workflows pass both provider key sets, so provider selection is driven entirely by which secrets are configured in the repository — no workflow-level override is needed.

| Workflow | Required secret(s) | Optional variables | Fallback |
|---|---|---|---|
| `validate-issue.yml` | `ANTHROPIC_API_KEY` or `GROQ_API_KEY` | `AI_PROVIDER`, `ANTHROPIC_MODEL`, `GROQ_MODEL`, `GROQ_API_URL` | Fails with clear error if neither key is present |
| `code-generation.yml` | `ANTHROPIC_API_KEY` or `GROQ_API_KEY` | `AI_PROVIDER`, `ANTHROPIC_MODEL`, `GROQ_MODEL`, `GROQ_API_URL` | Fails with clear error if neither key is present |
| `pr-review.yml` | `ANTHROPIC_API_KEY` or `GROQ_API_KEY` | `AI_PROVIDER`, `ANTHROPIC_MODEL`, `GROQ_MODEL`, `GROQ_API_URL` | Fails with clear error if neither key is present |
| `auto-fix-pr.yml` | `ANTHROPIC_API_KEY` or `GROQ_API_KEY` | `AI_PROVIDER`, `ANTHROPIC_MODEL`, `GROQ_MODEL`, `GROQ_API_URL` | Fails with clear error if neither key is present |

`AI_PR_TOKEN` is used only by `code-generation.yml`, `pr-review.yml`, and `auto-fix-pr.yml` for GitHub API write operations.

## GitHub Actions PR Permission Requirement

If the run fails with:

`GitHub Actions is not permitted to create or approve pull requests.`

you have two supported options:

1. Enable repository setting **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**.
2. Set `AI_PR_TOKEN` and keep the setting disabled (recommended for stricter org policies).

## Required Label

The validation workflow creates and manages these labels automatically:

- `ready-for-dev` — applied when issue quality is sufficient; triggers PR generation.
- `needs-refinement` — applied when the issue requires clearer acceptance criteria.

The PR review workflow creates and manages these labels automatically:

- `review-approved` — applied when the automated code review verdict is APPROVED.
- `changes-requested` — applied when the automated code review verdict is REQUEST_CHANGES.

All label names, colors, and descriptions are configurable in `config/labels.yaml`.

## End-to-End Test

1. Ensure secrets above are configured.
2. Create a new GitHub issue using the feature or bug template, with a clear title and body.
3. Open **Actions** and confirm run `Issue Validation Agent` starts.
4. Once validation passes, confirm `Code Generation` starts automatically from the `ready-for-dev` label event.
5. Verify logs for:
   - prompt construction
   - LLM API call success
   - branch creation (`ai/issue-<number>`)
   - PR creation
6. Confirm PR details:
   - title references the issue number/title
   - body includes generated summary and `Closes #<number>`
   - changed files are limited to the generated AI target paths (maximum 6 files)

## Loop: `issue -> issue review`

The project now runs as a continuous loop rather than a one-shot generation:

1. **Issue validation** (`validate-issue.yml`) reviews issue quality and applies `ready-for-dev` or `needs-refinement`.
2. **Code generation** (`code-generation.yml`) starts only when `ready-for-dev` is applied and opens/updates a PR for that issue.
3. **PR review** (`pr-review.yml`) runs on branch pushes, posts structured feedback, submits review status, and applies `review-approved` or `changes-requested`.
4. **Auto-fix** (`auto-fix-pr.yml`) runs when `changes-requested` is applied, generates a targeted fix commit, and pushes it.
5. The push from auto-fix re-triggers **PR review**, creating the iterative review loop.
6. The loop ends when either:
   - PR review returns `review-approved`, or
   - auto-fix reaches 3 attempts and requests manual intervention.

## End-to-End Control Flow

```mermaid
sequenceDiagram
    actor User
    participant Issue
    participant validate-issue.yml
    participant code-generation.yml
    participant pr-review.yml
    participant auto-fix-pr.yml
    participant PR


```

## Observability

Every workflow run produces two observable outputs on top of GitHub Actions step logs.

### Structured JSON events (stderr)

Each instrumented pipeline script writes one JSON line to stderr per meaningful event. Schema:

```json
{ "ts": "<ISO8601>", "run_id": "<GITHUB_RUN_ID>", "stage": "<stage>", "event": "<event>", "level": "info|warn|error", "duration_ms": <number|null>, "meta": {} }
```

`duration_ms` is populated on all terminal events (`*.complete`, `*.pass`, `*.fail`, `*.verdict`). Error-level events also emit `::error::` GitHub Actions annotations, which surface in the PR checks UI.

Stages and minimum events:

| Stage | Script | Events |
|---|---|---|
| `issue_validation` | `validate_issue.mjs` | `start`, `pass`/`fail` |
| `code_gen` | `generate_issue_change.mjs` | `start`, `llm_request`, `llm_response`, `complete`, `error` |
| `pr_prepare` | `generate_issue_change.mjs` | `start`, `complete`, `error` |
| `review` | `pr_review.mjs` | `start`, `llm_request`, `llm_response`, `verdict`, `error` |
| `autofix` | `auto_fix_pr.mjs` | `start`, `llm_request`, `llm_response`, `push`, `max_attempts_reached`, `error` |

### Run trace file

Each workflow writes `observability/traces/<GITHUB_RUN_ID>.json` and uploads it as the artifact `run-trace-<GITHUB_RUN_ID>` (`if: always()`). The file is written incrementally so it contains partial data even if the job is killed.

```bash
# Read a trace after downloading the artifact:
cat observability/traces/<run_id>.json | jq '[.spans[] | {stage, outcome, duration_ms}]'
```

Full schema and event tables: `docs/observability.md`. Design rationale: [ADR-0018](adr/0018-structured-observability.md).

## Structured Logging API (`scripts/lib/logger.mjs`)

All automation scripts share a structured JSON logger. Each line written to stdout/stderr is a valid JSON object.

### Core functions

```js
import { log, error, setLogContext, logStart, logEnd, logSummary } from './lib/logger.mjs';
```

| Function | Output stream | `level` field | Description |
|---|---|---|---|
| `log(msg, data?)` | stdout | `info` | General informational event |
| `error(msg, data?)` | stderr | `error` | Error or warning event |
| `logSummary({ success, stepsCompleted, errors })` | stdout | `info` | Emits a `run_summary` entry at script exit |
| `logStart(step)` | — | — | Records start timestamp for a named step |
| `logEnd(step, result)` | stdout | `info` | Emits `step_end` with elapsed `durationMs` |

### Log context

Call `setLogContext(fields)` once at startup to attach fields (e.g. `run_id`, `step`, `attempt`) to every subsequent `log` and `error` call. Per-call `data` fields override context fields with the same key.

```js
setLogContext({ run_id: process.env.GITHUB_RUN_ID, step: 'auto-fix', attempt: 1 });
log('Starting', { prNumber: 42 });
// → {"level":"info","msg":"Starting","run_id":"…","step":"auto-fix","attempt":1,"prNumber":42}
```

### Run summary

Emit a terminal summary in the `unhandledRejection` handler and at normal exit so log consumers can detect silent failures:

```js
// on failure
logSummary({ success: false, stepsCompleted: ['labels'], errors: [err.message] });

// on success
logSummary({ success: true, stepsCompleted: ['labels', 'diff', 'llm', 'write', 'label'], errors: [] });
```

### Step timing

```js
logStart('llm-call');
const raw = await callLLM(…);
logEnd('llm-call', 'ok');
// → {"level":"info","msg":"step_end","step":"llm-call","result":"ok","durationMs":1234.5}
```

## Minimum Test Coverage Policy

The following module must maintain **≥ 80% test coverage**, enforced in CI by `test.yml` via `c8 --check-coverage`:

- **Checkpoint resume** (`scripts/lib/checkpoint.mjs`): ≥ 80% across statements, branches, functions, and lines. Every distinct failure branch (ENOENT vs non-ENOENT in `readCheckpoint`, `mkdir` propagation in `writeCheckpoint`) must have a dedicated test case.

The following modules also maintain **≥ 80% test coverage**, each enforced by a dedicated `c8 --check-coverage` step in `test.yml`:

- **Config** (`scripts/lib/config.mjs`)
- **LLM client** (`scripts/lib/llm_client.mjs`)
- **Output writer** (`scripts/lib/output_writer.mjs`)

## Auto-Fix Token Budget

The auto-fix stage constructs an LLM prompt from three sources — PR diff, review feedback, and current file contents. The total request size is capped to respect provider per-request limits (notably Groq on_demand's 12,000 TPM hard limit).

Three keys in `config/models.yaml` control the budget for the `autofix` stage:

| Key | Default | Description |
|---|---|---|
| `autofix_max_input_tokens` | `7400` | Hard ceiling on the total user-prompt tokens (wrapper + diff + feedback + files). Set to stay within `12000 − system_tokens − max_output_tokens`. The static wrapper text of `auto-fix-user.md` (~218 tokens) is deducted first; the remainder is divided among the three sections. Remove the key to use the full model context window (e.g. after upgrading to Groq Dev Tier or switching to Anthropic). |
| `autofix_diff_ratio` | `0.45` | Fraction of the section budget (after wrapper deduction) allocated to the PR diff. |
| `autofix_feedback_ratio` | `0.25` | Fraction of the section budget allocated to review feedback. The remainder goes to file contents. |

**Tuning for your provider tier:**

| Provider / Tier | Recommended `autofix_max_input_tokens` |
|---|---|
| Groq on_demand (`llama-3.3-70b-versatile`) | `7400` (default) |
| Groq Dev Tier | Remove the key (no cap needed — 12k TPM limit applies per-minute, not per-request) |
| Anthropic (`claude-opus-4-7`) | Remove the key (200k context window; no per-request TPM limit) |

The `token_estimate` log line emitted by `auto_fix_pr.mjs` shows the actual token counts for each section:

```json
{"level":"info","msg":"token_estimate","system":459,"wrapper":218,"diff":3231,"feedback":1795,"files":2156,"max_tokens":4096,"total":11955}
```

Monitor this to detect systematic truncation of diff or file contents.

## Checkpoint Resume

Critical job outputs are persisted to `./checkpoints/<runId>/<step>.json` via `scripts/lib/checkpoint.mjs` and exchanged between jobs as GitHub Actions artifacts. This allows a re-triggered run to resume from the last successful step rather than starting from scratch.

### RunId naming conventions

| Workflow chain | RunId format | Artifact name |
|---|---|---|
| `validate-issue` → `code-generation` | `issue-<number>` | `checkpoints-issue-<number>` |
| `pr-review` → `auto-fix-pr` | `pr-<number>` | `checkpoints-pr-<number>` |

The `CHECKPOINT_RUN_ID` environment variable overrides the default; each script falls back to deriving the ID from `ISSUE_NUMBER` or the resolved PR number if the variable is absent.

### Step names written per job

| Job script | Step name | Persisted fields |
|---|---|---|
| `validate_issue.mjs` | `validate` | `valid`, `score` |
| `generate_issue_change.mjs` | `generate` | `summary`, `outputPaths` |
| `pr_review.mjs` | `review` | `isApproved`, `prNumber` |
| `auto_fix_pr.mjs` | `autofix` | `prNumber`, `attempt`, `outputPaths` |

### Prerequisite enforcement

`code-generation` (when triggered by the automated pipeline via `validate_run_id` dispatch input) and `auto-fix-pr` both fail explicitly with `::error::` if the expected upstream checkpoint file is not present, preventing execution in an incoherent state.

### Cross-workflow artifact download

- `validate-issue` passes its `GITHUB_RUN_ID` as the `validate_run_id` workflow-dispatch input when triggering `code-generation`. The generate job uses this run-id to download the artifact.
- `auto-fix-pr` uses `gh api repos/{owner}/{repo}/actions/artifacts?name=checkpoints-pr-{PR_NUMBER}` to locate the latest non-expired checkpoint artifact and downloads it with `curl`.

### Artifact retention

GitHub Actions artifact retention applies (default 90 days). Old checkpoint artifacts for the same issue or PR number are overwritten (`overwrite: true`) on each new run.

### Test coverage requirement

`scripts/lib/checkpoint.mjs` and all code paths that call `writeCheckpoint`/`readCheckpoint` must maintain **≥ 80% test coverage**. Every distinct failure branch (e.g. ENOENT vs non-ENOENT in `readCheckpoint`, `mkdir` propagation in `writeCheckpoint`) must have a dedicated test case.

## Startup Fail-Fast Validation (automation entrypoints)

Automation scripts must fail before network calls when required startup inputs are invalid:

- **Environment**: required vars are validated synchronously at process start (`GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_PATH`, provider API key, etc.).
- **Prompts**: prompt files are loaded and validated as existing + non-empty at startup, with explicit file-path errors when missing/empty.
- **GitHub payload**: required fields are validated with path-based errors:
  - PR number: `pull_request.number` or fallback `issue.number`.
  - Branch reference (when needed): `pull_request.head.ref` or fallback `ref`.
- **Provider payload parsing**: response-shape failures include concrete expected paths:
  - Anthropic: `content[0].text`
  - Groq: `choices[0].message.content`

## CI Coverage Enforcement

The repository enforces a minimum test coverage policy through CI using `c8 --check-coverage`. The following modules must maintain **≥ 80% test coverage**, each enforced by a dedicated step in `test.yml`:

- **Checkpoint resume** (`scripts/lib/checkpoint.mjs`)
- **Configuration** (`scripts/lib/config.mjs`)
- **LLM client** (`scripts/lib/llm_client.mjs`)
- **Output writer** (`scripts/lib/output_writer.mjs`)