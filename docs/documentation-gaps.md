# Documentation Gap Analysis (including ADRs)

Date: 2026-04-29

## Scope reviewed

- Product/process docs: `docs/mvp.md`, `docs/code-generation.md`, `docs/testing.md`
- ADR index and records: `docs/adr/README.md`, `docs/adr/0001` → `0006`
- Related implementation for traceability: workflow files under `.github/workflows/` and scripts under `scripts/`

## Detected gaps

### 3) ADR coverage gap for review-trigger choice

**Gap**
There is no dedicated ADR documenting why PR review is triggered on `push` to all branches instead of narrower PR-centric triggers (`pull_request` synchronize/opened), including trade-offs and operational safeguards.

**Impact**
Future contributors may “optimize” trigger behavior without understanding rationale, potentially breaking current branch→PR resolution assumptions.

**Recommendation**
Create a new ADR (e.g., `0007`) capturing:
- Decision context
- Considered alternatives
- Chosen trigger and implications
- Guardrails for no-PR branches

---

### 4) ADR coverage gap for provider strategy evolution

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

### 5) Missing formal data contract docs for script outputs

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

### 6) Testing documentation does not map tests to risk areas

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

### 7) Missing changelog policy for automation behavior changes

**Gap**
Major behavior shifts are partly reflected in ADRs, but there is no explicit contributor-facing rule for when to update docs + ADR + release/changelog notes together.

**Impact**
Documentation drift risk increases as workflows evolve.

**Recommendation**
Add a short documentation governance section (or `CONTRIBUTING.md` subsection) specifying minimum update set for behavior changes.

## ADR-specific observations

- ADR index is present and up to date through `0006`.
- Records are focused and coherent, but a few operational decisions remain undocumented (notably PR review trigger scope and provider stage parity).
- No superseded/deprecated ADR markers are currently needed, but a status field convention (`Accepted`, `Superseded`, `Deprecated`) would help future maintenance.

## Suggested next actions (priority order)
