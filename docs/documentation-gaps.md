# Documentation Gap Analysis (including ADRs)

Date: 2026-04-29

## Scope reviewed

- Product/process docs: `docs/mvp.md`, `docs/code-generation.md`, `docs/testing.md`
- ADR index and records: `docs/adr/README.md`, `docs/adr/0001` → `0007`
- Related implementation for traceability: workflow files under `.github/workflows/` and scripts under `scripts/`

## Detected gaps

### 1) ADR coverage gap for provider strategy evolution

**Gap**
ADRs capture Anthropic/Groq and model defaults, but current workflows mostly wire `GROQ_API_KEY`. The docs discuss dual-provider behavior at length, yet operationally this can look asymmetric.

**Impact**
Potential confusion about “supported vs wired-by-default” provider posture and what must be configured per workflow today.

**Recommendation**
Either:
1. Add/update ADR clarifying current provider posture per workflow stage; or
2. Narrow docs to match implemented posture until full parity exists.

Also add a matrix table by workflow: required env vars, optional vars, and fallback behavior.

---

### 2) Missing formal data contract docs for script outputs

**Gap**
Entrypoint scripts communicate via workflow outputs (e.g., `generated_paths`, `summary`, `fixed_paths`, `attempt_number`), but there is no explicit versioned contract documentation.

**Impact**
Refactors in scripts risk silently breaking workflow assumptions.

**Recommendation**
Add `docs/contracts.md` with per-script I/O contracts:
- Required env vars
- Output keys and semantics
- Exit-code meaning
- Failure modes

---

### 3) Testing documentation does not map tests to risk areas

**Gap**
`docs/testing.md` exists, but there is no traceability table linking test suites to workflow risks and critical user journeys.

**Impact**
Hard to assess coverage quality when changing automation logic.

**Recommendation**
Extend testing docs with a “risk→test mapping” table:
- Label parsing/config regression
- Output path safety
- Review comment upsert behavior
- Auto-fix attempt limit enforcement

---

### 4) Missing changelog policy for automation behavior changes

**Gap**
Major behavior shifts are partly reflected in ADRs, but there is no explicit contributor-facing rule for when to update docs + ADR + release/changelog notes together.

**Impact**
Documentation drift risk increases as workflows evolve.

**Recommendation**
Add a short documentation governance section (or `CONTRIBUTING.md` subsection) specifying minimum update set for behavior changes.

## ADR-specific observations

- ADR index is present and up to date through `0007`.
- Records are focused and coherent, but a few operational decisions remain undocumented (notably PR review trigger scope and provider stage parity).
- No superseded/deprecated ADR markers are currently needed, but a status field convention (`Accepted`, `Superseded`, `Deprecated`) would help future maintenance.

## Suggested next actions (priority order)

> ✅ Update as of 2026-04-29: the former top-priority action (ADR for PR review trigger scope) is completed via `docs/adr/0007-pr-review-trigger-strategy.md` and its addition to `docs/adr/README.md`.

1. Decide and document provider posture (full dual-provider parity vs staged support) in ADR + `docs/code-generation.md`.
2. Add `docs/contracts.md` defining script/workflow I/O contracts and failure semantics.
3. Extend `docs/testing.md` with a risk-to-test traceability matrix.
4. Add documentation governance rules in `CONTRIBUTING.md` for when to update docs/ADR/changelog together.
