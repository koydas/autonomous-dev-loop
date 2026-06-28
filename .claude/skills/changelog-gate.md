# changelog-gate

## When to Apply

Any PR you open or push to that touches **either** of these file categories:

- `scripts/*.mjs` — top-level entrypoint scripts (NOT `scripts/lib/*.mjs` or `scripts/tests/*.mjs`)
- `docs/adr/NNNN-*.md` — ADR files (four-digit prefix, under `docs/adr/` only)

CI workflow `changelog-check.yml` enforces this gate and will fail the PR if the requirement is not met.

## Expected Behavior

1. Confirm whether any changed file matches one of the two trigger patterns above. If neither matches, skip this skill — no changelog update is required.

2. Open `CHANGELOG.md` and locate the `## [Unreleased]` section.

3. Add at least one bullet line (prefixed `- ` or `* `) under `## [Unreleased]` describing the behavior change. Use [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) subsections (`### Added`, `### Changed`, `### Fixed`, `### Removed`) as appropriate.

4. Include the relevant ADR number or PR reference in the bullet if available (e.g., `(ADR-0018)` or `(#42)`).

5. Commit the `CHANGELOG.md` change in the same commit or PR as the triggering file change.

**Exact trigger rules (from `scripts/lib/changelog_checker.mjs`):**

- Entrypoint regex: `/^scripts\/[^/]+\.mjs$/` — matches `scripts/foo.mjs` but NOT `scripts/lib/foo.mjs` or `scripts/tests/foo.mjs`
- ADR regex: `/^docs\/adr\/\d{4}-[^/]+\.md$/` — matches `docs/adr/0019-my-decision.md`

## Constraints

- Do not modify `scripts/lib/` or `scripts/tests/` files and consider yourself exempt — those files are not trigger files.
- Do not add a generic placeholder bullet like "- Updated something". The entry must describe the observable behavior change.
- PRs that add a new ADR file must themselves include a changelog entry — this is intentional and self-referential.

## References

- `CHANGELOG.md` — target file; `## [Unreleased]` section is the required insertion point
- `scripts/check_changelog.mjs` — CI entrypoint that runs the check
- `scripts/lib/changelog_checker.mjs` — pure library with the trigger regexes and entry detection logic
- `.github/workflows/changelog-check.yml` — CI gate workflow
- `docs/adr/0016-changelog-ci-gate.md` — design rationale
- `CONTRIBUTING.md` — "Changelog Policy" section
