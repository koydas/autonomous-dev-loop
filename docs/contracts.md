# Script / Workflow I/O Contracts

This document specifies the interface contract for each entrypoint script: required environment variables, workflow outputs, exit codes, and failure modes.

---

## `scripts/validate_issue.mjs`

**Used by:** `validate-issue.yml` (job: `validate`, step id: `validate`)

### Required env vars

| Variable | Description |
|---|---|
| `ISSUE_NUMBER` | Issue number to validate |
| `ISSUE_TITLE` | Issue title |
| `GROQ_API_KEY` | LLM provider API key |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `ISSUE_BODY` | `(no body provided)` | Issue body text |
| `GROQ_MODEL` | provider default | LLM model identifier |
| `GROQ_API_URL` | provider default | LLM API base URL |
| `GITHUB_OUTPUT` | — | Path to GitHub Actions output file; outputs are skipped if absent |

### Workflow outputs

| Key | Type | Description |
|---|---|---|
| `valid` | `"true"` \| `"false"` | Whether the issue passed validation |
| `score` | integer string | Validation score |
| `comment` | multiline string | Formatted GitHub markdown comment for the issue |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Validation completed (valid or invalid) |
| `1` | Unhandled rejection or fatal error |

---

## `scripts/generate_issue_change.mjs`

**Used by:** `code-generation.yml` (job: `generate-pr`, step id: `generate`)

### Required env vars

| Variable | Description |
|---|---|
| `ISSUE_NUMBER` | Issue number being processed |
| `ISSUE_TITLE` | Issue title |
| `GROQ_API_KEY` | LLM provider API key |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `ISSUE_BODY` | `""` | Issue body text |
| `GROQ_MODEL` | provider default | LLM model identifier |
| `GROQ_API_URL` | provider default | LLM API base URL |
| `GITHUB_OUTPUT` | — | Path to GitHub Actions output file; outputs are skipped if absent |

### Workflow outputs

| Key | Type | Description |
|---|---|---|
| `summary` | multiline string | AI-generated PR description |
| `generated_paths` | multiline string | Newline-separated list of file paths to include in the PR via `add-paths` |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Files generated and outputs written |
| `1` | LLM returned invalid JSON, validation failed, or fatal I/O error |

---

## `scripts/auto_fix_pr.mjs`

**Used by:** `auto-fix-pr.yml` (job: `auto-fix`, step id: `fix`)

### Required env vars

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Token with `contents:write` and `pull-requests:write` |
| `GITHUB_REPOSITORY` | `owner/repo` format |
| `GITHUB_EVENT_PATH` | Path to the GitHub event JSON payload |
| `GROQ_API_KEY` | LLM provider API key |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `GROQ_MODEL` | provider default | LLM model identifier |
| `GROQ_API_URL` | provider default | LLM API base URL |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API base URL |
| `GITHUB_OUTPUT` | — | Path to GitHub Actions output file; outputs are skipped if absent |

### Workflow outputs

| Key | Type | Description |
|---|---|---|
| `fixed_paths` | multiline string | Newline-separated list of modified file paths; empty string if nothing was written |
| `attempt_number` | integer string | The attempt number that was just applied (1–3) |
| `summary` | multiline string | AI-generated fix summary |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Fixes applied, **or** max attempts already reached (posts exhaustion comment and exits cleanly), **or** attempt already completed (checkpoint resume), **or** PR modifies the auto-fixer itself (self-modification guard) |
| `1` | GitHub API error, LLM returned invalid JSON, or fatal error |

### Behavioral constraints

- Maximum of **3 auto-fix attempts** (`MAX_ATTEMPTS`). Attempt count is tracked by labels named `auto-fix-attempt-N` on the PR.
- When the limit is reached the script posts a `## 🤖 Auto-Fix Exhausted` comment and exits `0` without writing outputs.
- The downstream workflow step (`Commit and push fixes`) is conditioned on `fixed_paths != ''` and skips silently if the LLM produced no changes.
- **Self-modification guard:** if the PR includes changes to `scripts/auto_fix_pr.mjs`, the script posts a `## 🤖 Auto-Fix Skipped` comment and exits `0` without calling the LLM, to prevent feedback loops.
- **Checkpointing:** after each critical step the script writes an atomic checkpoint file (`checkpoint-attempt-N.json`) via a temp-file-then-rename strategy. At startup, if that file already records `stage: "complete"` with a matching `inputHash`, the script exits `0` immediately (idempotent re-run safety). Checkpoint stages in order: `ai-complete` → `files-written` → `complete`.

### Checkpoint file schema

Written to `checkpoint-attempt-N.json` in the working directory:

| Field | Type | Description |
|---|---|---|
| `runId` | string | `GITHUB_RUN_ID` of the Actions run that wrote this checkpoint |
| `stage` | `"ai-complete"` \| `"files-written"` \| `"complete"` | Last successfully completed stage |
| `attempt` | integer | Attempt number (1–3) |
| `inputHash` | string | SHA-256 of `prNumber + GITHUB_SHA`; used to detect stale checkpoints on re-run |
| `timestamp` | ISO 8601 string | Wall-clock time of the write |
| `summary` | string | AI-generated fix summary (present from `ai-complete` onward) |
| `changesCount` | integer | Number of file changes returned by the LLM (present at `ai-complete`) |
| `outputPaths` | string[] | Paths of written files (present from `files-written` onward) |

---

## `scripts/pr_review.mjs`

**Used by:** `pr-review.yml` (job: `review`)

### Required env vars

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Token with `pull-requests:write` and `issues:write` |
| `GITHUB_REPOSITORY` | `owner/repo` format |
| `GITHUB_EVENT_PATH` | Path to the GitHub event JSON payload |
| `GROQ_API_KEY` | LLM provider API key |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `GROQ_MODEL` | provider default | LLM model identifier |
| `GROQ_API_URL` | provider default | LLM API base URL |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API base URL |

### Workflow outputs

None. This script writes directly to GitHub (review comment, PR review event, labels).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Review posted, **or** no open PR found for the pushed branch (skips silently) |
| `1` | GitHub API error or fatal error |

### Behavioral constraints

- Verdict is extracted from the LLM response via the pattern `verdict: APPROVED` or `verdict: REQUEST_CHANGES`.
- Review comment is upserted (PATCH if a `## 🔍 Automated Code Review` comment already exists, POST otherwise).
- Labels `review-approved` and `review-changes-requested` are upserted then toggled based on verdict.
- When verdict is `REQUEST_CHANGES`, the `review-changes-requested` label is re-pulsed (removed then re-added) unless an `auto-fix-pr.yml` run is already active for that branch, to avoid duplicate auto-fix triggers.

---

## `scripts/manage_labels.mjs`

**Used by:** `validate-issue.yml` (job: `validate`, step: `Manage labels`)

### Required env vars

| Variable | Description |
|---|---|
| `ISSUE_NUMBER` | Issue number |
| `GITHUB_REPOSITORY` | `owner/repo` format |
| `IS_VALID` | `"true"` or `"false"` — result from the `validate` step |
| `GH_TOKEN` or `GITHUB_TOKEN` | Token with `issues:write` |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API base URL |

### Workflow outputs

None. Labels are applied directly via GitHub API.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Labels applied successfully |
| `1` | Missing required env var, GitHub API error, or fatal error |

---

## `scripts/upsert_issue_validation_comment.mjs`

**Used by:** `validate-issue.yml` (job: `validate`, step: `Upsert validation comment`)

### Required env vars

| Variable | Description |
|---|---|
| `ISSUE_NUMBER` | Issue number |
| `GITHUB_REPOSITORY` | `owner/repo` format |
| `COMMENT_BODY` | Comment text (sourced from the `validate` step's `comment` output) |
| `GH_TOKEN` or `GITHUB_TOKEN` | Token with `issues:write` |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API base URL |

### Workflow outputs

None. Comment is written directly via GitHub API.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Comment created or updated |
| `1` | Missing required env var, GitHub API error, or fatal error |

### Behavioral constraints

- Idempotent: detects an existing comment by the hidden marker `<!-- issue-validation-report -->` and PATCHes it; otherwise POSTs a new one.
