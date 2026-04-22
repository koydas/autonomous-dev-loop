# AI Issue-to-PR MVP Setup (Groq)

This repository includes an MVP workflow that converts validated issues into AI-generated draft pull requests using Groq. The workflow triggers automatically when the validation agent applies the `ready-for-dev` label.

## Workflow Overview

File: `.github/workflows/ai-issue-to-pr.yml`

Workflow design note: YAML stays intentionally minimal (orchestration only). Most logic lives in Node modules for future unit testing.

Node implementation:
- Entrypoint: `scripts/generate_issue_change.mjs`
- Modules: `scripts/lib/config.mjs`, `scripts/lib/groq_client.mjs`, `scripts/lib/output_writer.mjs`

When the `ready-for-dev` label is applied to an issue, the workflow:
1. Builds a deterministic prompt using issue number, title, and body.
2. Calls the Groq API using repository secrets.
3. Writes 1 to 3 generated files at AI-selected relative paths.
4. Creates a branch named `ai/issue-<number>`.
5. Uses `peter-evans/create-pull-request` to commit generated content on `ai/issue-<number>`.
6. Opens a PR to the repository default branch with `Closes #<issue_number>`.

If generation fails or no patch is produced, the workflow exits before PR creation.

## Required Secrets

Configure these in **Settings → Secrets and variables → Actions**:

- **Secret**: `GROQ_API_KEY` (required) — API key for Groq.
- **Secret**: `AI_PR_TOKEN` (recommended) — GitHub token used for PR creation.
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

The validation workflow creates and manages these labels automatically:

- `ready-for-dev` — applied when issue quality is sufficient; triggers PR generation.
- `needs-refinement` — applied when the issue requires clearer acceptance criteria.

## End-to-End Test

1. Ensure secrets above are configured.
2. Create a new GitHub issue using the feature or bug template, with a clear title and body.
3. Open **Actions** and confirm run `Issue Validation Agent` starts.
4. Once validation passes, confirm `AI Issue to PR` starts automatically from the `ready-for-dev` label event.
5. Verify logs for:
   - prompt construction
   - Groq API call success
   - branch creation (`ai/issue-<number>`)
   - PR creation
6. Confirm PR details:
   - title references the issue number/title
   - body includes generated summary and `Closes #<number>`
   - changed files are limited to the generated AI target paths (maximum 3 files)

## Limitations (MVP)

- Triggers on `ready-for-dev` label application event.
- Applies 1 to 3 small generated files per run (safe scope).
- Does not perform auto-merge.
- Does not attempt multi-file or complex refactors.

## Risk and Mitigation Note

- **Risk:** AI output may be low quality or off-target.
  - **Mitigation:** deterministic prompt template, temperature `0`, and small-scope generated file.
- **Risk:** accidental broad modifications.
  - **Mitigation:** generated patch is constrained to validated relative paths with a hard limit of 3 files per run.
- **Risk:** workflow secrets misconfiguration.
  - **Mitigation:** explicit secret checks and fail-fast logging before commit/PR steps.

## PR Review Workflow (Groq)

File: `.github/workflows/pr-review.yml`

Required secret:
- **Secret**: `GROQ_API_KEY` (required) — used to review pull request diffs and post/update a structured PR comment.

The workflow runs on pull requests (`opened`, `synchronize`, `reopened`) with `pull-requests: write` and `contents: read`.
