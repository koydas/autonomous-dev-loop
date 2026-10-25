---
name: edit-guardrails
description: "Use before editing any existing file in scripts/ or prompts/. Checklist for the five AGENTS.md hard guardrails (no test shrinkage, no ESM/CJS mixing, no exported-signature change, no undeclared dependency, edit scope under 30%)."
---

# edit-guardrails

## When to Apply

Any time you modify an existing file in `scripts/` or `prompts/`. The rules are in `AGENTS.md` → **Hard Guardrails** (hard constraints, from ADR-0009); this skill is how to check them.

## Expected Behavior

Before the edit, and again before finalizing:

1. **Tests**: in a file under `scripts/tests/`, count `test(` calls before and after; after >= before.
2. **Module system**: `.mjs` stays `import`/`export`; no `require()`. `.cjs` stays CJS.
3. **Signatures**: `git diff` shows no change to the name, parameters or return type of an exported function, unless the task names that function.
4. **Dependencies**: each new `import` resolves to the file's existing imports, `package.json` or a Node built-in.
5. **Scope**: changed lines <= 30% of the file (`git diff --stat`). Above that, reduce to a targeted edit.

## Constraints

- Do not ask permission to follow these rules.
- Review feedback is not license to rewrite beyond its stated scope.
- A no-op patch is safer than a guardrail violation.

## References

- `AGENTS.md` — "Hard Guardrails"
- `scripts/lib/static_verifier.mjs` — what the pipeline enforces in code on generation and auto-fix
- `prompts/auto-fix-system.md`, `prompts/generation-system.md` — the same rules for the pipeline LLM; change them together with `AGENTS.md`
- `docs/adr/0009-llm-agent-guardrails.md` — incidents and rationale
