# ADR-0042: Merged PR flow map

Status: Accepted

## Context

Operators need a mobile view connecting merged PRs, issues and agent execution evidence. A successful workflow is not evidence of merge. The retained metrics branch has no authoritative merge journal.

## Decision

Add a framework-free Flow map tab to the static dashboard. Render retained trace evidence at build time, then query the public GitHub closed-pulls API in the browser and use only `merged_at` to establish merge. Refresh loads at most ten pages of 100 closed PRs ordered by update time, with a timeout per request. State the limit when reached. No credentials or new public record fields are introduced.

Match PR numbers from normalized run envelopes and event metadata first, then the existing `ai/issue-N` branch convention or first same-repository closing reference in the PR body (bounded to 64 KiB). Do not infer issue relationships from titles. A PR without recorded evidence still gets a complete pipeline skeleton. Trace metrics describe the retained work item, potentially including multiple PRs; they are not attributed exclusively to one PR.

Always show validation, generation, preparation, review, auto-fix and merge. Missing evidence is grey and explicitly labelled. Repeated executions remain expandable, linking to existing agent journals and waterfalls. Arrows indicate canonical stage order, not execution causality; chronological traces remain authoritative.

Use the shared model price table for recorded LLM call token estimates. Unknown pricing remains unpriced; no billing accuracy is claimed. Running and waiting use existing trace timing calculations.

## Consequences

At 375 CSS pixels (iPhone 13 mini), cards and stages stack vertically with wrapping text and 44px controls. Native details and recorded evidence work without JavaScript. A failed GitHub request restores recorded flow cards and explicitly leaves merge unknown. Live PR titles are inserted with textContent, and links use fixed repository URLs plus validated numeric identifiers.

This avoids a new workflow and credentialed merge journal. Merge discovery needs browser network access and is subject to GitHub rate limits. Historical execution data remains bounded by the existing six-month retention window; complete PR history is not guaranteed.
