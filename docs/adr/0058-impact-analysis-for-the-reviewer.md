# ADR-0058: Impact analysis: the reviewer may use existing code outside the diff as evidence

- **Date:** 2026-10-25
- **Status:** Accepted

## Context

The review prompt rule "review only what is in the provided diff" kept findings grounded, but it made a whole class of defects invisible: a changed or removed export whose callers, outside the diff, were not updated. Codex found such defects after the internal review approved them (RV-01 measures this per defect; `needs: context`). The auto-fixer edits only the files it is shown ([ADR-0009](./0009-llm-agent-guardrails.md)), so evidence from outside the diff must not turn into a fix outside it. The PR tree is untrusted ([ADR-0023](./0023-trusted-pipeline-execution.md)), and on Groq every added token comes out of the diff ([ADR-0028](./0028-one-review-per-head-sha.md)).

## Decision

1. **A deterministic block, not a tool loop.** `scripts/lib/impact_context.mjs` finds the exports whose declaration the diff edits, adds or removes (an edited body or a hunk-header context line does not count), then searches the PR tree, through the reader already used by the stale-reference and related-ADR searches, for the references outside the diff and for the tests of the changed modules. No LLM, no execution, no new dependency. Static text search: a hit is a candidate, not proof.
2. **Data, bounded.** The result is a fenced `## Impact analysis` block labelled as data, snippets sanitized and clipped at the prompt boundary, with fixed bounds (symbols, references per symbol, tests, files and characters scanned). Symlinks and files over 1 MiB are never read.
3. **One exception to diff-only.** The system prompt allows a finding backed by a caller in this block. The finding still cites the changed export in the diff, names the caller's `path:line` in its root cause, and its fix is on the diff side (keep the contract or update the caller in the same change). A caller that neither the diff nor the block shows is still not a defect.
4. **First to give way after the related ADRs.** Order of loss under budget: related ADRs, then the impact block, then the PR body and the diff. The block is 8,000 characters without a token budget, 1,200 with one.
5. **Observable, never a verdict input.** `review.impact_context` carries counts only; `review.impact_error` is sanitized; a search failure runs the review without the block.
6. **Measured live, not by the replay.** The replay answers are recorded, so the prompt change is invisible to it. The `review` suite gets a `known-gap` case with `input.impact`; the tag is removed after a live baseline ([ADR-0031](./0031-eval-gates-are-a-ratchet.md)).

## Alternatives Considered

- **Let the reviewer call tools (grep, read file).** Non-deterministic cost, a new execution surface on an untrusted tree, and no budget control on Groq. Rejected for now; revisit with RV-07 (execution-based reproduction).
- **Send whole caller files.** Cost scales with the repository, not the change. Rejected; snippets with `path:line` are enough to cite.
- **Static call graph / AST.** Better precision for JS, none for the other languages the target repositories use, and a dependency or a parser to maintain. Rejected; text search over exports, with known false positives (shadowed names, comments) stated in the block as candidates.
- **Keep diff-only and rely on the external reviewer.** The measured status quo: the defect class is found a round later, at the cost of a Codex cycle.

## Consequences

- ✅ The reviewer can justify "the callers are not updated" with a line, instead of guessing.
- ✅ Evidence outside the diff cannot widen the auto-fix scope: the fix rule is unchanged.
- ⚠️ Text search over-reports (same name in an unrelated module, a local variable); the block says candidates and caps the references, and the reviewer must read them.
- ⚠️ JS/TS only for the export detection; other languages get no block.
- ⚠️ +~500 bytes of system prompt on every review (ADR-0037 budget report applies).
