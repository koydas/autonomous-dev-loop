# Pipeline operations

What runs next to the stages of the loop and is not a stage itself: the journal of the end of a work item, and the machine-readable export of the dashboard's findings. Setup of the stages is in [`code-generation.md`](code-generation.md); failure triage in [`runbook.md`](runbook.md); the event and schema reference in [`observability.md`](observability.md).

## Findings export (ADR-0047 §1)

The `pipeline-site.yml` build (and the `evals` publish job, which assembles the same site) also publishes `findings.json` at the site root: the Diagnostics findings, machine-readable, built from the same `diagnose()` result as `pipeline/diagnostics.html`. It needs no new permission, secret, token scope or workflow, and writes nothing to GitHub. It is published only when the build has pipeline records; **its absence is not an empty list** (an eval-only site has none, and a consumer must not read it as "no finding"). `generated_at` and `window` say how old the data is: the site rebuilds when a record lands, not on a schedule. Each finding may carry a `lever` (where to look, never verified): `docs/meta-loop.md` → "Reading a suggested lever". Schema and consumer rules: `docs/observability.md` → "`findings.json`". Design: `docs/meta-loop.md`.

## Item Closed (ADR-0043 amendment)

`item-closed.yml` runs on `issues: closed` and `pull_request: closed` and journals the end of the work item (`scripts/item_closed.mjs`, one `item.closed` event: `state_reason` for an issue, `merged` for a pull request). It is not a pipeline stage: no LLM call, no secret other than the workflow token, `contents: write` for the `metrics` branch only, scripts taken from the default branch. The dashboard uses it to move a merged or closed item out of "Waiting on you". It belongs to this repository (no `adl-` reusable version, no caller template); a pull request from a fork has a read-only token and is not recorded. Triage: `docs/runbook.md` → "An item shows as Waiting on you but was merged or closed".
