# ADR-0029: Deterministic write guard for auto-fix

- **Date:** 2026-10-05
- **Status:** Accepted — extended to code generation, and composed with the static rules (module format, exported signatures, imports), by [ADR-0019](./0019-static-verification-backstop.md); amended 2026-10-13: a blocked issue opens no PR on generation

## Context

Auto-fix keeps deleting large parts of files. The model returns each changed file whole (`file_content`), but it often saw only part of it:

- On the Groq free tier (`autofix_max_input_tokens: 3000`, `autofix_diff_ratio: 0.45`, `autofix_feedback_ratio: 0.25`), file contents got about 837 tokens, roughly 3.3 KB for **all** files together. Each file was also cut at 8,000 characters (`MAX_FILE_SIZE`). Both cuts were silent, and the prompt called the result "the authoritative base". The model therefore sent back the truncated view as the complete file, and everything past the cut was deleted.
- `changes` had to contain 1 to 6 objects, so the model was not allowed to decline. When it could not fix something safely, it rewrote instead.
- Nothing checked that `target_path` was one of the files shown. Writing an existing file that was not in the prompt meant inventing its content.
- `auto-fix-user.md` asked for edits under `scripts/`, `prompts/` and `.github/workflows/`, which the system prompt protects (ADR-0021).

ADR-0009 added prompt guardrails (no test removal, ≤ 30% rewrite) and rejected a validation script as unnecessary infra. In practice, prompt-only guardrails do not hold when the model is asked to reproduce content it never received.

## Decision

1. **A file is shown in full or withheld, never cut.** `auto_fix_pr.mjs` fills the file budget with whole files. A file larger than `MAX_FILE_SIZE`, or one that does not fit in the remaining budget, is replaced by a `File withheld … do NOT target this file` marker.
2. **Write guard before anything touches disk.** `scripts/lib/autofix_guard.mjs` (`findUnsafeChanges`) rejects a change to an existing file when:
   - the file was withheld, or not shown at all;
   - it removes more than `max(20, 30%)` of the file's non-blank lines (multiset line difference, so moved lines do not count);
   - it is a test file and its `test(` / `it(` count drops.

   New files are allowed.
3. **Explicit "blocked" outcome.** Any guard violation is raised as a `GuardrailError` and escalated like the write denylist and the shrink guard (ADR-0021, ADR-0009): an `Auto-Fix: Patch Rejected` PR comment lists the reason per file, no file is written, no `fixed_paths` is emitted, the attempt label and `needs-human` are applied (so the 3-attempt limit holds), `autofix.skipped` is logged with `reason: "guardrail_rejected"`, and the run exits 0. The ADR-0029 guard is stricter than the shrink guard (30% vs 50%) and also covers unshown files and test counts; both run, before any write. The model may also decline with `"changes": []` and a `blocked_reason`: that case goes through the `no_changes` path of ADR-0028 (attempt counted, `needs-human`, `autofix.skipped`), whose comment now shows `blocked_reason` when present, collapsed to one line and capped at 500 chars.
4. **Prompt cleanup.** The system prompt allows 0 to 6 changes and forbids targeting withheld or unshown files. The test rule no longer says "regardless of its path". The user prompt drops the block that invited edits to protected paths and puts the review feedback after the file contents.
5. **Budget rebalance.** `autofix_diff_ratio` goes from `0.45` to `0.15`. Files now get 60% of the budget: the diff mostly repeats them, and only files shown in full can be edited.

## Alternatives Considered

**Stronger prompt wording only** — this is what ADR-0009 did, and the incidents continued. The deletion comes from missing input, which no prompt wording can make up for.

**Search/replace edits instead of whole files** — this removes the failure mode at its root and cuts output tokens. It is deferred to a follow-up because it changes the output contract shared with `output_writer.mjs` and the generation stage. The guard stays useful afterwards as a backstop.

**Fail the job on a guard violation** — this would make the cause harder to find (the job turns red with no PR comment) and does not stop the next review from triggering again. Blocking with a comment and counting the attempt keeps the loop bounded and visible.

## Consequences

- ✅ Auto-fix can no longer write an existing file it did not see in full.
- ✅ Bulk deletions and test removals are rejected deterministically, not just discouraged.
- ✅ "I can't fix this safely" becomes an outcome the operator can see, instead of a forced rewrite.
- ⚠️ A legitimate fix that deletes a lot of code, such as dead-code removal asked for by the review, is blocked and must be done by hand.
- ⚠️ On the Groq free tier, files above roughly 6.5 KB (or several medium-sized files) are withheld, so auto-fix blocks more often. That is the honest outcome for that budget. Raising `autofix_max_input_tokens` or switching to Anthropic removes it.
- ⚠️ A rewrite that keeps most lines textually but changes their meaning is not detected. The guard limits deletion, not correctness.

## Amendment (2026-10-13): a blocked issue opens no PR on generation

Decision 3 gave auto-fix an explicit "blocked" outcome; ADR-0019 extended the write guard, not that outcome, to code generation. Generation still had to return 1 to 6 changes, so when it could not implement an issue it wrote a Markdown handoff note: #191 (issue #190, every target under `scripts/` / `config/`, and the issue declared itself blocked by unmerged #188) added `notes/issue-190-blocked.md`; #196 (issue #195) added `patches/issue-195-dependency-manifest.md`. The review bot approved both, and merging either would have closed its issue.

Decision: `scripts/lib/generation_blocked.mjs`, called by `generate_issue_change.mjs` after the JSON parse and before `validateAiOutput()`. First match wins:

1. **Deterministic, from the issue (`source: "denylist"`).** Every path the issue needs is protected (`PROTECTED_WRITE_PATHS`, ADR-0021) or withheld from the prompt (decision 1). Needed paths come from `extractFilePaths` with URLs removed; a bare file name counts only when it exists at the repository root and is not the base name of a named path; the root `CHANGELOG.md` is a companion of the change, never the change. No named path, or one writable path → not blocked here.
2. **Model signal (`source: "model"`).** `"blocked": true` — the JSON boolean — with `blocked_reason` and `planned_fix`, `changes: []`. `summary` text is never read as a signal; any other `blocked` value is malformed output and fails the run.
3. **Deterministic, on the output (`source: "notes_only"`).** For an issue labelled `bug` or `feature` (`ISSUE_LABELS`), a patch whose only files are new `.md` files outside `docs/` is refused.

**Precedence.** Facts about the repository win over the model: `blocked: false`, or a note, cannot override check 1, and an injected issue body cannot talk its way past it. The model is trusted only to *add* a blocker the code cannot see (an unmerged PR dependency); blocking is the fail-safe direction, so trusting it there costs one human look at worst. Check 3 runs last because it is a backstop on the output for the cases checks 1–2 missed. The cost asymmetry decides: a false "blocked" is visible and undone by re-labelling; a missed one is an approved PR that closes the issue on merge.

**Outcome.** No file written, no branch pushed, no PR (`blocked=true`, the PR step is skipped). The issue gets a `Code Generation: Blocked` comment with the source, the reason and the planned fix (`planned_fix`, else the content of the note the model wrote, else its summary), `ready-for-dev` is replaced by `needs-human`, a `codegen_skip` metric records `reason: "blocked"` and `source`, and `code_gen.skipped` is logged with `reason: "blocked"` and `duration_ms`. A failed GitHub call ends the stage with `code_gen.error` (`reason: "blocked"`), exit 1. The LLM is still called when check 1 fires: the comment needs the model's planned fix.

Alternatives considered:
- **Model signal only.** Cheap, but a model that writes a note anyway (#191, #196) is the failure mode; it does not hold alone.
- **Skip the LLM call when check 1 fires.** Saves a call, but the comment would carry no planned fix, which is what the human needs to pick the issue up.
- **Detect "blocked" from the summary or note text.** Rejected: free text is not a contract, and an issue body can put any wording in it.
- **Refuse every notes-only patch, whatever the label.** Would break documentation issues outside `docs/` (e.g. `guides/*.md`). Scoped to `bug` / `feature`.

Consequences:
- ✅ A blocked issue costs one comment instead of a PR the review approves.
- ✅ The planned fix is kept on the issue, where the human implementing it looks.
- ⚠️ False positive of check 1: an issue that names only protected paths but whose fix belongs elsewhere (e.g. "implement what `README.md` describes" with no other path) is blocked. Visible, and fixed by naming the target file.
- ⚠️ The review side is unchanged: a notes-only PR opened another way would still be approved. Follow-up proposed on the review stage.
- ⚠️ `bug` / `feature` are matched by name (`CODE_CHANGE_LABELS`); a repository using other labels gets only checks 1 and 2.

## Amendment (2026-10-23): which tokens of an issue count as needed paths

Six blocked generation runs of October 2026 (#134, #150, #200, #209, #211, #236) were all `source: "model"`, although the real files each issue names were protected. `extractFilePaths` reads any `word/word` as a path, so prose such as `retry/fallback`, `401/403`, `old/new` or `TPD/RPD` became a "needed path"; it exists nowhere, is neither protected nor withheld, and one such writable-looking token is enough for check 1 not to fire (measured on the real issue texts: 5 of 5 readable issues returned no deterministic block). The extractor also drops a leading dot, so `.github/workflows/evals.yml` was read as `github/workflows/evals.yml`, which no protected-path rule matches.

`findNeededPaths` now counts a candidate that contains a `/` only when it exists in the repository or ends in a file extension (a new file is still a path; any extension, as `App.csproj`), and restores the leading dot when the text has it right before the candidate. `extractFilePaths` itself is unchanged: the file-context injection still reads every candidate. The model is still called when check 1 fires (the comment keeps its planned fix); what changes is the recorded `source` (`denylist`), which Diagnostics reads as a block by design. On the same texts, 4 of 5 issues now fire check 1; #236 still does not, because it names `pipeline/flows.html`, a generated page that does not exist and has a file extension.

Consequence: a path-looking word with a dotted ending that is not a file (`docs/v1.2`) is still a candidate, and an issue that names only protected files next to a new unprotected one is not blocked, as before.

