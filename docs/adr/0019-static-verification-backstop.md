# ADR-0019: Static verification backstop for generated code (proposal)

- **Date:** 2026-07-27
- **Status:** Proposed

## Context

ADR-0009 addressed LLM guardrail violations (test-suite deletion, module-format corruption, unauthorized dependencies, signature changes) entirely through prompt wording, and explicitly rejected adding a pre-commit validation script as an alternative: "adds infra complexity and latency to every auto-fix run. The prompt guardrails are cheaper and address the root cause."

A benchmark session run against a locally-hosted 7B coding model (`qwen2.5-coder:7b-instruct-q4_0`, used here as a stand-in for "a capable but not frontier-tier LLM") fed the exact production `generation-system.md`/`generation-user.md` prompts a synthetic issue requesting a React hook. The output:

1. Imported `AbortController` from a nonexistent `abort-controller` npm package — the same class of violation ADR-0009's "never introduce external packages" guardrail was written to prevent (that ADR's motivating incident was `require('nyc')` introduced without being in `package.json`).
2. Assigned to `AbortController.prototype.signal`, a getter-only accessor. Verified empirically in a real ES-module environment (Node's native ESM loader, matching browser strict-mode semantics): this throws `TypeError` and crashes the entire React component tree on first use.

Only the first of these violated an explicit guardrail already present in the prompt at benchmark time (`generation-system.md`'s HARD GUARDRAILS forbid introducing new external packages). The read-only-property assignment was not covered by any existing guardrail prose — it's a general code-correctness failure the review step should have caught on its own merits, not a case of the model ignoring an explicit instruction. (Companion PR #155 has since added an explicit self-check for this exact pattern, closing that specific gap at the prompt level — this ADR's static-verification proposal is an additional, tool-based backstop on top of that, not a substitute for it.) The generated diff was then run through the production `pr-review-system.md` prompt (same benchmark session) and returned `APPROVED`, `Issues Found: None` — the paired review step did not catch either defect, nor the complete absence of unit tests the issue had explicitly requested.

This reopens the question ADR-0009 settled by prompt-only means: **prompt wording is not a sufficient backstop by itself for at least some classes of defect, for at least some models this pipeline might run against.** Two of the observed defects are mechanically checkable by tools that already exist and require no LLM judgment call:
- An unauthorized import is a straightforward static comparison against `package.json` (see #157, which already gives the model a concrete allowlist — but a generation-time constraint on the *prompt* doesn't guarantee compliance, as shown here).
- A read-only property assignment on a well-known built-in (`AbortController.signal`, `Response.body`, etc.) is exactly the class of error a type checker (`tsc --noEmit`) is designed to catch, for any repo already using TypeScript with the DOM lib.

## Decision (proposed)

Add an optional, opt-in static verification step that runs immediately after `writeGeneratedFiles()` in the code-generation stage (and equivalently after auto-fix), before a PR is opened:

1. **Import allowlist check** (applies to any repo, no per-repo config needed beyond `package.json`): snapshot `package.json`'s dependency fields **before** calling the generation LLM (the same read already performed to build the "Allowed npm dependencies" context block, see #157). For each generated/modified JS/TS file, extract `import`/`require` specifiers and flag any bare (non-relative) specifier that is neither in that pre-generation snapshot nor in a small maintained list of language/runtime built-ins. Comparing against the pre-generation snapshot, not the post-write working tree, is load-bearing: since the model's own `changes` can include a rewritten `package.json` (up to 6 files per the existing HARD LIMIT), checking against the working-tree file after `writeGeneratedFiles()` would let the model add both the import and the corresponding manifest entry in the same patch and pass trivially, which defeats the check's purpose. This is a regex/AST-level check, not a full build — cheap, deterministic, language-aware only for JS/TS.
2. **Type-check pass** (opt-in per target repo, since not every repo this pipeline touches is TypeScript): if the target repo has a `tsconfig.json`, running `tsc --noEmit` isn't a drop-in solution — `tsc`'s CLI rejects combining `--project` with an explicit file list (error TS5042), so scoping to just the generated files isn't directly available, and running full project-mode `tsc` would fail on *any* pre-existing type error anywhere in the project, blocking every generated PR regardless of whether the generated files themselves are valid. A workable version needs one of: (a) a clean-baseline prerequisite (only enable this check for repos that already pass `tsc --noEmit` on `main`), (b) a baseline-error-count comparison (run `tsc --noEmit` before and after applying the generated changes, on the whole project, and fail only if the error count/set grows), or (c) a derived, isolated `tsconfig.json` (generated on the fly, `include`-scoped to just the changed files plus their transitive local imports) so project mode has a narrow enough surface. This needs to be resolved concretely in the implementation PR, not assumed away — treat "which of (a)/(b)/(c)" as an open implementation question this ADR does not settle.

Both checks are advisory-to-blocking: a failure prevents the PR from being opened (or triggers a re-generation attempt, mirroring the existing auto-fix retry loop), rather than being left for the AI reviewer to notice — this benchmark's finding is precisely that the reviewer cannot be relied upon to notice it reliably.

## Alternatives Considered

**Rely solely on sharper prompt wording** (see companion PRs #155/#156): cheaper, and does measurably help — but this ADR's own motivating data was gathered *against* prompts already containing explicit, unambiguous guardrail prose for exactly these two failure modes, and the model violated them anyway. Prompt sharpening is worth doing regardless (it may reduce the rate), but this benchmark is evidence it cannot be assumed sufficient on its own for every model this pipeline might use.

**Do nothing / accept the risk, matching ADR-0009's original latency/complexity tradeoff**: reasonable if the pipeline only ever targets frontier-tier hosted models (Groq/Anthropic, the current defaults per AGENTS.md) where this failure rate may be lower or unobserved. Worth noting this ADR's evidence comes from a local 7B model, not the pipeline's configured defaults — the proposal here is explicitly scoped as opt-in for exactly that reason, not a blanket requirement.

**Full CI build/test suite before PR open, for every generated change**: strictly more thorough but reintroduces the latency/complexity concern ADR-0009 weighed against, and requires per-repo build tooling knowledge this pipeline doesn't currently have. The import-allowlist and `tsc --noEmit` checks proposed here are a narrower, cheaper subset chosen specifically because they map to the two concrete defects observed and require no repo-specific build knowledge beyond "does a `tsconfig.json` exist."

## Consequences

- ✅ Catches the two defect classes this ADR is motivated by deterministically, without depending on either the generator or the reviewer LLM noticing them.
- ✅ Consistent with the existing "fail fast" principle in AGENTS.md — extends it from "external API errors" to "generated code that provably doesn't satisfy its own stated constraints."
- ⚠️ Reopens the exact tradeoff ADR-0009 already made a call on (latency/complexity vs. prompt-only enforcement) — this ADR does not overrule ADR-0009's guardrail prose, it proposes an additional layer on top, scoped narrowly enough that the original objection (general pre-commit validation script) doesn't fully apply.
- ⚠️ The `tsc --noEmit` check only fires for TypeScript repos with a `tsconfig.json`; it is not a general-purpose correctness gate and won't catch logic bugs outside its type-checkable surface (e.g. the race-condition class of bug also observed in the same benchmark session is not something a type checker catches).
- ⚠️ Requires deciding what happens on repeated failure (retry generation, same as auto-fix's existing bounded-retry pattern per ADR-0010, or surface to a human) — left for the implementation PR to resolve, not decided here.

## Related benchmark data

The full benchmark session (generation + review + targeted-prompt iteration, run against `qwen2.5-coder:7b-instruct-q4_0` outside this repo) is not preserved in this repository; this ADR summarizes only the two findings directly relevant to this repo's guardrail design.
