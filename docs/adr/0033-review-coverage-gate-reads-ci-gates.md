# ADR-0033: Review coverage gate (c) reads the CI coverage gates; ungated files are judged on their tests

- **Date:** 2026-10-12
- **Status:** Accepted
- **Supersedes:** [ADR-0012](./0012-coverage-enforcement-delegation-to-ci.md)

## Context

ADR-0012 split coverage enforcement in two: CI (c8) for `scripts/lib/checkpoint.mjs`, the reviewer for everything else. Gate (c) of `prompts/pr-review-system.md` told the reviewer that CI covered only `checkpoint.mjs` and to report HIGH for any other changed automation logic whose diff did not add or maintain an explicit coverage policy. ADR-0012 rejected removing gate (c) because "reviewer awareness of coverage gaps remains valuable", and planned to update the prompt once c8 covered more files.

Since then, `test.yml` has gained a `c8 --check-coverage` step (80% lines, branches, functions, statements) for 17 files, and the prompt was never updated. Every PR that changed one of the 16 other gated modules got a false HIGH "missing coverage policy" and a REQUEST_CHANGES verdict. #184 got it twice (`e26e65c`, `dd4d4a2`); each time the PR was labelled `changes-requested` and `needs-human`, and an auto-fix attempt ran with nothing to fix.

The ADR-0012 rule also asks for something no diff can supply: a statement of "coverage policy" for an ungated module. Diffs met it with prose the reviewer could not verify, or got a HIGH for leaving it out. `AGENTS.md` § Test Coverage Policy already defines what coverage the reviewer checks: the required test paths of each module, i.e. tests, which gate (a) judges.

## Decision

Gate (c) states what CI enforces and asks the reviewer only what a diff can show:

1. **The list.** The prompt lists every file that has a `c8 --check-coverage` step in `test.yml`. A changed file on the list satisfies gate (c), even though `test.yml` is not in the diff.
2. **Severity.**
   - **HIGH** only when the diff removes one of those steps or lowers its threshold below 80%.
   - **MEDIUM** when the diff adds a `scripts/lib/*.mjs` module without a matching step.
   - **No gate (c) finding** for any other automation file (an existing ungated module, an entrypoint, a workflow, a prompt). Its tests are judged under gate (a), including the required paths of `AGENTS.md` § Test Coverage Policy.
3. **No drift.** `workflow_gates.test.mjs` fails when the prompt's list and the `--include` entries of `test.yml` differ. Adding or removing a c8 gate updates the prompt in the same PR.

This reverses ADR-0012's "reviewer policy for the rest": for an existing ungated file, gate (c) no longer raises anything.

## Alternatives Considered

- **Update the list, keep HIGH for ungated files** (ADR-0012's planned follow-up). Fixes the false HIGH on gated modules. But every change to one of the many ungated entrypoints and modules would still get a HIGH for a "coverage policy" that no diff can show, and the verdict would still block on prose. Rejected.
- **Inject the list from `test.yml` at runtime** (`coverage_checker.mjs` → `review_prompt.mjs`). No hardcoded list. It changes an exported shape and the recorded review prompts the eval replay depends on, and costs the same prompt tokens. Rejected for the drift test.
- **Extend c8 to the whole `scripts/` tree** (ADR-0012's deferred option). Would make gate (c) moot, but needs a baseline for modules far under 80% and fails CI until they reach it. Still deferred; each module joins the gate when its tests reach 80%.
- **Remove gate (c) entirely.** Loses the HIGH on a removed or lowered CI gate and the MEDIUM on a new ungated module. Rejected.

## Consequences

- ✅ No false HIGH on a gated module; no REQUEST_CHANGES, `needs-human` or empty auto-fix attempt for it.
- ✅ The prompt cannot go stale against `test.yml` again without failing CI.
- ✅ Removing or weakening a CI coverage gate still blocks the review (HIGH).
- ⚠️ **Looser for ungated files.** A change to an existing ungated module that reduces its coverage is caught only if gate (a) sees missing or weakened tests. ADR-0012 asked the reviewer for a coverage statement there; this ADR does not.
- ⚠️ The longer gate (c) line (258 → 1391 characters, ≈ +280 estimated tokens) counts against `review_max_input_tokens` (6300): when `pr_review.mjs` truncates, the visible diff is ≈ 1.1k characters shorter. The `review` eval suite sends it on every call (≈ +19k estimated tokens per 3-repeat run; the system prompt is the cached prefix Groq does not count against its rate limits).
- ⚠️ `prompts/generation-user.md` still asks the generator to keep or raise "minimum unit test coverage expectations" for `scripts/`, `prompts/` and `.github/workflows/`: the generator may produce coverage statements the reviewer no longer asks for. Follow-up.
