# edit-guardrails

## When to Apply

Any time you are modifying an existing file in `scripts/` or `prompts/`. These rules are hard constraints, not preferences. They were introduced in ADR-0009 after two specific incidents where an agent caused destructive rewrites.

## Expected Behavior

Before making any edit, verify all five guardrails:

1. **Never shrink test files.** If the target file is under `scripts/tests/`, count the existing `test(` calls. Your output must have at least as many. Add new tests; never remove or stub existing ones.

2. **Never mix module systems.** Files with `.mjs` extension are ESM — `import`/`export` only. `require()` is forbidden. Files with `.cjs` or that already use `require()` stay CJS. Do not convert between formats.

3. **Never change an exported function's signature.** Do not rename parameters, change parameter count or types, or change the return type of any exported function unless the task description explicitly names that function and its new signature.

4. **Never introduce undeclared packages.** Do not `import` or `require` any package that is not already present in the file's existing imports or in `package.json`. Check `package.json` before adding any new dependency.

5. **Limit edit scope to ≤ 30% of a file's lines.** If a fix or feature requires touching more than 30% of an existing file's lines, reduce scope to a targeted edit. Full rewrites are only acceptable for new files or when the task explicitly requests a rewrite.

After each edit, mentally re-check all five points before finalizing.

## Constraints

- Do not ask for permission to follow these rules — they are mandatory for all agents.
- Do not treat any review feedback as license to rewrite beyond its stated scope.
- A no-op patch is safer than a guardrail violation.

## References

- `AGENTS.md` — "Hard Guardrails" section
- `prompts/auto-fix-system.md` — hard-guardrail instructions injected into auto-fix LLM
- `prompts/generation-system.md` — same guardrails injected into code-gen LLM
- `docs/adr/0009-llm-agent-guardrails.md` — root cause analysis and rationale
