# ADR-0048: Meta-loop accepted and implemented; what the review of step 5 decides

- **Date:** 2026-10-22
- **Status:** Accepted

## Context

[ADR-0046](./0046-meta-loop-read-only-stats-to-levers.md) and [ADR-0047](./0047-findings-export-and-lever-table.md) were written as proposals. Point 8 of ADR-0046 says "Proposed. Nothing is implemented; ADR-0047 and the ai-dev-tools ADR-017 are proposed with it. Accepting them is the go for the first implementation step". The three layers are now built, and that sentence is false. An accepted ADR is not rewritten, so the status of the meta-loop is recorded here and point 8 is superseded.

## Decision

1. **ADR-0046 and ADR-0047 are accepted**, and so is `ai-dev-tools` ADR-017. Everything they decide holds unchanged, except point 8 of ADR-0046, which this ADR supersedes.
2. **What is built**, in the order of [`docs/meta-loop.md`](../meta-loop.md#implementation-steps):

   | Step | Built | Where |
   |---|---|---|
   | 1 | `findings.json`, `schema_version: 1`, written by `assembleSite` at the site root when the build has pipeline records | `scripts/lib/findings_export.mjs` (#258) |
   | 2 | The finding → lever table: `LEVERS`, `NO_LEVER`, `forbiddenTarget`, `leverFor` | `scripts/lib/meta_levers.mjs` (#259) |
   | 3 | The "Suggested lever" block on the Diagnostics card and `lever` in the export | `scripts/lib/console_views.mjs`, `findings_export.mjs` (#260) |
   | 4 | `/loop-insights`, the `loop-analyst` agent and the validating script, in `ai-dev-tools` | its ADR-017 (koydas/ai-dev-tools#31) |

3. **Where the build differs from the wording of ADR-0047**, so that the code and the ADR agree:
   - The disclosure invariant of §1 is stated as built: every text field of the export is shown on the Diagnostics page; `first_seen`, `last_seen` and `clean_since` are epoch milliseconds computed from the records the page cites. The test checks the text fields.
   - `requires` of a lever (§2) is carried by each target (`evals` or `no-eval-gate`); the root `requires` is the union of those plus `docs-and-tests`.
   - A rule that carries a stage in its id (`stage-failures-<stage>`, `duration-<stage>`) is one family in the tables, and `stage-failures-*` is listed in `NO_LEVER` with `runs-failed` (a root cause is needed, not a setting).
4. **Step 5 is a decision of a person, not a mechanism.** After several weeks of data, someone reads the Diagnostics page and the `/loop-insights` reports and decides, in a new ADR, whether a push channel is needed (ADR-0046, Revisit). The inputs are the share of active `warning` / `critical` findings that carry a lever, and whether the proposals were acted on. The second is read from the pull requests of the repository: ADR-0046 §7 keeps the meta-loop stateless, so nothing tracks a proposal. No threshold is set here. A push channel supersedes ADR-0046 §2; applying a lever through a pull request is a different decision and needs its own ADR against ADR-0021.
5. **Not verified end to end at the time of this ADR.** The dashboard had not yet published `findings.json` from real records, and `/loop-insights` had not run on a real export: the tests use fixtures, one of them (`tests/fixtures/findings-export.json` in `ai-dev-tools`) produced by this repository's own exporter. The first real build and the first real report are the first thing step 5 looks at.

## Alternatives Considered

- **Edit point 8 of ADR-0046 in place:** the shortest change, but it rewrites an accepted decision and hides that the sentence was once true. Rejected for a superseding ADR, which the repository already does for status changes (ADR-0022 and ADR-0028).
- **Leave point 8 as written:** the ADR would say that nothing is implemented, which a reader of `docs/meta-loop.md` would find contradicted. Rejected.
- **Accept the three ADRs without recording what was built:** the differences of point 3 would live only in the pull requests. Rejected.

## Consequences

- ✅ The ADRs, `docs/meta-loop.md` and the code say the same thing, and the history of the proposal stays readable.
- ✅ Step 5 has named inputs and an owner (a person), and no mechanism to maintain.
- ⚠️ One more ADR for a status change, and ADR-0046 now points to a later file for one of its points.
- ⚠️ The ADRs are accepted before a real build and a real report exist; point 5 keeps that visible.
