# Label Management Idempotency

The label management system now handles 422 errors idempotently. When attempting to add a label that already exists (HTTP 422), the system will silently ignore the error and continue execution. This prevents redundant label creation and ensures idempotent behavior for automation workflows.

## Minimum Test Coverage Requirement

All automation-scope changes must maintain **minimum 85% test coverage** for critical path logic. This includes:
- Label management error handling
- Configuration validation
- Workflow execution paths

Coverage reports must be reviewed in pull requests to ensure no regression in automation reliability.

## Critical Setup References

1. Configure required secrets in **Settings → Secrets and variables → Actions**:
   - `ANTHROPIC_API_KEY` and/or `GROQ_API_KEY`
   - `AI_PR_TOKEN` (recommended for reliable PR/label writes)
2. Workflow triggers on `ready-for-dev` label
3. Generated PRs use branch naming pattern: `ai/issue-<number>`
4. Review loop labels:
   - `review-approved` ends the loop
   - `changes-requested` triggers auto-fix (up to 3 attempts)