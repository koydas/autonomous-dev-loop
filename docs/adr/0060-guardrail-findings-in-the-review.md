# ADR-0060: Hard Guardrails are checked in code on the PR under review

- **Date:** 2026-10-25
- **Status:** Accepted

## Context

[ADR-0009](./0009-llm-agent-guardrails.md) and [ADR-0019](./0019-static-verification-backstop.md) enforce the AGENTS.md Hard Guardrails in code on what the pipeline generates (test cases, module format, exported signatures, imports, write guard). The reviewer of a PR relies on the model to notice the same defects, and does not: the review approved the removal of a test case (PR #276) that `countTestCalls` would have refused in an auto-fix patch. Codex found it a round later. A rule checkable by a regular expression should not depend on a sampled judgement.

## Decision

1. **Reuse the verifier, add no new rules.** `scripts/lib/guardrail_review.mjs` applies `findModuleSystemViolation`, `findSignatureViolations` and `findUnresolvedImports` to the files a PR changes (base at the merge base, head from the PR tree) and a test-case rule computed from the diff alone. Deterministic, no LLM, no execution; the PR tree is only parsed.
2. **A finding blocks approval.** An APPROVE or a WITHHELD becomes REQUEST_CHANGES, like a failing check ([ADR-0024](./0024-tool-evidence-for-pr-review.md)); the circuit breaker ([ADR-0050](./0050-circuit-breaker-review-loop.md)) sees `guardrail:<rule>:<path>` so a loop that cannot fix it escalates. The section opens the comment, where the auto-fixer reads first.
3. **Intent is stated, not guessed.** The pipeline rule says "unless the request explicitly targets it". For a PR the request is its title and body: a removed test is waived when its title is named, a changed or removed function when its name is. No other waiver; a wrong finding is a bug of the module, fixed with the diff as a test.
4. **Precision over coverage.** Cases are counted on the whole base and head files with comments and string/template contents masked (`static_verifier.mjs` `maskSource`), at statement level only (an assertion calling `re.test()` or a `test(` inside a fixture is not a case); a file that cannot be read, or past the cap, reports nothing and still counts as a possible destination of a moved case; an import target is a file when `lstat` finds one (no content is read), whatever the size; a directory is not. The lexer is heuristic (a regex literal holding a quote or a backtick can hide code), so a reason of the file rules and a lost test case are kept only when a raw reading of the text agrees: a hidden `require(`, export, import or test call, a parameter list cut short by a regex literal, or an import specifier invented by a lexer slip cannot become a blocking finding, at the price of missing a removal that a fixture masks. Without a tree (the eval suite) the diff's own lines stand in; a case moved to another file or renamed in place is not a loss, and each added case pays for at most one removal across the diff; deleted test files, `package.json` dependencies and the 30 % rewrite rule are out of scope. Bare package imports are judged only against a manifest found above the file; a `.js` specifier is satisfied by its `.ts` source. Run over the 47 `review` dataset cases the check flags two, both expected REQUEST_CHANGES.
5. **This repository only.** The rules are AGENTS.md's; a target repository ([ADR-0045](./0045-reusable-pipeline-workflows.md)) is not subject to them.
6. **Measured like the model.** The `review` suite runs the same check and scores its finding, so `incident-removed-test-case` is no longer `known-gap`: the decision it asserts does not depend on the model ([ADR-0031](./0031-eval-gates-are-a-ratchet.md): left the tag for `PINNED`, thresholds unchanged).

7. **A deadline, in a child process.** The checks parse untrusted PR text with regular expressions in the review's own process, where a try/catch cannot interrupt a backtracking pattern (`static_verifier.mjs` is quadratic on a file full of unclosed `export {`). `guardrail_runner.mjs` runs them in a child with a 60 s kill timeout; an overrun, a crash or a malformed answer skips the check with a warn event, like any other failure of it. A function whose module still re-exports it (`export { … } from`, `export *`, an export list) is not a removed export.

## Alternatives Considered

- **Tell the model about the rule in the prompt.** Already so (named defect checks); it is the status quo that missed #276.
- **Show the findings to the model and let it decide.** Costs prompt budget on Groq and keeps a deterministic defect at the mercy of the model's agreement.
- **Informational only, like stale references.** A deterministic defect that never changes the verdict reaches the human merge gate unflagged as often as before.
- **Block deleted test files and mass deletions too.** Legitimate removals of a module and its tests would be refused without a way to say so cheaply; revisit with data.

## Consequences

- ✅ The defect class behind a Codex round is closed at the first review, whatever the model says, and the auto-fixer is told exactly which file and rule.
- ✅ The verdict is reproducible: the same diff gives the same guardrail findings.
- ⚠️ A deliberate removal must be named in the PR description; a PR that forgets gets one REQUEST_CHANGES round.
- ⚠️ Text-level rules: a test declared by an unusual helper is not counted (symmetrically on both sides of the diff); JavaScript and TypeScript only.
- ⚠️ A rule change in `static_verifier.mjs` now also changes reviews, not only generation.
- ⚠️ The check parses untrusted text synchronously in `pr_review.mjs`, where a try/catch cannot interrupt a regex: every pattern it applies to PR lines has disjoint alternatives (linear time), pinned by a test on 5,000-character unclosed titles.
