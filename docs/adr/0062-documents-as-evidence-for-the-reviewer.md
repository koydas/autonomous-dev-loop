# ADR-0062: Documents that mention what the diff changes are a source of evidence for the reviewer

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

[ADR-0061](./0061-evidence-for-findings-outside-the-diff.md) lets a finding concern text outside the diff when it quotes that text, and the quote is checked in code. The only text the reviewer is shown outside the diff comes from the Impact analysis ([ADR-0058](./0058-impact-analysis-for-the-reviewer.md)): callers and tests of the exports a diff changes. A document that the change makes false (PR #279: a document still describing the old behavior of a file the PR edited) has no source, so nothing can be quoted and the incident case `incident-docs-contradict-new-behavior` stayed out of reach, as ADR-0061 recorded.

## Decision

1. **A second source, the same contract.** `doc_mentions.mjs` searches the repository's documents (`docs/**/*.md`, `.claude/skills/**/*.md`, `AGENTS.md`, the root `README.md`) for what the diff changes: the exports it changes or removes and the files it modifies, renames or deletes (by old path). The lines it finds reach the prompt in a `## Documents that mention what this diff changes` block, and a finding about one quotes it with `Evidence: path:line "exact text"`. Nothing else changes in ADR-0061: the quote is looked up in the PR tree, an unproven blocking finding withholds the review.
2. **Same bounds, same reader as the Impact analysis.** The listing and the safe reader of [ADR-0023](./0023-trusted-pipeline-execution.md) (no symlink, no file over 1 MiB), the same scan caps, fenced and labelled data in the prompt. The diff's own documents, `CHANGELOG.md` and Superseded or Deprecated ADRs are not evidence: a changelog and a replaced decision describe the past on purpose.
3. **One optional block.** The document lines are kept or dropped with the Impact analysis, after the related ADRs and before the diff or the PR body are shrunk (4,000 characters, 1,200 on a token budget). Search errors skip the block (`review.doc_mentions_error`); `review.doc_mentions` carries counts only.
4. **Text search, not understanding.** A name that appears in a document is a lead, not a contradiction: the model decides whether the line is now false, and a human merges. A term mentioned by 20+ documents is listed partially and marked too generic.

## Alternatives Considered

- **Reuse `stale_refs`.** It finds removed text still quoted verbatim in documents (ADR-0035); a document made false by an edit shares no removed line with the diff, which is the #279 shape.
- **Search every changed identifier, including those of removed lines.** More recall and far more noise (local names, words); the exports and files a document can name are the high-precision part. Widening the terms is a measured follow-up, not a default.
- **Put the document lines into the Impact analysis.** One block and one budget, at the price of mixing code references with prose and of changing a module whose output shape the `review` suite pins.
- **Let the model read the documents itself.** The reviewer has no tools; a block is what it can be given, and the quote check needs the exact lines.

## Consequences

- ✅ A document made false by a change can be reported with a quote that is checked in code, and the finding blocks like any proven outside finding.
- ✅ Production and the `review` suite share the contract: a case carries `input.doc_mentions`, the lookup for quotes includes it.
- ⚠️ A document that merely names an export is a weak lead; the prompt grows by about 80 tokens (ADR-0037 budget report applies) and the block by up to 4,000 characters when documents mention the change.
- ⚠️ Terms are exports and files only: a document made false by a change to a constant's value, a label or a config key is not found.
- ⚠️ `incident-docs-contradict-new-behavior` carries its two document lines and stays `known-gap` until a live run shows the review quotes them.
