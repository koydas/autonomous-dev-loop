# Dashboard: interpreting partial runs and restoring useful review context

## Incident and limits of the evidence

The supplied analysis of 16–18 October 2026 reports 20 partial runs out of 22
(90.9%): 13 WITHHELD reviews, 3 REQUEST_CHANGES reviews, 3 no_changes auto-fixes,
and one already_reviewed skip. The other two runs are success; none is failed.
This is an analysis of a retained sample, not a measurement of the complete
issue → generation → review → merge pipeline or a verified snapshot of the live
GitHub Pages deployment.

Source: [metrics snapshot](https://github.com/koydas/autonomous-dev-loop/tree/d131cacda180ff97e53a4c86e7cd0e1525b832e8/metrics).
The counts above are reported by the supplied analysis, not independently
recomputed by this patch.

## Diagnosis

`pr_review.mjs` finalizes every non-approved review and deduplicated skip as
`partial`, although a verdict or intentional skip is not an execution failure.
The dashboard formerly presented success records as successfully completed jobs.
Consequently its aggregate alone cannot answer whether automation ran correctly.

All 18 reviews with a verdict reportedly received truncated diffs. The 16
non-approved reviews had 3–12 code files not fully examined. On
[PR #223](https://github.com/koydas/autonomous-dev-loop/pull/223#issuecomment-6256139091),
approval was withheld despite positive findings and CI evidence because three
code files were incomplete. Keep this approval guard: increasing approval counts
by removing coverage checks would hide the underlying problem. Only two recent
WITHHELD records explicitly preserve `withheld_from=APPROVE`; do not infer the
original verdict for older records.

The three no_changes auto-fixes reportedly saw only a skill file in full, with
the relevant workflows withheld and 24–25 other files omitted. Missing context
is one possible cause, but no_changes alone does not prove a fix was needed.
[PR #219](https://github.com/koydas/autonomous-dev-loop/pull/219#issuecomment-6227497521)
and [PR #221](https://github.com/koydas/autonomous-dev-loop/pull/221#issuecomment-6228587609)
report false findings or intentional behavior. Never force a patch merely to
avoid an escalation.

Five PR/SHA pairs reportedly ran twice via push and pull_request, with four pairs
making repeated model calls. Current markers do not provide an atomic claim;
WITHHELD is deliberately retryable. A shared concurrency group alone is also not
an atomic deduplication mechanism.

## Implemented correction

Execution cards now display the recorded outcome separately from the review
verdict, available CI evidence, withheld-from verdict when explicitly recorded,
coverage count, truncation, skip reason and human escalation. Missing facts stay
"Not recorded". Existing outcomes, filters, run records and approval safeguards
remain authoritative. The overview explains that partial is not a job failure
and that these aggregates are not an end-to-end success rate. Rendering tests
exercise the production redaction/model path and hostile metadata.

## Proposed follow-up fixes and acceptance criteria

1. Introduce separate execution status, business decision and reason fields at
   the producer boundary. A completed REQUEST_CHANGES or WITHHELD review must
   retain its decision without becoming a failed job; errors after a verdict
   must still surface as execution failures. Old records must remain readable
   and ambiguous history must not be silently reclassified.
2. Review every changed code file through budgeted batches with an explicit
   per-file coverage ledger. Aggregate findings deterministically; approval
   requires complete coverage and verified required evidence. A failed batch,
   omitted file or oversized hunk must keep approval withheld. Validate the
   provider quota before raising the current 6,300 estimated input-token budget;
   multiple requests must respect TPM limits too. Test multi-batch completeness,
   oversized files, batch failures and negative findings.
3. Select auto-fix context from review-named paths before generic context. Reserve
   space for instructions and output, enforce the write denylist and distinguish
   insufficient context, unmodifiable target and an explicit decision that no
   correction is needed. Test a workflow finding with a large unrelated skill
   file, denied paths, and the intentional concurrency behavior from #221.
4. Claim work atomically by repository + PR + head SHA across triggers. Recheck
   head SHA before publishing; release failed claims safely and expose an
   explicit manual retry. Preserve intentional WITHHELD retries. Verify two
   simultaneous triggers cause one model call while manual retry and new heads
   still run.
5. Add minimized, source-attributed eval cases for the confirmed #219/#221 false
   findings in the PR fixing review/context selection (AGENTS.md, ADR-0031).
   This presentation patch changes no model judgment and does not claim to fix
   those findings. Existing thresholds and cases must remain intact.

Operationally, inspect the recorded verdict and coverage before retrying, split
large PRs when possible, and route no_changes escalations to a human. Compare
unique PR/SHA decisions alongside run volume rather than interpreting the partial
percentage as pipeline failure.
