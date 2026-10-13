# Issue #190: blocked, no code change generated

Issue #190 (symlinked `config/models.yaml` aborts `pr_review`; symlink handling untested) cannot be implemented safely in this patch:

- **Blocked by #188.** `readHeadOrNull` and the `lstat` checks in `repoFiles` exist only on #188's branch (`e8a2039`). The issue says not to implement against a `main` that does not contain them.
- **Required files are not available or not allowed.**
  - `scripts/pr_review.mjs` and `scripts/tests/pr_review.test.mjs` are under the protected `scripts/` path. Their content was also withheld from the generation context.
  - `CHANGELOG.md` was withheld from the generation context.

## Planned fix (once #188 is merged and the files are in scope)

1. In `scripts/pr_review.mjs`, change `readHeadOrNull` so a non-regular file (the `is not a regular file` error from `repoFiles.readFile`) returns `null`, like `ENOENT` does.
   - Emit exactly one `warn` event through `scripts/lib/observability.mjs` `log()`.
   - Models then fall back to `GROQ_MODEL_DEFAULTS`.
2. In `scripts/tests/pr_review.test.mjs`, add entrypoint tests. No existing test is removed.
   - A symlinked `config/models.yaml`: the review completes with default budgets and a warn event is emitted.
   - A symlinked `docs/*.md` pointing at content matching a removed block: it is not reported as a stale reference, while a regular file with a real match is still reported.
3. Add a `CHANGELOG.md` entry under `[Unreleased]`.
