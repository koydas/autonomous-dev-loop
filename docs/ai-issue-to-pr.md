# AI Issue-to-PR MVP Setup (Groq)

This repository includes an MVP workflow that converts issues labeled with `ai-task` into AI-generated draft pull requests using Groq.

## Workflow Overview

File: `.github/workflows/ai-issue-to-pr.yml`

Workflow design note: YAML stays intentionally minimal (orchestration only). Most logic lives in Node modules for future unit testing.

Node implementation:
- Entrypoint: `scripts/generate_issue_change.mjs`
- Modules: `scripts/lib/config.mjs`, `scripts/lib/groq_client.mjs`, `scripts/lib/output_writer.mjs`

When the `ai-task` label is added to an issue, the workflow:
1. Runs only when the issue includes the `ai-task` label.
2. Builds a deterministic prompt using issue number, title, and body.
3. Calls the Groq API using repository secrets.
4. Writes exactly one generated file at the AI-selected relative path (for example `helloworld.md`).
5. Creates a branch named `ai/issue-<number>`.
6. Uses `peter-evans/create-pull-request` to commit generated content on `ai/issue-<number>`.
7. Opens a PR to the repository default branch with `Closes #<issue_number>`.
8. Removes the `ai-task` label from the issue once the workflow run completes.

If generation fails or no patch is produced, the workflow exits before PR creation.

## Required Secrets

Configure these in **Settings → Secrets and variables → Actions**:

- **Secret**: `GROQ_API_KEY` (required) — API key for Groq.
- **Secret**: `AI_PR_TOKEN` (recommended) — GitHub token used for PR creation/issue label cleanup.
  - Use a fine-grained PAT or GitHub App token with at least **Contents: Read/Write**, **Pull requests: Read/Write**, and **Issues: Read/Write** on this repository.
  - If `AI_PR_TOKEN` is not set, the workflow falls back to `GITHUB_TOKEN`.
- **Variables** (optional):
  - `GROQ_MODEL` — model name (defaults to `llama-3.1-8b-instant` if unset).
  - `GROQ_API_URL` — endpoint URL (defaults to `https://api.groq.com/openai/v1/chat/completions` if unset).

## GitHub Actions PR Permission Requirement

If the run fails with:

`GitHub Actions is not permitted to create or approve pull requests.`

you have two supported options:

1. Enable repository setting **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests**.
2. Set `AI_PR_TOKEN` and keep the setting disabled (recommended for stricter org policies).

## Required Label

Create and use this issue label:

- `ai-task`

Only issues where this label is actively applied trigger the automation job.

## End-to-End Test

1. Ensure secrets above are configured.
2. Ensure the `ai-task` label exists.
3. Create a new GitHub issue with a short title/body describing a small docs/code task.
4. Add label `ai-task` to that issue.
5. Open **Actions** and confirm run `AI Issue to PR` starts from the labeling event.
6. Verify logs for:
   - prompt construction
   - Groq API call success
   - branch creation (`ai/issue-<number>`)
   - PR creation
7. Confirm PR details:
   - title references the issue number/title
   - body includes generated summary and `Closes #<number>`
   - changed files limited to a single AI-generated target file
8. Confirm the issue label `ai-task` has been removed after the run completes.

## Limitations (MVP)

- Triggers on issue label application events.
- Only runs when the applied label name is exactly `ai-task`.
- Applies exactly one small generated file per run (safe scope).
- Does not perform auto-merge.
- Does not attempt multi-file or complex refactors.

## Risk and Mitigation Note

- **Risk:** AI output may be low quality or off-target.
  - **Mitigation:** deterministic prompt template, temperature `0`, and small-scope generated file.
- **Risk:** accidental broad modifications.
  - **Mitigation:** generated patch is constrained to one validated relative path and one file write.
- **Risk:** workflow secrets misconfiguration.
  - **Mitigation:** explicit secret checks and fail-fast logging before commit/PR steps.

## PR Review Workflow (Groq)

File: `.github/workflows/pr-review.yml`

Required secret:
- **Secret**: `GROQ_API_KEY` (required) — used to review pull request diffs and post/update a structured PR comment.

The workflow runs on pull requests (`opened`, `synchronize`, `reopened`) with `pull-requests: write` and `contents: read`.

