# MVP: AI-Assisted Issue-to-PR Workflow

## Objective
Build a minimal automation flow where creating a new GitHub issue triggers a workflow that:
1. Sends a prompt to an AI model.
2. Uses the AI response to implement a small code/documentation change.
3. Opens a simple pull request automatically.

## Problem to Solve
Teams lose time on repetitive starter tasks (small fixes, doc updates, scaffolding). We need a fast way to go from issue description to an initial PR draft.

## Target Users
- Small engineering teams.
- Maintainers handling repetitive backlog items.
- Projects where quick first-draft PRs reduce cycle time.

## In-Scope (MVP)
- Trigger on **new issue** event.
- Build a prompt from issue title + body.
- Call an AI model with that prompt.
- Create/modify files in a dedicated branch.
- Open a PR with generated title/body.
- Add basic logging for traceability.

## Out of Scope (MVP)
- Multi-file complex refactors.
- Full autonomous code review.
- Automatic merge.
- Advanced security policy engine.
- Multi-model orchestration.

## Functional Requirements
1. On issue creation, workflow runs once.
2. Workflow sends deterministic prompt template to AI.
3. AI output is applied as a minimal patch.
4. Branch naming follows convention (e.g., `ai/issue-<number>`).
5. PR is created against default branch.
6. PR links back to the original issue.

## Non-Functional Requirements
- Runtime target: under 5 minutes per run.
- Failure-safe: if generation fails, no PR is opened.
- Observability: log prompt metadata, run status, and error reason.
- Security: use repository secrets for API tokens.

## Success Metrics
- >= 80% of eligible issues trigger workflow successfully.
- >= 60% of generated PRs are considered useful first drafts.
- Median time issue -> PR < 10 minutes.

## Delivery Plan
1. **Week 1**: workflow trigger + prompt template + AI call.
2. **Week 2**: patch application + branch push + PR creation.
3. **Week 3**: guardrails, logs, and pilot on limited issue labels.

## Risks and Mitigations
- **Risk:** low-quality AI output.
  - **Mitigation:** strict prompt template and small-scope issues only.
- **Risk:** unsafe changes.
  - **Mitigation:** limit writable paths and require human review before merge.
- **Risk:** flaky automation.
  - **Mitigation:** retries + clear failure notifications.

## Next Steps
- Define the exact issue label(s) eligible for automation.
- Finalize prompt template and output format contract.
- Implement GitHub Actions workflow and pilot with test issues.
