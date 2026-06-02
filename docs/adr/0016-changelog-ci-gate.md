# ADR-0016: Changelog CI gate for entrypoint scripts and ADR files

- **Date:** 2026-06-01
- **Status:** Accepted

## Context

As the project's automated loop shipped new features (prompt caching, JSON parsing
improvements, metrics), `CHANGELOG.md` fell behind. Post-hoc ADR syncs were required
(see commit `0aab9d3`) to document decisions that had already been merged. The root
cause was that there was no machine-enforced rule requiring authors to update the
changelog when merging automation changes.

The two categories of change most likely to go undocumented are:
1. **Entrypoint scripts** — `scripts/*.mjs` (top-level only; `scripts/lib/` contains
   library modules documented via the entrypoints that call them).
2. **ADR files** — `docs/adr/NNNN-*.md` (architecture decisions should be reflected
   in the changelog when they are added or updated).

A manually enforced policy in `CONTRIBUTING.md` existed but was not reliably followed.

## Decision

Introduce a CI gate that fails any PR touching trigger files unless `CHANGELOG.md`
contains at least one added bullet (`- ` or `* ` prefix) under `## [Unreleased]`.

**Three components:**

**`scripts/lib/changelog_checker.mjs`** — pure library module, extracted for unit
testability. Exports:
- `ENTRYPOINT_RE` — `/^scripts\/[^/]+\.mjs$/` — matches `scripts/*.mjs` but not
  `scripts/lib/*.mjs` or `scripts/tests/*.mjs`.
- `ADR_RE` — `/^docs\/adr\/\d{4}-[^/]+\.md$/` — matches `docs/adr/NNNN-title.md`.
- `findTriggerFiles(changedFiles)` — filters the changed-file list to those matching
  either regex.
- `hasUnreleasedEntry(diff, changelogContent)` — walks the diff hunk-by-hunk, tracking
  new-file line numbers. Returns `true` if any added line (`+` prefix) falls within the
  `## [Unreleased]` section and matches `/^[-*] /` (bullet prefix). Uses
  `changelogContent` (the post-change file) to locate section boundaries, so the check
  works even when the `## [Unreleased]` heading itself is not in the diff hunk.

**`scripts/check_changelog.mjs`** — entrypoint invoked by CI. Computes changed files
via `git diff --name-only origin/${BASE_REF}...HEAD`, calls `findTriggerFiles`, skips
with exit 0 if no trigger files changed, and calls `hasUnreleasedEntry` on the
CHANGELOG.md diff plus the current file content. Fails with a descriptive error message
and exit 1 if the check fails.

**`.github/workflows/changelog-check.yml`** — `pull_request` trigger (all PRs),
`fetch-depth: 0` required so `git diff origin/<base>...HEAD` can traverse history,
runs `node scripts/check_changelog.mjs` with `BASE_REF: ${{ github.base_ref }}`.

**Trigger scope:** `scripts/*.mjs` (top-level entrypoints) OR `docs/adr/NNNN-*.md`.
`scripts/lib/` and `scripts/tests/` are intentionally excluded: library and test
changes are captured through the entrypoints that surface them.

**Gate is skipped** (exit 0) when no trigger files are in the diff. PRs that touch
only `scripts/lib/`, tests, workflows, prompts, or documentation outside the ADR
directory do not require a changelog entry.

## Alternatives Considered

**Enforce via pre-commit hook** — runs locally on the author's machine rather than in
CI. Hooks can be bypassed with `--no-verify` and are not installed automatically for
new contributors. Rejected in favour of a CI gate that cannot be skipped.

**Require changelog updates for all changed files** — would mandate entries for
workflow YAML tweaks, test additions, and prompt updates that have no user-visible
behaviour change. Creates noise and reduces changelog signal-to-noise ratio. Rejected
in favour of the narrower trigger scope.

**Pattern-match the entire `scripts/` tree (including `lib/` and `tests/`)** — would
force changelog entries for internal refactors and test additions that do not change
observable pipeline behaviour. Rejected; `scripts/*.mjs` entrypoints are the correct
boundary because they represent the externally-visible surface of the automation.

**Require changelog entries per-commit via commit-message linting** — adds toolchain
complexity (commitlint or similar) and enforces at commit time rather than PR time,
blocking contributors on every intermediate commit. Rejected for MVP scope.

## Consequences

- ✅ Any PR that ships or documents a feature (entrypoint change or new ADR) is blocked
  until the changelog is updated — no more post-hoc sync commits.
- ✅ The gate is skipped for non-trigger files, keeping it low-friction for internal
  changes (test fixes, workflow tuning, prompt edits).
- ✅ `changelog_checker.mjs` is a pure module with no I/O; it is fully unit-tested
  without mocking.
- ✅ `fetch-depth: 0` in checkout enables accurate `git diff origin/<base>...HEAD`
  computation in all PR scenarios, including forks.
- ⚠️ ADR-only PRs (like the one adding this ADR) must themselves include a
  CHANGELOG.md entry — a self-referential requirement that is intentional: ADR
  additions are notable enough to log.
- ⚠️ `scripts/lib/` changes are not gated. A library module that materially changes
  behaviour without touching an entrypoint script will slip through without a changelog
  entry. This is the accepted trade-off for keeping the trigger scope narrow.
