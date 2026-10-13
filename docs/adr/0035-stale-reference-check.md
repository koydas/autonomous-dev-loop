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
