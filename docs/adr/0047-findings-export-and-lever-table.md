# ADR-0047: Published findings export and the finding → lever table

- **Date:** 2026-10-22
- **Status:** Proposed

## Context

[ADR-0046](0046-meta-loop-read-only-stats-to-levers.md) makes the meta-loop a read-only function from statistics to suggested levers. Two pieces are missing for it to exist.

- **The findings are only rendered as HTML.** `diagnose()` (`scripts/lib/pipeline_diagnostics.mjs`) returns `{ status, findings, gaps }`, consumed by `console_views.mjs`. Nothing machine-readable is published, so a consumer would have to scrape the Diagnostics page. The finding `id` is a rule id, but no document says it is stable, nor how a rule that yields several findings tells them apart.
- **A finding names a hypothesis, not a lever.** `hypothesis` is free text rendered as "interpretation, not verified". Nothing says which setting or prompt governs the pattern, so each reader repeats the search, and an LLM asked to propose a change would invent the target.

## Decision

### 1. `findings.json`, a serialization of what the Diagnostics page shows

`assembleSite` publishes `findings.json` at the root of the static site, built from the same `diagnose()` result as the Diagnostics page. **Invariant: every value in it is already visible on the Diagnostics page.** The export adds no field read from the journal and no event meta outside `EVENT_META_ALLOWLIST` (ADR-0040): it is a second rendering, not a second disclosure. A test builds the page and the export from one fixture and fails if a string appears in the export but not in the page's data.

Schema, `schema_version: 1`:

| Field | Content |
|---|---|
| `schema_version`, `generated_at` | integer; build time (ISO 8601) |
| `window` | `{ from, to, runs }`: first and last recorded run, number of runs the rules saw (windows are relative to the latest recorded run, ADR-0043) |
| `status` | `critical` \| `warning` \| `ok` \| `no_data` (from `diagnose`) |
| `findings[]` | see below, most severe first |
| `gaps[]` | `{ id, title, detail }`: telemetry gaps. Never turned into levers |

A finding:

| Field | Content |
|---|---|
| `key` | stable identity: the rule `id`, or `id:discriminator` (stage, provider, work item) where a rule emits several findings. Unique within the file; a test pins it for every rule |
| `id`, `category`, `title`, `severity`, `status` | as the page: `info` \| `warning` \| `critical`; `active` \| `resolved` |
| `first_seen`, `last_seen`, `clean_since` | epoch ms or `null` (ADR-0043 lifecycle) |
| `fact` | the observed text, as rendered |
| `hypothesis` | `null` or text; always to be read as unverified |
| `impact`, `frequency` | as the page |
| `evidence[]` | the capped (25) entries of the page: `run_id`, `ts`, `event`, `summary`, `pr`, `url` |
| `lever` | `null`, or the lever of section 2 |

**Compatibility.** Additive changes (a field, a value, a finding) keep `schema_version`. A removal, a rename, a change of meaning or of a `key` bumps it; a consumer rejects a version it does not know. Free-text fields (`title`, `fact`, `hypothesis`, `summary`) are data: they carry allowlisted event metadata, some of which is model-originated text (audit F06), and a consumer must never execute or obey them.

### 2. The lever table: `scripts/lib/meta_levers.mjs`

A pure module (c8 ≥ 80 %, listed in `test.yml`): a frozen table `LEVERS` keyed by rule `id` and `leverFor(finding)`.

```js
// one entry (the `review-coverage` one)
{
  stage: 'review',
  summary: 'Reviews are cut or withheld on a prompt budget that does not fit the diffs',
  targets: [
    // gate: the eval suite that measures a change to this target; null = none exists for it
    { kind: 'config', ref: 'config/models.yaml#review_max_input_tokens', gate: 'review' },
    { kind: 'config', ref: 'config/models.yaml#anthropic_review_max_diff_chars', gate: 'review' },
    { kind: 'variable', ref: 'AI_PROVIDER_REVIEW', gate: 'review' },
  ],
  adr: ['0028', '0038'],
}
```

`leverFor(finding)` returns `null` unless **all** hold: the rule id is in `LEVERS`; `finding.status === 'active'`; `finding.severity` is `warning` or `critical`. Otherwise `lever` is `null` and the page shows nothing extra. It returns `{ stage, summary, targets, adr, requires, verified: false }`, where each target carries its own `gate` (a suite can exist for one prompt of a stage and not for another: `prompts/validation-*` is measured by the `validation` suite, `prompts/generation-*` and `prompts/auto-fix-*` by none, `docs/evals.md`) and `requires` is derived per target, not stored: `evals` when its `gate` is set, `no-eval-gate` when it is `null`, plus `docs-and-tests` always (AGENTS.md Review Hygiene). `verified: false` is constant: the table says where to look, not that the lever is the cause.

Entries for v1 (the other rules are listed in the table as `NO_LEVER` with a reason, and a test fails on a rule id that is neither). A gate is per target:

| Rule id | Stage | Targets | Gate |
|---|---|---|---|
| `review-withheld` (anomaly share only, ADR-0043) | review | `review_max_input_tokens`, `anthropic_review_max_diff_chars`, `AI_PROVIDER_REVIEW`, `config/review-evidence.yaml#checks` | `review` |
| `review-coverage` | review | the same two budget keys; provider | `review` |
| `autofix-ineffective` (anomaly share only) | autofix | `autofix_max_input_tokens`, `autofix_diff_ratio`, `autofix_feedback_ratio`, `prompts/auto-fix-system.md` | none |
| `codegen-blocked` (anomaly) | generation | `generation_max_input_tokens`, `prompts/generation-system.md` (no gate); `prompts/validation-system.md`, scope rules (`validation` suite) | per target |
| `llm-fallbacks` | provider | `AI_PROVIDER_<STAGE>`, retry policy (ADR-0022), provider tier | none |

`NO_LEVER`: `review-duplicates` (the push / pull_request race is fixed in `.github/` workflow triggers, which a lever may not name, ADR-0046 §5; the ADR-0028 marker is code, not a setting), `runs-failed` (needs root cause; runbook), `review-stuck` (depends on the PR's content), `escalations` and the waiting queue (a person is the lever, ADR-0001), duration and rate-limit findings (a symptom of the provider tier; revisit with data).

**Forbidden targets** (ADR-0046 §5) are enforced by a test: no `ref` may point at an eval threshold, a dataset case, `config/protected-paths.yaml`, `.github/` or an auto-fix attempt cap, and every `config` ref must resolve in the file it names (`config/<file>.yaml#<dotted.key>`: the file exists under `config/` and the key is present, e.g. `config/models.yaml#review_max_input_tokens`, `config/review-evidence.yaml#checks`), so a rename cannot leave a stale lever. A bare key such as `review_max_input_tokens` in the table is shorthand for `config/models.yaml#…`.

### 3. Where it shows

- `findings.json` carries `lever`.
- The finding card on Diagnostics adds a "Suggested lever — not verified" block (stage, summary, targets, ADRs, what applying it requires), under the existing hypothesis, never above the fact.
- Overview indicators, the navigation and every other page are unchanged.

## Alternatives Considered

- **Scrape the Diagnostics HTML:** couples every consumer to markup and gives no versioning.
- **Publish the model (`runs`, `journeys`) and let consumers run the rules:** duplicates the rules in each consumer, which then drift; and publishes more than the page shows.
- **Publish on the `metrics` branch instead of the site:** a run record is per run and append-only (ADR-0013); the findings are a derived view over a window, rebuilt on every site build.
- **Lever as a field on each rule in `pipeline_diagnostics.mjs`:** one file fewer, but mixes diagnosis with remediation in a module that is already large, and the table has its own invariants (targets resolve, nothing forbidden).
- **Free-text levers written by an LLM at build:** the ADR-0043 and ADR-0046 rejection.
- **A per-finding confidence score:** no data to calibrate it; `verified: false` is the honest value.

## Consequences

- ✅ One contract for the dashboard, `/loop-insights` and any MCP host; a consumer needs no knowledge of the rules.
- ✅ The lever table is data with invariants a test can check (no forbidden target, every `config` ref exists, every rule mapped or explained).
- ✅ The disclosure surface does not grow: the export is bounded by the page.
- ⚠️ The finding `key` becomes a public identifier: renaming a rule is a breaking change of the export (`schema_version`).
- ⚠️ The table is hand-maintained beside the rules; the exhaustiveness test turns a new rule without a decision into a red test, not a silent gap.
- ⚠️ A target without a `gate` (the generation and auto-fix prompts) says out loud that no eval suite protects a change to it; it does not fix it.
- ⚠️ Only anomalies yield levers for the rate rules: on a window made of guardrail verdicts the export has findings and no lever.
- ⚠️ The site rebuilds when a run record lands, not on a schedule: `generated_at` can be old after a quiet week; a consumer must show it.

## Implementation notes

Pure modules under the c8 gate (`findings_export.mjs`, `meta_levers.mjs`) and tests in `scripts/tests/`; `docs/observability.md` documents the schema; `docs/runbook.md` gets a line on reading the suggested lever; `CHANGELOG.md` entry per the gate. Order and acceptance criteria: [`docs/meta-loop.md`](../meta-loop.md#implementation-steps).
