# ADR-0012: Scoped coverage enforcement — CI for checkpoint, reviewer policy for the rest

- **Date:** 2026-05-25
- **Status:** Accepted

## Context

The PR reviewer agent's system prompt contained a broad gate (c): "if the diff changes automation logic but does not add/maintain an explicit minimum unit-test coverage policy/check for that flow, report HIGH severity." This instruction was accurate in intent but misleading in practice because it implied CI enforced coverage uniformly across the codebase, when in fact only `scripts/lib/checkpoint.mjs` had a machine-enforced coverage check.

The old wording caused the reviewer to flag PRs for lacking "coverage enforcement" even when no CI mechanism existed to enforce it — producing review noise without a corresponding CI gate.

Separately, `scripts/pr_review.mjs` appends `buildAutomationGateContext(rawDiff)` to the LLM user prompt to inform the reviewer which automation-scope files changed and whether test/doc signals are present. This context injection is unchanged by this decision.

## Decision

Update gate (c) in `prompts/pr-review-system.md` to reflect the actual CI coverage landscape:

> CI enforces coverage only for `scripts/lib/checkpoint.mjs` via c8 in `test.yml`. For all other changed automation logic, if the diff does not add/maintain an explicit minimum unit-test coverage policy/check for that flow, report HIGH severity.

CI state at this commit:
- `test.yml` runs `node --test scripts/tests/*.test.mjs` for all tests (no coverage measurement).
- A separate c8 step covers **only** `scripts/lib/checkpoint.mjs` with an 80% line/branch/function/statement threshold.

The reviewer continues to:
- Inject `buildAutomationGateContext(rawDiff)` into the LLM user prompt (unchanged).
- Apply gates (a) and (b) for test and docs signals.
- Apply gate (c) — but now with accurate guidance: flag missing *explicit coverage policy* for non-checkpoint files, not missing CI enforcement (since CI does not provide it).

## Alternatives Considered

**Extend c8 coverage to the full `scripts/` tree** — would make the reviewer instruction accurate without changes to the prompt, and would provide machine enforcement. Deferred: requires setting a baseline threshold that accounts for existing coverage gaps without breaking CI on merge.

**Remove gate (c) entirely** — removes the noise but also removes any coverage signal from reviews. Rejected: reviewer awareness of coverage gaps remains valuable even without CI enforcement.

## Consequences

- ✅ Reviewer instruction matches CI reality; false HIGH findings for missing coverage CI stop occurring.
- ✅ `checkpoint.mjs` coverage is machine-enforced at ≥80%; no reviewer judgement required for that file.
- ✅ `buildAutomationGateContext` context injection is preserved; reviewers still receive automation-scope signals.
- ⚠️ For all files other than `checkpoint.mjs`, coverage remains a reviewer-opinion gate, not a hard CI block. A PR can be merged with reduced test coverage if the reviewer does not flag it.
- ⚠️ If c8 coverage is extended to the full `scripts/` tree in a future increment, gate (c) in the system prompt should be updated again to reflect the broader enforcement.
