### Fixed
- Test-count guardrails count **active** cases (issue #339, ADR-0029 amendment): a case turned `test.skip(` / `test.todo(`, or given a truthy `skip` / `todo` option, is a `test_count_drop` in the auto-fix / generation write guard and a High finding in the review (RV-03, ADR-0060), with a reason naming it skipped / todo. A case already inactive and kept counts for nothing; `test.only` is active.

### Added
- Guardrail rule `assertion_count_drop`: a test case whose title is kept may not lose `assert(` / `assert.<name>(` / `t.assert.<name>(` calls (masked code: commented-out or quoted assertions do not count). Rejects the patch on generation and auto-fix (no waiver there), blocks approval in the review unless the PR names the case; lesson `rule:assertion_count_drop`. Not detected: an expected value changed at an equal assertion count.
- Gated `review` eval case `guardrail-test-turned-skip` (`source: "issue #339"`); review floor 34 → 37.
