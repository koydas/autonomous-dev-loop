# ADR Index

Architecture Decision Records (ADR) for the MVP Issue → AI → PR automation.

## Records

- [ADR-0001: Trigger policy and label gate](./0001-trigger-policy-and-label-gate.md)
- [ADR-0002: AI provider support (Groq default, Anthropic optional)](./0002-ai-provider-groq.md)
- [ADR-0003: Safe output scope (up to 6 generated files)](./0003-safe-output-scope.md)
- [ADR-0004: PR authentication token strategy](./0004-pr-authentication-token-strategy.md)
- [ADR-0005: Switch Groq default model to Qwen3 and per-stage temperature strategy](./0005-switch-groq-model-to-qwen3.md)
- [ADR-0006: Label-driven auto-fix trigger and re-pulse strategy](./0006-label-driven-auto-fix-trigger.md)
- [ADR-0007: PR review trigger strategy](./0007-pr-review-trigger-strategy.md)
- [ADR-0008: Smoke tests for cross-module integration](./0008-smoke-tests-for-cross-module-integration.md)
- [ADR-0009: LLM Agent guardrails for auto-fix and code generation](./0009-llm-agent-guardrails.md)
- [ADR-0010: Error taxonomy and bounded retry with jitter](./0010-error-taxonomy-and-retry.md)
- [ADR-0011: Checkpoint-resume for state persistence across Actions jobs](./0011-checkpoint-resume-state-persistence.md)
- [ADR-0012: Coverage enforcement delegated to CI](./0012-coverage-enforcement-delegation-to-ci.md)
- [ADR-0013: Metrics storage as append-only JSONL and same-run deduplication via GITHUB_RUN_ID](./0013-metrics-append-only-jsonl-and-deduplication.md)
- [ADR-0014: Anthropic prompt caching on system prompts](./0014-anthropic-prompt-caching.md)
- [ADR-0015: Three-tier JSON parsing with typed errors](./0015-three-tier-json-parsing.md)
- [ADR-0016: Changelog CI gate for entrypoint scripts and ADR files](./0016-changelog-ci-gate.md)
- [ADR-0017: Configurable per-stage token budget in `config/models.yaml`](./0017-configurable-token-budget.md)
- [ADR-0018: Structured observability — JSON events to stderr + per-run trace files](./0018-structured-observability.md)
- [ADR-0019: Static verification backstop for generated code (proposal)](./0019-static-verification-backstop.md)
