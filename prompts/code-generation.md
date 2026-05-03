# Code Generation Prompts

## Hard Guardrails Enforcement

When applying changes to code files:

- **Test files**: preserve all existing test cases; only add new tests or modify explicitly requested cases
- **Module format**: maintain original module system (`.mjs` files use ESM, others retain their format)
- **Function signatures**: never change exported function names, parameter types, or return types unless explicitly requested
- **Dependencies**: only use packages already present in `package.json` or existing imports
- **File rewrites**: avoid full rewrites; make targeted edits when changes affect <30% of a file's content

These rules apply to all auto-fix cycles and code generation workflows. See [ADR-0009](docs/adr/0009-llm-agent-guardrails.md) for implementation context.