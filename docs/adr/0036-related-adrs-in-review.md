# ADR-0036: Related ADRs in the review prompt, first to give way on the token budget

- **Date:** 2026-10-12
- **Status:** Accepted

## Context

On PR #186 the reviewer could not know that ADR-0012 sets the gate (c) policy the PR relaxes, although ADR-0012 names `prompts/pr-review-system.md`, a file the PR changes. Recorded decisions are the main source of "why" in this repository, and the reviewer never sees them. On Groq the whole review request must fit `review_max_input_tokens: 6300` (ADR-0028), so any new context competes with the diff.

## Decision

New pure module `scripts/lib/related_adrs.mjs`. `findRelatedAdrs({ rawDiff, listFiles, readFile })` returns `[{ id, title, status, decisionExcerpt }]`:

- **Citation:** an ADR (`docs/adr/NNNN-*.md`) is related when it mentions a path the diff changes, either the exact repo-relative path or its basename when that basename is unique in the repo. A path or basename only matches as a whole token (`review.mjs` does not match `pr_review.mjs`). `CHANGELOG.md` is not counted: the changelog gate makes most PRs touch it. ADRs the diff itself changes are skipped, since their content is already in the diff.
- **Status:** Superseded or Deprecated ADRs are skipped. When one names its successor (`Superseded by ADR-NNNN`), the successor takes its place, unless the successor is itself inactive, missing or changed by the diff.
- **Ranking:** compared in order:
  1. number of changed non-test paths cited (an ADR governs behavior; tests only enforce it);
  2. number of changed paths cited;
  3. number of those cited by exact path (stronger than a basename);
  4. most recent ADR.

  The first rule and the test/exact-path refinements go beyond "most paths cited, then most recent". On #186's diff, measured against the tree before #186 merged, the plain rule ranks ADR-0012 last of ten: nine other ADRs cite the test file `workflow_gates.test.mjs` or `CHANGELOG.md`. With the refinements it ranks second, behind ADR-0027, which cites both the prompt and the test file.
- **Excerpt:** the start of the `## Decision` section, whitespace collapsed, cut to 400 chars with `…`.
- **Prompt:** `buildReviewPrompt` takes an optional `relatedAdrs` array (and an optional `staleRefsContext` string, ADR-0035). It renders a `## Related ADRs` block after the other contexts and before the tool evidence, following the `dependencyManifestContext` pattern. No new placeholder in `prompts/pr-review-user.md`.
- **Budget:** the block is the first thing dropped.
  - Without a budget (Anthropic): up to 3 ADRs.
  - With a budget (Groq): at most 1 ADR, and only when the prompt fits with the diff and the PR body uncut. Otherwise the prompt is fitted without the block, so the PR body and the diff are only shrunk once no ADR is left.
  - `buildReviewPrompt` also returns `adrCount`; `pr_review.mjs` logs when ADRs were left out.
- **Failure:** a listing or read error logs a `review.related_adrs_error` warn event and yields no ADR.

## Alternatives Considered

**Let `fitReviewPrompt` cut the ADR block like the diff.** A half-cut decision excerpt is worse than none, and it adds a third shrink stage to a function that has to stay predictable under the 8K TPM window. Rejected: whole block in or out, decided before fitting.

**Embed ADRs for semantic retrieval.** Needs an embedding model or dependency, and is non-deterministic. Path citation is enough for the decisions this repo records, since they name their files. Rejected.

**Include every related ADR on Anthropic.** It dilutes the prompt; the reviewer needs the governing decision, not the whole history. Capped at 3.

## Consequences

- ✅ The reviewer sees the decision behind the files a PR changes, at no Groq diff cost: the block never displaces diff or PR body.
- ✅ Deterministic and testable, with no new dependency.
- ⚠️ On Groq only the top-ranked ADR is shown. For #186 (pre-merge tree) that was ADR-0027, not ADR-0012; the stale-reference check (ADR-0035) covers that case without spending input budget. Since #186, ADR-0012 is Superseded and resolves to ADR-0033.
- ⚠️ Ranking dilutes as more ADRs cite the same file: ADR-0035–0037 cite `prompts/pr-review-system.md` too.
- ⚠️ An ADR that governs a file without naming it, or names it only by a non-unique basename, is not found.
- ⚠️ The `review` eval suite builds the prompt without related ADRs, so evals do not measure the block's effect.
