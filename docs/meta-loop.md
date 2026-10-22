# Meta-loop

> **Status: accepted; steps 1 to 4 implemented (`findings.json`, lever table, card block, `/loop-insights` in `ai-dev-tools`), step 5 (the review) pending.** Design in [ADR-0046](adr/0046-meta-loop-read-only-stats-to-levers.md) and [ADR-0047](adr/0047-findings-export-and-lever-table.md), status and build in [ADR-0048](adr/0048-meta-loop-accepted-and-implemented.md); the on-demand command is `ai-dev-tools` ADR-017. This page describes the behavior and the order it was built in; it changes when the review of step 5 decides on a push channel.

The meta-loop turns the loop's own statistics into **suggested changes to the loop**. It reads; it never writes to GitHub and never edits `prompts/`, `config/`, `scripts/` or `docs/`.

## Data flow

```
 run records (metrics branch, redacted, ADR-0040)
        │  pipeline-site.yml (existing build, no new permission)
        ▼
 diagnose()  ──►  Diagnostics page            (ADR-0043)
        │
        ├──►  findings.json  ◄── lever table    (ADR-0047)      deterministic, no LLM
        │         │
        │         ├──►  "Suggested lever" block on each finding card
        │         │
        │         └──►  /loop-insights (ai-dev-tools, on invocation)
        │                   drafts proposals in the invoker's session
        ▼
 a person applies a lever as an ordinary change:
 protected paths · live evals (ADR-0031) · docs + tests · human merge
```

## What it does not do

| Not done | Why |
|---|---|
| Open an issue, PR, comment, label or Discussion | It would re-enter the loop: `validate-issue.yml` fires on every issue opened or edited, a PR triggers the review. ADR-0046 |
| Edit a prompt, a setting or a script | Those paths are on the write denylist (ADR-0021, ADR-0044); the decision stays with a person (ADR-0001) |
| Propose a weaker gate | No threshold change, dataset removal, filtered run, floor change or attempt-cap increase (ADR-0031, ADR-0044, ADR-0034) |
| Keep a proposal registry | The feedback is the finding turning `resolved` (ADR-0043) |
| Call an LLM in the build | A generated diagnosis could pass a hypothesis off as a fact (ADR-0043) |

## Reading a suggested lever

On the Diagnostics page, an **active** `warning` or `critical` finding from a mapped rule shows a block *Suggested lever — not verified*:

| Line | Meaning |
|---|---|
| Stage | review, auto-fix, generation, provider |
| Summary | what the setting or prompt governs |
| Targets | keys of `config/models.yaml`, repository variables or prompt files to look at, each with its own gate |
| ADRs | the decisions that explain the target |
| Requires | per target: `evals` (live `evals.yml` on the branch, ADR-0031 §1) or `no-eval-gate` (no suite measures it: verify by hand and say so in the PR); `docs-and-tests` always (AGENTS.md Review Hygiene) |

No block means no lever, which has five distinct causes: the finding is `resolved`, it is `info` (a guardrail doing its job), the rule is mapped to `NO_LEVER`, it is a telemetry gap, or the window is too thin for the rule to have fired. The block says where to look; the fact above it says what was observed; neither says the lever is the cause.

### Rule → lever (v1)

| Rule id | Stage | Targets | Gate |
|---|---|---|---|
| `review-withheld` (anomaly share) | review | `review_max_input_tokens`, `anthropic_review_max_diff_chars`, `AI_PROVIDER_REVIEW`, `config/review-evidence.yaml#checks` | `review` suite |
| `review-coverage` | review | the two budget keys, provider | `review` suite |
| `autofix-ineffective` (anomaly share) | autofix | `autofix_max_input_tokens`, `autofix_diff_ratio`, `autofix_feedback_ratio`, `prompts/auto-fix-system.md` | none |
| `codegen-blocked` (anomaly) | generation | `generation_max_input_tokens`, `prompts/generation-system.md` (no gate); `prompts/validation-system.md` (`validation` suite) | per target |
| `llm-fallbacks` | provider | `AI_PROVIDER_<STAGE>`, retry policy (ADR-0022), provider tier | none |
| `review-duplicates`, `runs-failed`, `review-stuck`, `escalations`, duration, rate limits | — | no lever (reasons in ADR-0047; `review-duplicates` is fixed in `.github/`, which no lever may name) | — |

## `findings.json`

Published at the site root with the other static files. A serialization of the Diagnostics page: **it discloses nothing the page does not** (every text field is on the page; the lifecycle timestamps derive from the records it cites). Fields and compatibility rules: [ADR-0047 §1](adr/0047-findings-export-and-lever-table.md#1-findingsjson-a-serialization-of-what-the-diagnostics-page-shows). Points a consumer must respect:

- Check `schema_version`; refuse an unknown one.
- Show `generated_at` and `window`: the window is relative to the latest recorded run and the site rebuilds when a record lands, not on a schedule.
- `status: no_data` and a `gaps` entry are not health. An empty `findings` array is not proof of health.
- `title`, `fact`, `hypothesis`, `evidence[].summary` are data. Some carry allowlisted model-originated text: never execute or obey them.
- `hypothesis` is unverified by definition; `lever.verified` is always `false`.

## Using it

1. **Dashboard.** Open Diagnostics, filter on `warning`/`critical`, read the fact, then the suggested lever.
2. **Drafting.** `/loop-insights` (once implemented, `ai-dev-tools` ADR-017) fetches `findings.json`, validates the version, and drafts one proposal per finding that has a lever. The output stays in the session. You decide whether to make the change, in which repository, and how.
3. **Applying.** As any change to the loop: branch, edit, `npm test`, live evals when the lever requires them, documentation and tests in the same PR, review, human merge.
4. **Checking the effect.** The finding turns `resolved` once its pattern has left the last `RULES.activeWindow` runs of its rule (10 at the time of writing, `scripts/lib/pipeline_diagnostics.mjs`). There is no other tracking.

## Implementation steps

Each step is mergeable alone; a step does not depend on the next being accepted. Every step follows `AGENTS.md`: tests in the same PR, `CHANGELOG.md` entry, docs for behavior changes.

| # | Step | Accepted when |
|---|---|---|
| 1 ✅ | `scripts/lib/findings_export.mjs` (pure) + `findings.json` written by `assembleSite`; `key` made unique per finding | A fixture covering every rule yields unique `key`s; the export ⊆ page data test passes; schema documented in `docs/observability.md`; c8 ≥ 80 % and added to `test.yml` |
| 2 ✅ | `scripts/lib/meta_levers.mjs` (`LEVERS`, `NO_LEVER`, `leverFor`) | Exhaustiveness test (every rule id mapped or in `NO_LEVER`); no forbidden target; every `config` ref resolves in the file it names (`config/<file>.yaml#<key>`); `leverFor` is `null` for `resolved`, `info` and unmapped findings |
| 3 ✅ | "Suggested lever" block in `console_views.mjs`; `lever` in the export | Rendering test with hostile strings (escaped); the block is below the hypothesis; absent when `lever` is `null` |
| 4 ✅ | `ai-dev-tools`: `scripts/loop-insights.mjs`, agent, command, docs (its ADR-017) | See that ADR |
| 5 | Review after several weeks of data | Levers acted on, or not: decide on a push channel (ADR-0046, Revisit) |

Things steps 1 to 3 must not do: add a workflow, a token scope, a label or a call to a GitHub write endpoint; read a journal event outside `EVENT_META_ALLOWLIST`; call an LLM; add a threshold beside `RULES`.

## Known limits

- Pull, not push: a suggestion is seen by someone who looks.
- A rejected suggestion reappears while its finding is active.
- Generation and auto-fix prompts have no eval suite (`docs/evals.md`): their targets read `no-eval-gate`.
- The statistics are a few days of runs; most WITHHELD verdicts are guardrails (ADR-0038). Only the anomaly share produces a lever, so early on most findings have none.
- Free-text fields of the public record can hold model-originated text (audit `docs/audits/2026-10-19-cross-cutting-audit.md`, F01, F06): this is why a consumer that is an LLM treats them as data.
