# ADR-0061: A finding about code outside the diff must quote it, and the quote is checked in code

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

"Review only what is in the diff" ([ADR-0009](./0009-llm-agent-guardrails.md), the first rule of `pr-review-system.md`) kept findings grounded, and it hid a defect class: a caller, a test or a document the diff does not touch. [ADR-0058](./0058-impact-analysis-for-the-reviewer.md) (RV-02) gave the reviewer the callers and tests of the exports a diff changes, with one exception to the rule. That exception is only worth something if a finding built on outside code can be trusted, and nothing checked it: the model could name a line nobody showed it. The auto-fixer, for its part, edits only what it is shown ([ADR-0029](./0029-autofix-deterministic-write-guard.md)), so an unproven claim about outside code starts a loop that cannot succeed.

## Decision

1. **Relax the rule, with proof.** A finding may concern code or text outside the diff when it carries `Evidence: path:line "exact text"`, copied from the Impact analysis block. The prompt says what the tool does with it.
2. **The proof is checked in code, not by the model.** `finding_evidence.mjs` reads the quotes and looks them up in the PR tree through the safe reader ([ADR-0023](./0023-trusted-pipeline-execution.md)): the file must be a regular file inside the tree and the quote (6+ characters, whitespace and quote marks ignored) must be written within 5 lines of the line given. The model may reason about what a quote means; it may not invent one. No LLM, no execution.
3. **What "outside" means.** The finding cites files and none is in the diff (renames count both sides). A finding with no file, or a diff whose files cannot be listed, is judged as before.
4. **Consequence for the decision, and only that.** A REQUEST_CHANGES whose blocking (High or Medium) findings are **all** outside and unproven becomes WITHHELD (`unproven_findings`): a human decides, auto-fix does not run, like a review whose findings cite only cut code ([ADR-0038](./0038-withhold-approval-on-unreviewed-code.md)). A proven or in-the-diff blocking finding, a failing check ([ADR-0024](./0024-tool-evidence-for-pr-review.md)) or a guardrail finding ([ADR-0060](./0060-guardrail-findings-in-the-review.md)) keeps its REQUEST_CHANGES; an approval is never changed. The verification statuses that would let every finding decide the verdict are RV-05, not this ADR.
5. **Visible and measured.** The comment gets an `### 🔎 Evidence Check` section; `review.finding_evidence` carries counts only. The `review` eval suite assesses recorded answers the same way, with the lines of the case's Impact analysis as its only files.

## Alternatives Considered

- **Keep "diff only".** Safe, and it leaves the class of defects outside the diff to the external reviewer.
- **Relax it without proof.** Findings about code nobody showed the model are the hallucinations the rule prevented; with auto-fix attached, each one costs three attempts that cannot fix it.
- **Ask the model to verify its own quote.** The same model, the same blind spot. A string search is exact and free.
- **Downgrade an unproven finding to Low and approve.** Turns a claim the tool cannot judge into an approval. Withholding leaves the judgement to the person who merges.
- **Verify the claim by running something.** Execution-based reproduction is RV-07 and needs the isolated runner of [ADR-0052](./0052-isolated-grader-for-executable-evals.md).

## Consequences

- ✅ A finding about outside code is either backed by text a human can open at the line given, or it cannot block alone.
- ✅ No auto-fix loop on a claim about code the fixer is not shown.
- ⚠️ The quote proves that the text exists, not that the finding is right, and a PR can plant text for the model to quote. A verified outside finding is a lead; the human merge gate stays.
- ⚠️ Outside findings need an outside source: the Impact analysis lists callers and tests only, so a document contradicted by a change (PR #279) stays out of reach until documents are added to the context (RV-04b); `incident-docs-contradict-new-behavior` stays `known-gap`.
- ⚠️ A correct outside finding the model quotes badly is withheld rather than rejected: a human reads it.
