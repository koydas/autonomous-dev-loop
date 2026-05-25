# ADR-0012: Coverage enforcement delegated to CI, not the reviewer agent

- **Date:** 2026-05-25
- **Status:** Accepted

## Context

The PR reviewer agent (`scripts/pr_review.mjs`) was responsible for two separate concerns:

1. **Reviewing code quality** — correctness, style, architecture.
2. **Enforcing coverage gates** — checking whether unit test coverage meets a minimum threshold and requesting changes if it does not.

This conflation caused two problems:

- The reviewer parsed coverage signals from the raw diff text and inferred a minimum percentage. This heuristic was fragile: it missed cases where coverage was reported in CI artifacts rather than in the diff, and it triggered false "changes requested" reviews when coverage was fine.
- Coverage enforcement is fundamentally a machine-checkable binary gate (pass/fail), not a qualitative review concern. Mixing them made reviewer prompts longer and harder to tune.

## Decision

Remove coverage enforcement from the reviewer agent. Coverage is now enforced exclusively by the CI workflow (`test.yml`):

- `test.yml` runs `node --experimental-vm-modules node_modules/.bin/jest --coverage` and fails the job if coverage drops below the configured threshold.
- `scripts/lib/coverage_checker.mjs` is retained but its output (`buildAutomationGateContext`) is no longer injected into the reviewer's LLM prompt. The module remains available for diagnostic tooling.
- The reviewer agent's system prompt no longer contains coverage-related instructions.

The PR merge gate blocks on CI status checks, so a coverage regression cannot be merged even if the reviewer agent approves.

## Alternatives Considered

**Keep coverage in the reviewer but fix the heuristic** — would require parsing CI artifact URLs and making an additional API call per review. Adds latency and complexity for a check that CI already owns. Rejected.

**Add a separate coverage-check script called before the reviewer** — adds a step but still mixes the concern into the automation pipeline. CI is the canonical owner of build health. Rejected.

## Consequences

- ✅ Reviewer agent focuses solely on code quality; prompts are shorter and outputs are more targeted.
- ✅ Coverage gate is authoritative (actual test run) rather than heuristic (diff-text parsing).
- ✅ No new infrastructure needed — CI already ran tests; adding `--coverage` and a threshold is a one-line change.
- ⚠️ Coverage failures now block the merge gate rather than appearing as reviewer comments. Teams that relied on the reviewer comment for coverage feedback will need to look at CI logs instead.
