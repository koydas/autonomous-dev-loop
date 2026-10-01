# autonomous-dev-loop

[![Tests](https://github.com/koydas/autonomous-dev-loop/actions/workflows/test.yml/badge.svg)](https://github.com/koydas/autonomous-dev-loop/actions/workflows/test.yml)

**An AI dev loop that isn't allowed to wreck your repo.**

Label an issue → an LLM writes the PR → a second LLM reviews it against real test/lint results → an auto-fix agent addresses the findings → **you** merge. Runs entirely on GitHub Actions; Groq (`openai/gpt-oss-120b`) by default, Anthropic optional.

> Asked to fix one review finding, the auto-fix agent replaced a 690-line, 26-test suite with an 18-line stub that couldn't run ([ADR-0009](docs/adr/0009-llm-agent-guardrails.md)). Each boundary below links to the ADR recording the incident or exposure that forced it.

| | |
|---|---|
| **Dogfooded** | The loop wrote [13 merged PRs of its own](https://github.com/koydas/autonomous-dev-loop/pulls?q=is%3Apr+is%3Amerged+head%3Aai%2Fissue-) (11 features, 2 bug fixes — error taxonomy, bounded retry, checkpoint resume, provider fallback), each merged after human review. Then it was locked out of its own code: `scripts/`, `prompts/` and `config/` are now on the write denylist ([ADR-0021](docs/adr/0021-protected-write-path-denylist.md)). |
| **Tested** | 800+ tests on the built-in `node:test` runner, zero test dependencies, smoke tests wired to the real prompts and config |
| **Decided in writing** | [25 ADRs](docs/adr/README.md), each with context, rejected alternatives and trade-offs |

## Bounded autonomy, not "fully autonomous"

Prompts are advice; an LLM can ignore them. So the loop separates what it *asks* the model from what it *enforces* in code:

| Enforced in code / CI | Where |
|---|---|
| The review verdict is forced to `REQUEST_CHANGES` when any declared check (here: the test suite and a `node --check` syntax pass) fails on the PR head. A check that times out or crashes, or evidence that is missing or stale, is reported as unverified and does **not** block approval | [ADR-0024](docs/adr/0024-tool-evidence-for-pr-review.md) |
| PR code runs in a job holding **no secrets** (`contents: read`, no persisted credentials, credential-like env vars stripped) | [ADR-0024](docs/adr/0024-tool-evidence-for-pr-review.md) |
| Pipeline scripts, prompts and config always run from the **default branch** — a PR cannot rewrite the code that reviews it | [ADR-0023](docs/adr/0023-trusted-pipeline-execution.md) |
| Write denylist: the model cannot touch `.github/`, `scripts/`, `prompts/`, `config/`, lockfiles, `.npmrc`, or escape via symlinks | [ADR-0021](docs/adr/0021-protected-write-path-denylist.md) |
| Max 6 files per run, no absolute paths, no `..`, 16 000 chars per file | [ADR-0003](docs/adr/0003-safe-output-scope.md) |
| Max 3 auto-fix attempts, then escalation to a human; per-PR concurrency | [ADR-0006](docs/adr/0006-label-driven-auto-fix-trigger.md), [ADR-0020](docs/adr/0020-per-pr-workflow-concurrency.md) |
| Under-specified issues never reach generation (validation gate, `ready-for-dev` label) | [ADR-0001](docs/adr/0001-trigger-policy-and-label-gate.md) |
| Human merge — the loop never merges: no merge call exists in `scripts/` or the workflows | [`docs/mvp.md`](docs/mvp.md) (human review before merge), [`.github/workflows/`](.github/workflows/) |

| Asked of the model (prompt guardrails) | Where |
|---|---|
| Never shrink a test file, never mix ESM/CJS, never change an exported signature, never add an undeclared package, never rewrite > 30% of a file | [ADR-0009](docs/adr/0009-llm-agent-guardrails.md) |
| Named defect checklist in review (read-only property writes, unauthorized imports, non-persistent refs), disclosure when the diff was truncated | [docs/code-generation.md](docs/code-generation.md#review-and-auto-fix-guardrails) |

Moving more of the second table into the first is the open work — see the proposed [static verification backstop (ADR-0019)](docs/adr/0019-static-verification-backstop.md).

## How it works

```mermaid
graph LR
    A[Issue created] --> B[Validator]
    B -->|invalid| Z[needs-refinement — no PR]
    B -->|valid| C[label: ready-for-dev]
    C --> D[Code Generation]
    D --> E[PR opened 
