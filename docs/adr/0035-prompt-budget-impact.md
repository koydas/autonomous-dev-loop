# ADR-0035: Prompt budget impact as review evidence

- **Date:** 2026-10-12
- **Status:** Accepted

## Context

On PR #186, `prompts/pr-review-system.md` grew by about 1,130 chars (~280 tokens). `pr_review.mjs` counts the system prompt in `review_max_input_tokens: 6300` (Groq, ADR-0028), so the reviewed diff lost about 280 tokens of room. The reviewer only sees the diff and cannot work this out: it would need the base and head sizes of every prompt of the stage and the budget in `config/models.yaml`.

## Decision

New pure module `scripts/lib/prompt_budget.mjs`. `computePromptBudgetImpact({ rawDiff, readBase, readHead, models })` returns, for each top-level `prompts/*.md` the diff changes and each stage that loads it:

`{ prompt, stage, budget, deltaTokens, headTokens, maxInputTokens, headroomTokens, lowHeadroom }`

- **Tokens:** `estimateTokens` (`scripts/lib/metrics.mjs`) of the content without `{{placeholders}}`, which are replaced at runtime. `deltaTokens = head − base`. A new file (`new file mode`) has no base and readBase is not called; a deleted file counts 0 on the head side.
- **Mapping** (`PROMPT_STAGES`, from the `loadPrompt` calls in `scripts/`):

  | Stage | Prompts | Budget |
  |---|---|---|
  | validation | `validation-system.md`, `validation-user.md` | input |
  | generation | `generation-system.md`, `generation-user.md` | input |
  | review | `pr-review-system.md`, `pr-review-user.md` | input |
  | autofix | `auto-fix-user.md` | input |
  | autofix | `auto-fix-system.md` | TPM |

  A prompt maps to a list of stages, so a prompt shared by several stages gets one entry per stage (none is shared today). A prompt no stage loads gets `stage: null`.
- **Budget:**
  - *input:* `<stage>_max_input_tokens`.
  - *TPM:* `auto-fix-system.md` is not part of `autofix_max_input_tokens`; it comes on top of it inside the 8K TPM window (`config/models.yaml`). Its budget is the largest estimated input the window allows, `floor((8000 − autofix_max_tokens) / 1.10)`, and the user-prompt budget is reserved out of it.
  - Unset or invalid budget values give `maxInputTokens: null`.
- **Headroom:** budget minus the head tokens of every prompt of the stage under the same budget (minus the reserve for TPM). It ignores contexts injected at runtime (classification, evidence, stale references, …), so it is an upper bound on the room left for the variable input. `lowHeadroom` is true under `LOW_HEADROOM_RATIO` (10%) of the budget.
- **Entrypoint:** `pr_review.mjs` reads the base side with `execFileSync('git', ['show', `${mergeBase}:${path}`])`, an argument array with no shell. The merge base of the PR's base and head SHAs, both validated as commit SHAs, matches GitHub's `base...head` diff; when `git merge-base` fails it falls back to the base SHA. The head side and `config/models.yaml` come from the PR tree, read as data (ADR-0023), with the trusted defaults when the PR tree has no `config/models.yaml`. The review job's checkout uses `fetch-depth: 0` so the base commit exists.
- **Evidence, not verdict:** following the `review_evidence.mjs` pattern, the result is a `## Prompt budget impact` block in the user prompt (`buildReviewPrompt` optional `promptBudgetContext`) and a `### 📏 Prompt Budget Impact` table in the review comment, with ⚠️ on low headroom. `decideVerdict` does not read it.
- **Failure:** a read error (unknown base SHA, missing commit) logs a `review.prompt_budget_error` warn event and yields no block.

## Alternatives Considered

**Fetch the base content through the GitHub contents API.** It works on a shallow checkout but adds one API call per prompt and another failure mode, while the job already has the repository. Rejected for `git show` on a full-history checkout.

**Fail or block the review when headroom is low.** The budget is enforced at runtime already (`fitReviewPrompt`, `assertInputBudget`), and a smaller diff budget can be a deliberate trade. Rejected: informational only.

**Exact token counts with the model's tokenizer.** It needs a dependency per provider. chars/4 is what the budgets in `config/models.yaml` are written against (ADR-0028), so the estimate is the right unit here.

## Consequences

- ✅ A prompt change shows its cost in the review: #186 reports `pr-review-system.md` +283 tokens, 3,889 tokens of review headroom.
- ✅ Current state made visible: `auto-fix-system.md` has 55 tokens left in the autofix TPM window, so any growth needs a smaller `autofix_max_input_tokens`.
- ⚠️ `PROMPT_STAGES` must follow the `loadPrompt` calls. `prompt_budget.test.mjs` fails when a `prompts/*.md` file is missing from the map, or a mapped stage has no budget in `config/models.yaml`. Which stage loads the file is still checked by hand.
- ⚠️ `fetch-depth: 0` makes the review checkout fetch the full history: slower on a large repository.
- ⚠️ Headroom is an upper bound (runtime contexts not counted).
