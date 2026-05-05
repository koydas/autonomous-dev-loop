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

## Test Coverage Requirements

All automation-scope changes must maintain **minimum 85% test coverage** for critical path logic. This includes:
- Label management error handling
- Configuration validation
- Workflow execution paths

**Automation workflows must enforce an 85%+ coverage gate before deployment** to ensure reliability of generated code. Coverage reports must be reviewed in pull requests to ensure no regression in automation reliability.

## Workflow Overview

File: `.github/workflows/code-generation.yml`

Workflow design note: YAML stays intentionally minimal (orchestration only). Most logic lives in Node modules for future unit testing.

Node implementation:
- Entrypoint: `scripts/generate_issue_change.mjs`
- Modules: `scripts/lib/config.mjs`, `s