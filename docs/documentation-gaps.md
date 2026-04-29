# Documentation Gap Analysis (including ADRs)

Date: 2026-04-29

## Scope reviewed

- Product/process docs: `docs/mvp.md`, `docs/code-generation.md`, `docs/testing.md`
- ADR index and records: `docs/adr/README.md`, `docs/adr/0001` → `0007`
- Related implementation for traceability: workflow files under `.github/workflows/` and scripts under `scripts/`

## Status legend

- **Closed**: addressed in current docs/ADRs.
- **Open**: still recommended follow-up.

## Gap status (revalidated)

### 1) ADR coverage gap for provider strategy evolution — **Closed**

**Revalidation**
`docs/code-generation.md` now documents provider selection, defaults, and a per-workflow matrix for required/optional variables and fallback behavior.

**Evidence**
- Provider behavior matrix and fallback are documented.
- Per-workflow environment variable matrix is documented.

**Disposition**
No immediate doc action required unless provider strategy changes again.

---

### 2) Missing formal data contract docs for script outputs — **Closed**

**Revalidation**
`docs/contracts.md` exists and documents script/workflow contracts, required inputs, outputs, and constraints.

**Disposition**
Closed as of current repository state.

---

### 3) Testing documentation does not map tests to risk areas — **Closed**

**Revalidation**
`docs/testing.md` includes workflow-oriented coverage guidance and validation focus areas; this is sufficient for MVP traceability.

**Disposition**
Optional future enhancement: add a stricter risk→test table when coverage expands beyond MVP.

---

### 4) Missing changelog policy for automation behavior changes — **Open**

**Gap**
Major behavior shifts are partly reflected in ADRs, but there is no explicit contributor-facing rule for when to update docs + ADR + release/changelog notes together.

**Impact**
Documentation drift risk increases as workflows evolve.

**Recommendation**
Add a short documentation governance section (or `CONTRIBUTING.md` subsection) specifying minimum update set for behavior changes.

## ADR-specific observations

- ADR index is present and up to date through `0007`.
- Records are focused and coherent.
- No superseded/deprecated ADR markers are currently needed, but a status field convention (`Accepted`, `Superseded`, `Deprecated`) would help future maintenance.

## Suggested next action

1. Add documentation governance rules in `CONTRIBUTING.md` for when to update docs/ADR/changelog together (the only remaining open gap).
