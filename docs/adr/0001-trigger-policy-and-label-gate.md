# ADR-0001: Trigger policy and label gate

- **Date:** 2026-04-14
- **Status:** Accepted — updated 2026-04-22

## Context

The MVP must run automatically from GitHub issues while avoiding accidental executions.
The validation agent already acts as a quality gate: it applies `ready-for-dev` only when
an issue meets the acceptance criteria bar (score ≥ 70, no blockers). Requiring an
additional manual `ai-task` label added no safety value and created friction in the flow.

## Decision

Use a GitHub Actions workflow triggered on `issues.labeled`, and run the job only when
the triggered label is `ready-for-dev`.

The `ai-task` label has been removed from the pipeline entirely.

## Consequences

- ✅ Validated issues proceed to PR generation automatically — no manual step required.
- ✅ The validation agent remains the single gate controlling when generation runs.
- ✅ Triggering on `labeled` means the pipeline fires as soon as the validation workflow
  applies `ready-for-dev`, whether on first open or after an edit that raises the score.
- ⚠️ Any issue that passes validation will trigger generation. Operators who want to
  suppress generation for a specific issue must prevent `ready-for-dev` from being applied
  (e.g. close the issue or manually remove the label after the fact).
