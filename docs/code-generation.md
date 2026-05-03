# Code Generation MVP Setup

This repository includes an MVP workflow that converts validated issues into AI-generated draft pull requests. The default AI provider is **Groq** (`qwen/qwen3-32b`). Anthropic (Claude models) is also supported and can be selected via the `AI_PROVIDER` environment variable when both provider keys are configured. The workflow triggers automatically when the validation agent applies the `ready-for-dev` label.

## Quick Start (Operator)

For a first-time setup, complete these steps in order:

1. Configure required secrets in **Settings → Secrets and variables → Actions**:
   - `ANTHROPIC_API_KEY` and/or `GROQ_API_KEY`
   - `AI_PR_TOKEN` (recommended for reliable PR/label/review writes)
2. (Optional) Configure provider variables:
   - `AI_PROVIDER`, `ANTHROPIC_MODEL`, `GROQ_MODEL`, `GROQ_API_URL`
3. Confirm repository Actions permission strategy:
   - either enable **Allow GitHub Actions to create and approve pull requests**
   - or keep it disabled and rely on `AI_PR_TOKEN`
4. Create/edit an issue and wait for `ready-for-dev`.
5. Verify generated PR appears on branch `ai/issue-<number>`.
6. Monitor review loop labels:
   - `review-approved` ends the loop
   - `changes-requested` triggers auto-fix (up to 3 attempts)

If something fails, use `docs/runbook.md` symptom mapping and recovery actions first.

## Workflow Overview

File: `.github/workflows/code-generation.yml`

Workflow design note: YAML stays intentionally minimal (orchestration only). Most logic lives in Node modules for future unit testing.

Node implementation:
- Entrypoint: `scripts/generate_issue_change.mjs`
- Modules: `scripts/lib/config.mjs`, `scripts/lib/llm_client.mjs`, `scripts/lib/anthropic_client.mjs`, `scripts/lib/groq_client.mjs`, `scripts/lib/output_writer.mjs`

When the `ready-for-dev` label is applied to an issue, the workflow:
1. Builds a deterministic prompt using issue number, title, and body.
2. Calls the LLM API (Groq by default) using repository secrets.
3. Writes 1 to 6 generated files at AI-selected relative paths.
4. Creates a branch named `ai/issue-<number>`.
5. Uses `peter-evans/create-pull-request` to commit generated content on `ai/issue-<number>`.
6. Opens a PR to the repository default branch with `Closes #<issue_number>`.

If generation fails or no patch is produced, the workflow exits before PR creation.

## Required Secrets

Configure these in **Settings → Secrets and variables → Actions**:

Provider selection is automatic based on which secrets are configured:

| Secrets configured | Provider used |
|---|---|
| `GROQ_API_KEY` only | Groq |
| `ANTHROPIC_API_KEY` only | Anthropic |
| Both | Groq (default) — override with `AI_PROVIDER=anthropic` |
| Neither | Fails with a clear error |

- **Secret**: `ANTHROPIC_API_KEY` — API key for Anthropic (Claude models).
- **Secret**: `GROQ_API_KEY` — API key for Groq.
- **Secret**: `AI_PR_TOKEN` (recommended) — GitHub token used for PR creation.
  - Use a fine-grained PAT or GitHub App token with at least **Contents: Read/Write**, **Pull requests: Read/Write**, and **Issues: Read/Write** on this repository.
  - If `AI_PR_TOKEN` is not set, the workflow falls back to `GITHUB_TOKEN`.
- **Variables** (optional):
  - `AI_PROVIDER` — `anthropic` or `groq`. Only needed when both keys are configured; Groq is the default.
  - `ANTHROPIC_MODEL` — Anthropic model name (defaults to `claude-opus-4-7` if unset).
  - `GROQ_MODEL` — Groq model name (defaults to `qwen/qwen3-32b` if unset).
  - `GROQ_API_URL` — Groq endpoint URL (defaults to `https://api.groq.com/openai/v1/chat/completions` if unset).

## Testing Requirements
All automation logic changes must maintain:
- Minimum 80% unit test coverage for core workflows
- 100% coverage for error handling and security-critical paths
- Explicit test documentation in PR descriptions

## Coverage Enforcement
CI pipelines will fail if:
- New automation logic introduces uncovered code
- Test coverage drops below 80% for any module
- Label reset workflow tests don't verify DELETE/POST sequence

## Workflow Documentation
Critical automation behavior must include:
1. PR creation workflow steps
2. Label management sequence diagrams
3. Test coverage policy references

## Automation Gates
PR validation requires:
- [x] Unit test updates
- [x] Documentation updates
- [x] 100% test coverage enforcement

## Core Workflow Sequence
1. Label removal via DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}
2. Label application via POST /repos/{owner}/{repo}/issues/{issue_number}/labels

[Original guidelines content preserved...]