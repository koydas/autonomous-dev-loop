# MVP: AI-Assisted Issue-to-PR Workflow

## Objective
Build a minimal automation flow where a validated GitHub issue automatically triggers a workflow that:
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
- Validate issues automatically on open/edit (Groq-backed quality gate).
- Trigger PR generation on **issue labeled** event, gated to the `ready-for-dev` label.
- Build a prompt from issue title + body.
- Call an AI model with that prompt.
- Create/modify up to 6 files in a dedicated branch.
- Open a PR with generated title/body.
- Add basic logging for traceability.

## Out of Scope (MVP)
- Multi-file complex refactors (hard cap: 6 files per run).
- Full autonomous code review.
- Automatic merge.
- Advanced security policy engine.
- Multi-model orchestration.

## Functional Requirements
1. On `issues.opened` or `issues.edited`, the validation workflow runs and applies either `ready-for-dev` or `needs-refinement`.
2. On `issues.labeled`, the generation workflow runs only when the applied label is `ready-for-dev`.
3. Workflow sends deterministic prompt template to AI.
4. AI output is applied as a minimal patch (1–6 files, safe relative paths only).
5. Branch naming follows convention (e.g., `ai/issue-<number>`).
6. PR is created against default branch.
7. PR links back to the original issue.

## Non-Functional Requirements
- Runtime target: under 5 minutes per run.
- Failure-safe: if generation fails, no PR is opened.
- Observability: log prompt metadata, run status, and error reason.
- Security: use repository secrets for API tokens.

## Success Metrics
- >= 80% of eligible issues trigger workflow successfully.
- >= 60% of generated PRs are considered useful first drafts.
- Median time issue -> PR < 10 minutes.

## Risks and Mitigations
- **Risk:** low-quality AI output.
  - **Mitigation:** strict prompt template and small-scope issues only.
- **Risk:** unsafe changes.
  - **Mitigation:** limit writable paths and require human review before merge.
- **Risk:** flaky automation.
  - **Mitigation:** retries + clear failure notifications.

## Next Steps
- Improve issue validation guidance and reviewer feedback loops for low-scoring tasks.
- Add additional safety policies while preserving the 6-file MVP scope.
- Pilot with larger issue samples and track quality metrics against acceptance criteria.
