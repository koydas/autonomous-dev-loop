# ADR-0008: Smoke Tests for Cross-Module Integration

- **Date:** 2026-04-30
- **Status:** Accepted

## Context

The repository already had 17 unit test files covering individual modules in isolation. Each module is tested with mocked or inline dependencies, so a change to a real file (a config key, a prompt placeholder, a YAML structure) can break the live pipeline without failing any unit test.

Three categories of gap were identified:

1. **Config file integrity** — `models.yaml` and `labels.yaml` are parsed at import time by `config.mjs`. No test verified that the YAML files themselves had all keys required by the production code paths.
2. **Prompt placeholder contracts** — `prompts/*.md` templates are loaded at runtime and interpolated by `interpolatePrompt()`. Unit tests for `prompts.mjs` verified the interpolation function, but not that a given template file still contains the placeholders the caller passes in.
3. **Pipeline wiring** — unit tests mock at the module boundary. A mis-wired call (wrong argument name, wrong return field consumed) is only caught when the full pipeline runs. No test exercised two or more modules together with real config and prompt files.

## Decision

Add a dedicated smoke test file (`scripts/tests/smoke.test.mjs`) that exercises complete pipelines using real config files and real prompt templates, with the LLM mocked at the network boundary.

Six groups of tests (20 total):

| Group | Real artefacts used |
|-------|---------------------|
| Config files | `config/models.yaml`, `config/labels.yaml` |
| Prompt files | All 8 files in `prompts/` |
| Validation pipeline | `validation-user.md` + `issue_validator.mjs` + `output_writer.mjs` |
| Generation pipeline | `generation-user.md` + `output_writer.mjs` + real temp files |
| `buildDeterministicPrompt` | `generation-user.md` |
| `loadLLMConfig` | `config/models.yaml` (temperature, maxTokens per stage) |

The tests live in the same directory as unit tests and run under the same `node --test scripts/tests/*.test.mjs` command, so no workflow change is required.

## Alternatives Considered

**Expand unit tests to cover config files and prompts** — rejected. Unit tests for individual functions are the wrong place to assert cross-cutting invariants like "all placeholders are present" or "all YAML keys exist". Mixing them creates cognitive overhead when reading a test failure.

**A separate CI job for smoke tests** — rejected for MVP scope. The suite runs in well under 10 seconds; a separate job adds latency and infra complexity with no benefit at this scale.

**True end-to-end tests with live LLM calls** — rejected. They require real API keys in CI, introduce non-determinism and latency, and are expensive. Mocking the LLM at the network boundary achieves the same structural coverage.

## Consequences

- ✅ Renaming a prompt placeholder or removing a YAML key now immediately fails a smoke test.
- ✅ Pipeline wiring bugs (wrong field name passed between modules) are caught without a live LLM call.
- ✅ No new tooling or CI changes required — smoke tests are picked up by the existing glob.
- ⚠️ Smoke tests depend on real files in `config/` and `prompts/`. Changes to those files must keep the tests green, which is the intended constraint.
