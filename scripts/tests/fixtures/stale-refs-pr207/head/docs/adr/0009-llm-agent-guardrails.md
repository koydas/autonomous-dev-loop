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
