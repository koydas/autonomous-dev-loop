# ADR-0051: Active lessons: recurring adverse signals reach the next run's prompt, from a fixed catalog

- **Date:** 2026-10-23
- **Status:** Accepted

## Context

The meta-loop (ADR-0046 to ADR-0048) is read-only by design: it turns the run statistics into a suggested lever on the Diagnostics page and in `/loop-insights`, and a person applies it as an ordinary change. That closed the loop for the *operator*, not for the *agent*: the same guardrail rejection (a `require()` in an `.mjs` file, a test file with fewer tests) or the same blocked finding can recur on every issue while a lever waits for someone to open the page.

ADR-0046 rejected one thing for good reasons: anything that writes to GitHub or edits `prompts/`, `config/`, `scripts/`, `docs/` re-enters the loop it observes (a created issue is validated and implemented, a PR is reviewed) and moves a decision from the person to the loop (ADR-0001). It also found that the public record holds no model output, so a component reading it "sees aggregates and allowlisted metadata, enough to point at a lever, not to write a patch".

## Decision

1. **The two code-writing stages read the recurring signals and add a short, bounded block to their system prompt.** `generate_issue_change.mjs` (stage `generation`) and `auto_fix_pr.mjs` (`autofix`) call `loadLessons` (`scripts/lib/lessons_loader.mjs`), which reads `metrics/runs.jsonl` on the `metrics` branch with the stage's existing token (one read-only `GET`, 10 s timeout). The review, validation and eval stages do not take lessons: a reviewer told what it found before would approve the same defects less.
2. **Signals are a closed vocabulary written by code**: `rule:<id>` for each rule of a `codegen_skip` / `autofix_skip` line with `reason: guardrail_rejected` (the write guard's rule ids: `module_system`, `exported_signature`, `unresolved_import`, `unshown_file`, `withheld_file`, `mass_deletion`, `test_count_drop`), and `axis:<id>` for each axis of a new `review_signal` line (`pr_review.mjs`, one per REQUEST_CHANGES whose High or Medium findings carry an `Axis:` tag, ADR-0049 §4). Anything else on a line, or a line that is not JSON, is dropped: `signalsOfLine` keeps only ids that are keys of the catalog.
3. **A lesson is a fixed sentence in `LESSONS` (`scripts/lib/lessons.mjs`)**, written and reviewed like any other prompt text. No string of a run record, review, issue, PR or model output is ever copied into a prompt: the prompt-injection channel ADR-0046 and the audit (F01, F06) worry about does not exist, because the only thing that crosses is the *key* of a catalog entry. A test pins that every rule id of the write guard and every axis has an entry, that unknown ids reach nothing, and that no lesson uses loosening words.
4. **A lesson restates a rule the prompt already has, it never relaxes one.** The generation and auto-fix prompts already carry the guardrails of ADR-0009; a lesson says "this one, recently, again". It can only make the model more careful. The enforcement stays in code (the write guard rejects the patch either way).
5. **Recurring means**: the signal occurs at least `MIN_OCCURRENCES` (2) times among the newest `WINDOW` (30) signals no older than `MAX_AGE_DAYS` (30). A pattern that stops occurring leaves the window as newer signals displace it, and one that is old is history: the same lifecycle idea as ADR-0043's resolved findings, without state. At most `MAX_LESSONS` (3), most frequent first, within `MAX_LESSONS_CHARS` (700): whole lessons only. On generation the block is left out if it would push the prompt over `generation_max_input_tokens`; on auto-fix it is counted in the budget like the rest of the system prompt.
6. **It never fails a run.** No `metrics` branch is no lessons; any other failure is one `lessons.unavailable` warn event and no lessons; a successful read that finds something is one `lessons.loaded` event listing catalog ids. `ADL_LESSONS=off` turns the feature off per workflow (human as gate: an operator can disable it without a code change).
7. **What this supersedes of ADR-0046.** Not point 2 (no GitHub write: the `review_signal` line goes through `appendMetric` and the existing metrics commit, like `autofix_skip`, and the loader only reads) nor point 4 (no edit of `prompts/`, `config/`, `scripts/`, `docs/`: nothing is edited). It narrows point 3's spirit ("a generated diagnosis could pass a hypothesis off as a fact"): there is still no LLM and no generated text, but the meta-loop's output now reaches an LLM's context without a person in between. That is the decision of this ADR, bounded by points 2 to 6: what may be said is a reviewed catalog, the effect is a stricter reminder, and the switch is an environment variable.

## Alternatives Considered

- **Let the model write the lessons** (summarize recent failures). The failure mode ADR-0043 and ADR-0046 reject: model text, built from model and issue text, stored and fed back into prompts. A poisoned issue would teach the loop. Rejected.
- **A lessons file committed by the meta-loop** (`config/lessons.yaml`, via PR). A PR is reviewed by the loop and the file is on the write denylist (ADR-0021/0044); ADR-0046 rejected "apply a lever through a PR". Rejected.
- **Compute lessons in the site build and publish `lessons.json`.** The build runs on a schedule of record arrivals (hours), the stages would read GitHub Pages instead of the API, and a `lessons.json` would be a second public artifact to keep in step with `findings.json`. The `runs.jsonl` signals are already written by the stages themselves, in the same commit as their run record.
- **Per-finding lessons from the review text** ("the reviewer keeps flagging X in `foo.mjs`"). Needs the wording of the findings, which is model text. The axis tag is the part of a finding the pipeline can use safely.
- **Give lessons to the reviewer as well.** It would bias the stage whose job is to be independent of the history of the PR (ADR-0049).

## Consequences

- ✅ The loop learns without a person in between for the cases it can name: a guardrail that rejected two of the last thirty patches is in the next prompt.
- ✅ No new secret, token scope, workflow, label or store; the only new GitHub call is a read the stage's token already allows.
- ✅ Bounded and observable: at most three lessons, 700 characters, journaled by id, switchable.
- ⚠️ **The effect is not measured.** Generation and auto-fix have no eval suite (`docs/evals.md`, the same gap `meta_levers.mjs` names), so whether a lesson lowers the rejection rate is read from Diagnostics (`codegen-blocked`, `autofix-ineffective`) over the following weeks, not gated. If a rejection rule's rate does not fall once its lesson is active, the lesson is noise: remove it from the catalog.
- ⚠️ Axis lessons are approximate: the tag is the reviewer's, on the blocking finding, and only as reliable as the model's tagging. They are generic reminders, not corrections.
- ⚠️ `runs.jsonl` only grows; the loader reads the whole file with a raw `GET` and parses the last 2000 lines. Fine at today's size (kilobytes); if the file reaches megabytes, read through the trace indexes or a compacted ledger instead.
- ⚠️ The prompt of a run now depends on the repository's history: two runs of the same issue can differ. The run journal records which lessons were loaded.
