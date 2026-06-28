---
description: Procedure for adding a new ADR — numbered file in docs/adr/, index update in README.md, mandatory CHANGELOG.md entry, and optional doc updates for behavior changes.
---

# new-adr

## When to Apply

When adding a new Architecture Decision Record (ADR) to document a significant design or technical decision in this repository.

## Expected Behavior

### Step 1 — Determine the next ADR number

Check the highest existing number in `docs/adr/` (e.g., `ls docs/adr/*.md | sort`) and increment by one. Use four digits zero-padded (e.g., `0019`).

### Step 2 — Create the ADR file

Create `docs/adr/<NNNN>-<kebab-case-title>.md` with this structure:

```markdown
# ADR-<NNNN>: <Title>

- **Date:** <YYYY-MM-DD>
- **Status:** Accepted

## Context

[What problem or situation prompted this decision?]

## Decision

[What was decided, and how does it work? Be specific about the implementation.]

## Alternatives Considered

[What other approaches were evaluated and why were they rejected?]

## Consequences

[What are the trade-offs? Use ✅ for benefits and ⚠️ for drawbacks/caveats.]
```

### Step 3 — Add to the ADR index

Open `docs/adr/README.md` and append a line to the `## Records` list:

```markdown
- [ADR-<NNNN>: <Title>](./<NNNN>-<kebab-case-title>.md)
```

### Step 4 — Update CHANGELOG.md

Because ADR files match the changelog-gate trigger (`docs/adr/NNNN-*.md`), you must add a bullet under `## [Unreleased]` in `CHANGELOG.md` describing the new decision. This is a CI requirement — the PR will fail without it.

### Step 5 — Update relevant docs (if applicable)

If the decision changes workflow behavior, trigger conditions, labels, or operator steps, also update `docs/code-generation.md` and/or `docs/runbook.md` in the same PR (per `AGENTS.md` Review Hygiene rules).

## Constraints

- Do not skip the `docs/adr/README.md` index update — omitting it leaves the ADR orphaned from the index.
- Do not skip the `CHANGELOG.md` update — the `changelog-check` CI gate will fail the PR.
- ADR numbers must be sequential with no gaps.
- Status must be `Accepted` (or `Proposed` if under discussion); do not use custom statuses.

## References

- `docs/adr/README.md` — ADR index to update
- `docs/adr/` — existing ADRs to reference for style and numbering
- `CHANGELOG.md` — must be updated (see `changelog-gate` skill)
- `AGENTS.md` — "Documentation Rules" and "Review Hygiene" sections
- `docs/adr/0016-changelog-ci-gate.md` — explains why ADRs trigger the changelog gate
