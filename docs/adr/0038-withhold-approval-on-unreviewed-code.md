# ADR-0038: Withhold approval when code was cut from the reviewed diff

- **Date:** 2026-10-13
- **Status:** Accepted

## Context

`buildReviewPrompt` fits the diff to the input budget. On Groq that budget is `review_max_input_tokens` (6300); the system prompt alone takes ~2.4k tokens, so a diff of more than roughly 150 lines is cut. On Anthropic the diff is capped at 12,000 characters. `orderDiffForReview` (ADR-0034) puts code first, then tests, then documentation, so prose and tests are cut before code. A large enough PR still loses code.

When the diff is cut, the model is told `diff_truncated: true` and must say so in its review. It is not stopped from answering `APPROVED`. `decideVerdict` (ADR-0026) then turns that answer into `APPROVE` and the `review-approved` label, for code that no model read. #194 was approved with the note "the diff view is truncated; only the visible hunks were reviewed". In that case only tests and the CHANGELOG were cut, but nothing would have changed if code had been.

## Decision

`buildReviewPrompt` also returns `unreviewedCodeFiles`: the files of the first tier of `orderDiffForReview` (not a test, not documentation, per `change_classifier.mjs`) whose diff was not put in the prompt in full. `findUnreviewedCodeFiles(fullDiff, shownDiff)` computes the list. It relies on the shown diff being a prefix of the filtered, ordered diff, which is how both the budget cut and the 12k cap work.

`withholdOnUnreviewedCode(decision, unreviewedCodeFiles)` runs after `decideVerdict`:

| Decision from `decideVerdict` | Code cut | Final verdict |
|---|---|---|
| `APPROVE` | yes | **`WITHHELD`**, reason `code cut from the reviewed diff: <files>` |
| `APPROVE` | no (nothing cut, or only tests / docs) | `APPROVE` |
| `REQUEST_CHANGES` / `WITHHELD` | any | unchanged |

`WITHHELD` takes the ADR-0026 path. The review is submitted as `COMMENT` with the `review-withheld` label, and auto-fix is not triggered. The note in the comment names the files. `review.verdict` gains `unreviewed_code_files` (a count).

The `review` eval suite applies the same rule, so the eval keeps measuring the production code path (ADR-0027). On the current dataset no case has code cut: only `truncated-diff-visible-bug` is truncated, and its code is shown in full. Scores are unchanged.

## Alternatives Considered

**Include tests in the rule.** A cut test hunk can hide a weak assertion; on #194 a behavior claimed in the PR body had no test, and the model could not see it. But tests are also run by the tool evidence (ADR-0024), and on Groq most medium PRs lose some test lines: the rule would withhold almost every one of them and become noise. Rejected for now.

**Force `REQUEST_CHANGES`.** Auto-fix cannot make a PR smaller or the budget larger, so it would spend attempts on a problem it cannot fix. Rejected for the same reason as in ADR-0026.

**Raise the budget instead.** That is the provider choice (ADR-0032, #199) and does not remove the case: the Anthropic path still caps the diff at 12,000 characters. Complementary, not a substitute.

**Prompt rule only (do not approve a truncated diff).** It already exists in the classification context and was not followed on #194. A rule in code cannot be ignored by the model.

## Consequences

- ✅ An `APPROVE` now means the model was shown every code hunk of the PR.
- ✅ No auto-fix attempt is spent: the PR waits for a human under `review-withheld`.
- ⚠️ On Groq, a large PR can no longer be approved by the pipeline. It needs a human review, a split, or the Anthropic provider. This is the intended trade.
- ⚠️ `WITHHELD` never dedups (ADR-0028). A head can be reviewed twice (`push` and `pull_request: opened`) with the same truncation and the same result, which costs one more LLM call per head on a large PR.
- ⚠️ Tests and documentation cut from the diff still do not block approval (see Alternatives).

## Amendment (2026-10-17): cut on line boundaries, cut marker, no REQUEST_CHANGES on unseen code

On #219 the review asked for changes twice on content it had not seen. On head `c00e670` it raised a High "broken workflow syntax, stray `- n`" in `.github/workflows/test.yml`: the line was `- name: Check trace_context coverage (≥80%)`, cut mid-token. On head `d7aa937` it raised a Medium "`otlp_trace.mjs` added without a c8 step": the step was in the cut hunks. Both cuts were character-level: `filterDiff`'s 12,000-char cap (`.slice(0, maxChars)`) and `fitReviewPrompt`'s budget cut (`text.slice(0, …)`) stopped anywhere, inside a line or right after a hunk header. Nothing marked the end, so a cut line read as content. Both findings broke rules that already existed: ADR-0034 A (a concern about unseen content is not a finding) and this ADR (a cut diff with code files cannot be approved, but it could still be "rejected"). Each sent auto-fix an attempt it could not use, since `test.yml` is a withheld file (ADR-0029), and the PR went `needs-human`.

- **Cut on boundaries** (`cutDiffAtBoundary`, `scripts/lib/file_filters.mjs`; used by `filterDiff` and `fitReviewPrompt`). The shown diff is a prefix of whole lines of the filtered, ordered diff. It never ends inside a line, and never on a file header or `@@` line with nothing under it. A header block with no hunk (binary file, rename) is a whole unit. The cut prefers a hunk boundary while that keeps at least half of what a line boundary would keep (`HUNK_CUT_MIN_RATIO`); below that, one huge hunk would hide most of the budget, so the cut falls between two lines of it. A line longer than the whole budget is dropped whole. `fitReviewPrompt` always re-cuts the full diff to a shrinking char budget, so cuts never stack.
- **Cut marker.** The last kept line is followed by `… [diff cut: N more lines not shown, in <files>]`. `N` counts the lines left out. The files are those with lines left out, in diff order, a file with some of its lines shown marked `(partly shown)`, at most 5 named, then `K more files`. The marker counts toward the budget (the shown diff plus the marker fit `maxChars`). If not even the marker fits, the diff is empty. `stripDiffCutMarker` removes it, so `findUnreviewedCodeFiles` still compares a prefix of the full diff. A code file that is only partly shown still counts as unreviewed. The order (code → tests → docs, ADR-0034 D) and the context-line cut (#188, which marks itself) are unchanged.
- **Prompt** (`prompts/pr-review-system.md`, the ADR-0034 A paragraph, tightened rather than repeated). With `diff_truncated: true`, everything after the marker is unseen, and so is the rest of a "partly shown" file. A syntax error or a "missing X" claim about the last lines before the marker, or about a file the marker names, is a "Not verified" note: at most a Low "verify", never Medium or High, never REQUEST_CHANGES. +74 tokens, review headroom 3381 of 6300 (54%, ADR-0037).
- **Backstop in code** (`withholdOnUnreviewedCode(decision, unreviewedCodeFiles, review)`, third parameter optional). A model REQUEST_CHANGES becomes `WITHHELD` when code was cut and every finding cites only cut code files. A REQUEST_CHANGES is never withheld when a check of the tool evidence failed (`checksFailed`): `decideVerdict` gives a model REQUEST_CHANGES no `reason` even then, and the FAIL finding cites paths from the output tail (#220 review). `findingCitedFiles(review)` reads every top-level bullet of the Issues Found section (`- **High** …`, `- [Medium] …`, `1. **Low** …`, ``- `path:12` — **High** …``; indented lines and sub-bullets continue it) and its path-like tokens. A token cites a cut file when it equals that file or is a suffix of it after a `/` (`test.yml` → `.github/workflows/test.yml`), and names no file of `shownFiles` (returned by `buildReviewPrompt`): a bare `utils.mjs` with `scripts/utils.mjs` shown and `scripts/lib/utils.mjs` cut is ambiguous and keeps the REQUEST_CHANGES. A bullet that is not a finding (`- Fix: …`) counts as a finding with no cut file, which keeps it too. The parse fails safe: a finding with no file, a file that was shown, any token that names no cut file, or no finding at all keeps the REQUEST_CHANGES. A parsing miss leaves the verdict as it was before this amendment, never more lenient. Reason: `every finding cites only code cut from the reviewed diff: <files>`. The review comment gets a "Changes not requested" note. `review-withheld` is applied and auto-fix is not triggered, as for an approval withheld here. The `review` eval suite passes the review text too.
- **Eval cases** (`source: "PR #219"`): `incident-cut-mid-step-name` (the `c00e670` shape, the old cut ending in `- nam`) and `incident-missing-step-in-cut` (the `d7aa937` shape, the old cut ending before the second c8 step). Both expect `WITHHELD`. They are gated and pinned; review floor 27 → 29. The two recorded false REQUEST_CHANGES are in the replay fixture: the backstop turns them into `WITHHELD`, and their High / Medium finding still scores `no_false_alarm` 0. A replay cannot measure the prompt rule; a live run does.

A partly shown code file counts as cut, so a correct finding on a *visible* hunk of that file is withheld too: it never approves, but the PR loses the auto-fix round and waits for a human. Accepted: telling a visible hunk from a cut one would need line numbers from the model.

Not covered: a REQUEST_CHANGES that mixes one finding on unseen content with one on a shown file stays REQUEST_CHANGES. The findings are not split, and the shown one may be real. A finding that cites only a shown file but is really about a cut hunk (`otlp_trace.mjs` shown, its c8 step cut) is not caught by the backstop either; only the prompt rule covers it. `WITHHELD` never dedups (ADR-0028), so a cut PR whose review would have been a false REQUEST_CHANGES is now re-reviewed on each trigger of the same head, the same cost as a withheld approval.

## Amendment (2026-10-19): provider-aware diff cap, provider-independent eval cases

Review evals on Anthropic (runs 38994398984 Opus ×3, 39039845652 Sonnet ×3, 39000563980 Opus ×1) reported "diff cut" on 17% of runs, and the same incident cases failed on both models. Recomputing `buildReviewPrompt` offline for each provider (no LLM call) showed why:

- The 12,000-char cap was never applied to Groq: with a budget, `buildReviewPrompt` fits the uncapped filtered diff to `review_max_input_tokens`. It applied only to the provider with no budget, Anthropic, which has a 1M context and no TPM cap (ADR-0032). The 17% is exactly the 5 of 30 cases over 12,000 chars.
- Under that cap the cut fell elsewhere than under the Groq budget. On `incident-cut-mid-step-name` and `incident-missing-step-in-cut` (#219) Anthropic was shown `test.yml` whole, its c8 steps included, and lost other files instead: the incident the case reproduces (a finding on the cut part of `test.yml`) did not happen, and the expected `WITHHELD` depended on which provider ran it. On `incident-finding-on-cut-hunks` and `incident-clean-code-cut` both cuts had the same shape (workflow whole, tests partly shown, docs not shown; the same code file cut). `incident-stale-refs-shared-phrasing` is not cut on either provider.

**Decision.**

- **Diff cap by provider.** A provider with an input budget (Groq) keeps it as its only diff bound. A provider without one (Anthropic) cuts the filtered diff past `anthropic_review_max_diff_chars` (`config/models.yaml`, default 200,000 when absent, `reviewMaxDiffChars` in `scripts/lib/config.mjs`). 200,000 chars ≈ 50k estimated tokens: 5% of the 1M context, ≤ $0.20 of input per review on `claude-opus-5-5` ($4/MTok), ≤ $0.10 on `claude-sonnet-5-5` ($2/MTok). When it triggers, the cut is the one of the amendment above (`cutDiffAtBoundary`: whole lines, hunk boundary preferred, `… [diff cut: …]` marker) and the withheld rules of this ADR apply unchanged. `buildReviewPrompt` takes the cap as an optional `maxDiffChars` (ignored with a budget; 12,000 when omitted, for a caller that resolves none). `pr_review.mjs` passes `reviewMaxDiffChars(provider)` from its `loadLLMConfig('review')`.
- **Eval cases that need a cut declare it.** A case whose expectation holds only on a cut diff (`WITHHELD` for cut code, no finding past the cut, a truncation note) carries `"requires_cut": true` at case level. The field is outside `input`, so the ADR-0031 input pins are unchanged. The `review` suite (`reviewDiffLimits`) cuts such a case with the stage provider's eval cut in `config/models.yaml`: `review_eval_cut_<provider>_max_input_tokens` (token budget fit) or `review_eval_cut_<provider>_max_diff_chars` (char cap), one of the two (`requiresCutLimits`). Without either key the provider's production limits apply, and a `requires_cut` case they leave whole is an errored run (no LLM call), never a verdict scored against an expectation that does not hold. Shipped: 6300 tokens on both providers, the Groq production budget, so both see the incidents' own cut. Production never reads these keys. Any other case gets production's limits for the stage provider. The 5 `truncated` / `budget-cut` cases carry it, and `eval_suites.test.mjs` fails when the tags and the field disagree, when, with the shipped config, a `requires_cut` case is not cut identically on Groq and Anthropic, or when any other case is cut on either. The harness passes the whole case to `run` (`{ llm, testCase }`). No case is deleted, relabelled or loosened. No uncut variant is added: the uncut diffs of these cases (13.9k–37.7k chars) are over the Groq budget, so such a case could not run uncut on the production primary.
- **Parity.** Without `requires_cut`, the suite's limits equal those `pr_review.mjs` derives from `loadLLMConfig('review')`, on each provider; both pass `maxDiffChars` to `buildReviewPrompt` (field parity test of #217/#218).

**Consequences.**

- ✅ On Anthropic a PR up to 200,000 diff chars is reviewed whole: no withheld approval for code the model was not shown.
- ✅ A review case means the same on any provider; with the shipped config, an Anthropic failure on a `requires_cut` case is a model or prompt result on the same cut Groq sees, never a different cut. The cut is per provider and configurable (e.g. `review_eval_cut_anthropic_max_diff_chars: 12000` to measure Anthropic on a char cap), and a setting that leaves a case whole errors the run instead of skewing the score.
- ⚠️ With the shipped config the 5 `requires_cut` cases do not measure Anthropic's production limits (diffs up to 200,000 chars whole): the other 25 cases and the `pr_review` Anthropic tests cover that path (Codex review on #227).
- ⚠️ "Diff cut" on an Anthropic eval run now counts the `requires_cut` cases (5 of 30, 17%): forced by the dataset, not budget pressure. In production it counts only PRs over the cap.
- ⚠️ An Anthropic primary with a Groq fallback: a prompt over the Groq budget skips the fallback (`over_input_budget`, ADR-0032) instead of sending it. A 12,000-char diff already left little room under 6,300 tokens.
- Not changed: the withheld logic, the cut and the marker, the Groq budget, the prompt.

## Amendment (2026-10-25): agent-rule files are code for the review (audit F13)

`AGENTS.md`, `CLAUDE.md` and everything under `.claude/` change what an agent does, but the `.md` ones were classified as documentation: reviewed last, and never counted as unreviewed code when a cut diff hid them. `isAgentRuleFile` (`change_classifier.mjs`) puts them in the code tier of `orderDiffForReview`, so they are reviewed first and an approval is withheld when the cut leaves one unseen. `classifyChangedFiles` is unchanged: a PR that only edits agent rules still expects no tests. Cut test files stay out of the withheld set, as decided above. Matching ignores case, so `docs/agents.md` is also reviewed as code: conservative, no other effect.
