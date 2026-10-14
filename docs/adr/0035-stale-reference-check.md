# ADR-0035: Deterministic stale-reference check as review evidence

- **Date:** 2026-10-12
- **Status:** Accepted

## Context

The PR reviewer only sees the diff. On PR #186 it missed that `docs/adr/0012-coverage-enforcement-delegation-to-ci.md` (line 18) still quoted, almost word for word, the gate (c) rule the PR removed from `prompts/pr-review-system.md`. Docs drifting from the code is the most common defect class in this repository, and this case does not need an LLM: the removed text is still in the tree, so a text search finds it.

## Decision

New pure module `scripts/lib/stale_refs.mjs`, called by `pr_review.mjs` before the prompt is built.

- **Input:** the raw unified diff, plus injected `listFiles()` (repo-relative paths, `git ls-files` in the PR tree) and `readFile(path)`. The working directory is the PR head checkout, read as data only (ADR-0023). Unit tests never touch the real file system.
- **Removed blocks:** consecutive `-` lines of one hunk, with the file and old-file line of the first one. Normalized: markdown backticks, `*` and `_` stripped, whitespace collapsed, lowercased. Blocks under 60 normalized chars are ignored (too generic to be a quote).
- **Search:** every 60-char window of a block is indexed, then each searched file is scanned for those windows (linear in the size of the docs: ~0.1 s on this repo). A file matches when it contains the block or any 60-char window of it. The reported line is the start of the longest matched run in that file.
- **Searched files:** `docs/**/*.md`, `.claude/skills/**/*.md`, `prompts/*.md`, `AGENTS.md`.
- **Excluded:** `CHANGELOG.md` and Superseded or Deprecated ADRs (both quote replaced rules on purpose), the file the text was removed from, and any file the diff re-adds the text to (a move). An ADR is inactive when its `- **Status:**` line starts with `Superseded` or `Deprecated`.
- **Untrusted tree:** `pr_review.mjs` lists only regular files and refuses to read anything else, so a symlink in the PR (to `/dev/zero`, or out of the tree) is never followed.
- **Output:** `[{ removedText, file, line, foundIn: [{ path, line }] }]`.
- **Evidence, not verdict:** `formatStaleRefsContext` adds a `## Stale references (deterministic text search)` block to the user prompt (after the dependency manifest, before the tool evidence), and `formatStaleRefsSection` adds a `### 🔗 Stale References` section to the review comment. Both cap at 5 hits and quote at most 160 chars per hit, to bound Groq input tokens. `decideVerdict` does not read them: a hit is a lead for the reviewer, who decides whether it is a gate (b) documentation gap.
- **Failure:** a listing or read error logs a `review.stale_refs_error` warn event through `observability.mjs` and yields no hits. The review continues.
- `prompts/pr-review-system.md` is unchanged apart from the gate (c) list: the block explains itself.

## Alternatives Considered

**Ask the LLM to check docs consistency.** It does not see the docs, and putting them in the prompt does not fit the 6,300-token Groq budget. Rejected.

**Exact substring match only.** It misses quotes that rewrap lines, add a bullet or a blockquote marker, or keep only part of the removed sentence (ADR-0012 quotes the rule after a `>`, without the `For gate (c),` prefix). Rejected in favour of 60-char windows.

**Block the verdict on a hit.** A quote can be legitimately historical (an ADR's Context section describing the old state). Rejected: informational evidence only.

## Consequences

- ✅ The #186 miss is caught without an LLM: the regression test runs the real removed line against ADR-0012 as it stood during that review (status `Accepted`) and gets one hit on line 18. ADR-0012 is now Superseded by ADR-0033, so it is no longer searched.
- ✅ No new dependency, no network, bounded prompt cost (≤ 5 lines).
- ⚠️ Text that is only paraphrased (no 60-char run in common) is not found.
- ⚠️ Historical quotes (an ADR's Context) are reported too. The reviewer has to judge them, which is why a hit never changes the verdict.
- ⚠️ The `review` eval suite builds the prompt without this block, so evals do not measure its effect on the reviewer.

## Amendment (2026-10-14): a hit needs removed text the tree no longer holds, and is at most a Low note

On #207 (base `d497433`, reviewed heads `46ee7d2` and `54ec1e5`) the check reported 2 blocks / 6 locations for `prompts/auto-fix-system.md`. Every line of the prompt was reworded, not removed, and each location shared a 61–111-char run of generic phrasing with it: the reworded prompt itself, or `prompts/generation-system.md`, which states the same guardrails on its own. The block told the reviewer a hit "is a documentation gap (gate (b))", the model raised a High "missing documentation update", auto-fix could only touch protected `docs/` paths, and the PR went `needs-human`. Being outside `decideVerdict` did not help: once in the prompt, the model acts on it.

- **Live text.** A 60-char window of a removed block is live when the PR tree still holds it in the head version of the block's source file (a reworded line; its new path on a rename) or in any `prompts/*.md`. Live windows never count toward a hit. Prompts are the rules themselves, so they are a live source and no longer a searched path. Other docs are not: two docs quoting the same removed rule are both stale, and do not keep each other live. This narrows "present anywhere in the head tree" on purpose: code and other files are not read (unbounded size in an untrusted tree, and a rule quoted in code is not what this check is for).
- **Run threshold.** A doc is reported only for a contiguous quote of ≥ `MIN_RUN_CHARS` (100) normalized chars of non-live removed text. A block shorter than that must be quoted whole, give or take `QUOTE_SLACK_CHARS` (10: a `//`, `-` or `>` prefix, end punctuation). The 60-char window stays the index unit.
- **Measured** (`findStaleReferences` on the real diffs and head trees):

  | Variant | #207 at `46ee7d2` | #207 at `54ec1e5` | #186 at `f14dd92` (true positive) |
  |---|---|---|---|
  | Before (60-char window) | 2 blocks / 6 locations | 2 / 6 | 1 / 1 (ADR-0012:18) |
  | Live text only | 1 / 1 (`docs/code-generation.md`, 65-char run) | 0 | 1 / 1 |
  | 100-char run only | 1 / 2 (ADR-0021 111, `generation-system.md` 418) | 1 / 2 | 1 / 1 |
  | 150-char run only | 1 / 1 (`generation-system.md`) | 1 / 1 | 1 / 1 |
  | **Both (adopted)** | **0** | **0** | **1 / 1** (240-char run) |

  Neither filter alone clears #207: the generation prompt shares a 418-char run with the removed guardrails (its own rule, not a quote), and `docs/code-generation.md` keeps a 65-char run nothing else holds. `scripts/tests/stale_refs.test.mjs` pins #207 on a fixture (diff and prompts at `46ee7d2`, excerpts of the four docs around each location) and keeps the #186 test.
- **Prompt.** The `## Stale references` block and `prompts/pr-review-system.md` (+85 tokens; review headroom 3,609 of 6,300, 57%, pinned ≥ `LOW_HEADROOM_RATIO` by the same test) say a hit may yield at most one Low "Verify stale reference" issue, never a Medium or High finding, never a gate (b) finding, never REQUEST_CHANGES. The earlier "it is a documentation gap (gate (b))" wording is gone.
- **Not enforced in code.** The verdict comes from the model's verdict line, and a finding does not say which evidence it rests on: a High "missing documentation update" from a stale hit reads the same as a genuine gate (b) finding (the diff changes behavior, a doc is not updated). Telling them apart means matching finding prose against hit paths, a parser that a rewording defeats in both directions. Not built. The guard is at the source: the block now appears only for removed text the tree no longer holds, which is a rare event, and a false hit costs one Low line at most if the model follows the rule.
- ⚠️ A doc that paraphrases a removed rule while a prompt keeps the same wording for its own purpose is no longer reported.
- ⚠️ A removed block under 100 chars quoted only in part (more than 10 chars missing) is no longer reported.
