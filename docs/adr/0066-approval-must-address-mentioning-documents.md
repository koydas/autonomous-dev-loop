# ADR-0066: An approval must address the documents that mention what the diff changes (shadow first, then gate)

- **Date:** 2026-11-09
- **Status:** Proposed

> Extends [ADR-0062](./0062-documents-as-evidence-for-the-reviewer.md) (the Documents block is evidence the reviewer may use) and follows the two-step rollout of [ADR-0065](./0065-adversarial-protocol-by-coverage.md). Step 1 (shadow) is implemented by issue [#340](https://github.com/koydas/autonomous-dev-loop/issues/340); step 2 (the gate) is not, and this ADR changes no verdict.

## Context

ADR-0062 shows the reviewer the lines of documents that name a file or export the diff changes, renames or removes. It is context only: nothing checks that an approval looked at them. PR #279 was approved while a document outside the diff described the old behavior of a file the PR edited (`incident-docs-contradict-new-behavior`, still `known-gap`). Judging *whether* a document contradicts the change stays the model's job; what code can check is that the approval **did not ignore** the block.

## Decision

1. **Shadow (step 1, this change).** `unaddressedDocs(review, docMentions)` returns `{ count, files, generic_terms }`: the distinct document paths among the refs of the **non-generic** terms that the review text never names. A path counts as named in a finding, an axis line, a "Not verified" note or a `Documents checked: <paths>` line, which the prompt now asks for when the block is present; the check is a path search over the whole review (a string match with name boundaries: `docs/a.md` is not found in `docs/a.md.bak`), no LLM. Generic terms show only 3 of their documents, so they are excluded from the count and reported as `generic_terms`: a review cannot be required to cite what it was not shown. `null` when the scan was truncated or found no term.
2. **Published as numbers.** On an `APPROVE`, `review.verdict` carries `unaddressed_docs` and `unaddressed_docs_generic` (both in `EVENT_META_ALLOWLIST`), and the `review` suite carries `output.unaddressed_docs`. No path, term name or document text is published. No verdict, label, comment or threshold changes.
3. **Step 2 (gate), a separate PR.** An `APPROVE` with `unaddressed_docs > 0` becomes `WITHHELD` (`withheld_for: docs`), with the labels and comment shape of the other withheld reasons; it can turn an approval into a withhold, never the reverse. Condition to open it: a **published live `review` run** whose ID is recorded in #340, and the **projected withhold rate** on its approved cases (approved cases with `unaddressed_docs > 0` over approved cases with a computed value) recorded in the PR. If the prompt clause does not make the model list the documents it read, the answer is another prompt iteration, not a weaker check. The gate PR also settles what step 1 leaves open: the status `added` of the issue is moot (a new file is never a term), and truncated scans never gate.

## Alternatives Considered

- **Gate at once.** Rejected: the rate at which a real reviewer lists the documents it read is unknown, and a wrong rate withholds clean approvals (the cost ADR-0065 documents for the count rule).
- **Require citing every document, generic terms included.** Rejected: the prompt shows 3 of N documents for a generic term; the requirement would be unsatisfiable.
- **Check only the finding and axis sections.** Rejected: a path elsewhere in the review (summary) still shows the document was seen, and a section parser would add the failure modes ADR-0065 removed.

## Consequences

- ✅ The data for the gate exists before the gate does, with no change of verdict.
- ✅ Deterministic, one function shared by production and the suite.
- ⚠️ Naming a path is a floor, not proof of reading: a review can list a document it did not read, the same limit as a quote (ADR-0061) and an axis line (ADR-0065). The human merge stays the gate.
- ⚠️ The documents counted are those of the term refs, which is every document the reviewer could see only if the prompt block kept all terms; the block drops whole terms past its character budget (1,200 on Groq), so a document of a dropped term is counted though it was not shown. The gate PR must either count only the terms the block kept or accept this over-count; the shadow records the figure that decides.
- ⚠️ The prompt gains one clause (+112 tokens on the review prompt).
