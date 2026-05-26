# Documentation Gap Analysis (including ADRs)

Date: 2026-05-25 (revalidated; originally 2026-04-29)

## Scope reviewed

- Product/process docs: `docs/mvp.md`, `docs/code-generation.md`, `docs/testing.md`
- ADR index and records: `docs/adr/README.md`, `docs/adr/0001` → `0012`
- Related implementation for traceability: workflow files under `.github/workflows/` and scripts under `scripts/`

## Status legend

- **Closed**: addressed in current docs/ADRs.
- **Open**: still recommended follow-up.

## Gap status (revalidated 2026-05-25)

### 1) ADR coverage gap for provider strategy evolution — **Closed**

**Revalidation**
`docs/code-generation.md` documents provider selection, defaults, and a per-workflow matrix for required/optional variables and fallback behavior. ADR-0002 title in the index was corrected (Groq default, Anthropic optional).

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
Documentation drift risk increases as workflows evolve. This analysis itself was 26 days out of date before the 2026-05-25 revalidation.

**Recommendation**
Add a short documentation governance section (or `CONTRIBUTING.md` subsection) specifying minimum update set for behavior changes: when to create a new ADR vs. amend an existing one, and who is responsible for keeping this gap analysis current.

---

### 5) ADR index was out of sync — **Closed**

**Gap (identified 2026-05-25)**
ADR README listed only 8 records; ADR-0009 (`0009-llm-agent-guardrails.md`, 2026-05-03) existed but was not indexed. ADR-0002 and ADR-0003 titles were also incorrect.

**Disposition**
Fixed: ADR-0009 added to index; ADR-0002 title corrected to "Groq default, Anthropic optional"; ADR-0003 title corrected to "up to 6 generated files".

---

### 6) Missing ADRs for May 2026 architectural features — **Closed**

**Gap (identified 2026-05-25)**
Six features shipped between 2026-05-01 and 2026-05-25 without architecture records:

| Feature | Commit | ADR created |
|---|---|---|
| Error taxonomy (TRANSIENT/PERMANENT/UNKNOWN) | `aadbc31` (2026-05-01) | ADR-0010 |
| Bounded retry with jitter | `349cbd3` (2026-05-01) | ADR-0010 |
| Checkpoint-resume (state persistence) | `ec14b22` (2026-05-25) | ADR-0011 |
| Coverage enforcement delegated to CI | `0704f38` (2026-05-25) | ADR-0012 |
| Idempotence for labels/comments/outputs | `d341b45` (2026-05-04) | — (implementation detail, no ADR needed) |
| Structured logs & health metrics | `11d4d2c` (2026-05-06) | — (implementation detail, no ADR needed) |

**Disposition**
ADR-0010, ADR-0011, and ADR-0012 created. Idempotence and structured logging do not introduce architectural trade-offs warranting a separate ADR.

## ADR-specific observations

- ADR index is present and up to date through `0012`.
- Records are focused and coherent.
- No superseded/deprecated ADR markers are currently needed, but a status field convention (`Accepted`, `Superseded`, `Deprecated`) would help future maintenance.

## Suggested next actions

1. Add documentation governance rules in `CONTRIBUTING.md` for when to update docs/ADR/changelog together (Gap #4 — still open).
2. Consider automating the "ADR check" in CI: a script that verifies every file in `docs/adr/` is listed in `docs/adr/README.md`.
