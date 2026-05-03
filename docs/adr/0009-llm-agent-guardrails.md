# ADR-0009: LLM Agent Guardrails for Auto-Fix and Code Generation

- **Date:** 2026-05-03
- **Status:** Accepted

## Context

The autonomous loop's auto-fix and code generation agents have demonstrated a failure mode where they make structurally destructive changes in response to review feedback or issue instructions, even when the feedback targets only a small, specific problem.

Two concrete incidents drove this decision:

1. **Auto-fix attempt 1 (PR #122):** The agent replaced a 690-line test suite (`scripts/tests/pr_review.test.mjs`) with an 18-line stub using Jest-style `describe`/`it` syntax. Node's built-in test runner does not support `describe`/`it`, so all 26 existing tests were silently dropped and the replacement failed immediately.

2. **Auto-fix attempt 3 (PR #122):** The agent rewrote `scripts/lib/coverage_checker.mjs` — an ESM module — introducing `require('nyc')` (CommonJS), changing the exported function's signature from `buildAutomationGateContext(rawDiffText)` to `buildAutomationGateContext({ prBody, coverageReport })`, and making it async. Every caller broke.

The existing system prompts contained instructions like "do not rewrite from scratch" and "fix only the specific issues described", but these were not strong enough to prevent the agents from over-generalising the feedback into a full rewrite.

## Decision

Add a **HARD GUARDRAILS** section to both `prompts/auto-fix-system.md` and `prompts/generation-system.md`. The guardrails are framed as absolute prohibitions (not advice) so the LLM treats them as inviolable constraints rather than soft preferences.

The five guardrails address the exact failure modes observed:

| Guardrail | Failure mode addressed |
|---|---|
| Never replace a test file with fewer tests than the original | Auto-fix attempt 1: 690-line suite replaced by 18-line stub |
| `.mjs` files are always ESM — `require()` is forbidden | Auto-fix attempt 3: CommonJS `require('nyc')` in ESM module |
| Never change an exported function's signature unless explicitly flagged | Auto-fix attempt 3: signature changed without review instruction |
| Never introduce external packages not already imported | Auto-fix attempt 3: `nyc` introduced without being in `package.json` |
| Never rewrite >30% of a file's lines for a single finding | Both attempts: full rewrites instead of targeted edits |

The 30% threshold for the last rule is a heuristic: any fix touching more than 30% of an existing file's lines for a single review finding almost certainly extends beyond the scope of that finding.

## Alternatives Considered

**Stricter validation script that rejects patches pre-commit** — would catch some cases (e.g. line-count drop, `require()` in `.mjs`) but adds infra complexity and latency to every auto-fix run. The prompt guardrails are cheaper and address the root cause (agent over-generalisation) rather than just the symptom.

**Lower the auto-fix attempt limit from 3 to 1** — would reduce exposure but would also disable the intended correction loop for legitimate multi-step fixes.

**Human-in-the-loop approval before each auto-fix commit** — defeats the purpose of the autonomous loop for straightforward fixes.

## Consequences

- ✅ Prevents agents from silently dropping test coverage when fixing a test-related finding.
- ✅ Prevents module format corruption (ESM ↔ CJS) when fixing implementation files.
- ✅ Prevents API breakage from unsolicited signature changes.
- ✅ Prevents introduction of undeclared dependencies.
- ⚠️ An agent that misidentifies a guardrail as blocking a legitimate fix may produce a no-op patch. This is acceptable: a no-op is safer than a breaking rewrite and will surface as a test failure rather than a silent regression.
- ⚠️ The 30% threshold is a heuristic and may need tuning if legitimate large-scope fixes are needed in future.
