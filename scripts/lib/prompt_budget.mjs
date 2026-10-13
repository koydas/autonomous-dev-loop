import { log } from './observability.mjs';
import { estimateTokens } from './metrics.mjs';
import { GROQ_TPM_LIMIT, TOKEN_ESTIMATE_MARGIN } from './token_budget.mjs';

// Prompt budget impact (ADR-0036): token cost of a PR's prompts/*.md changes against each stage's
// input budget in config/models.yaml. Informational review evidence; never a verdict input.

export const LOW_HEADROOM_RATIO = 0.1;

// Which stage loads which prompt (loadPrompt calls in scripts/), and how it is budgeted:
// `input`: inside `<stage>_max_input_tokens` (system + user prompt: validation, generation, review;
//   autofix: user prompt only). `tpm`: on top of it, inside the 8K TPM window (auto-fix-system.md:
//   (system + autofix_max_input_tokens) × 1.10 + autofix_max_tokens ≤ 8000, see config/models.yaml).
export const PROMPT_STAGES = {
  'prompts/validation-system.md': [{ stage: 'validation', budget: 'input' }],
  'prompts/validation-user.md': [{ stage: 'validation', budget: 'input' }],
  'prompts/generation-system.md': [{ stage: 'generation', budget: 'input' }],
  'prompts/generation-user.md': [{ stage: 'generation', budget: 'input' }],
  'prompts/pr-review-system.md': [{ stage: 'review', budget: 'input' }],
  'prompts/pr-review-user.md': [{ stage: 'review', budget: 'input' }],
  'prompts/auto-fix-user.md': [{ stage: 'autofix', budget: 'input' }],
  'prompts/auto-fix-system.md': [{ stage: 'autofix', budget: 'tpm' }],
};

const PROMPT_PATH = /^prompts\/[^/]+\.md$/;

/** Fixed token cost of a prompt: `{{placeholders}}` are replaced at runtime, so they do not count. */
export function promptTokens(content) {
  return estimateTokens(String(content ?? '').replace(/\{\{[^}]+\}\}/g, ''));
}

const positiveInt = (value) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * `<stage>_max_input_tokens` for an `input` prompt. For a `tpm` prompt, the largest estimated input
 * the TPM window allows: floor((8000 − <stage>_max_tokens) / 1.10). null when not configured.
 */
export function stageBudget(models, stage, budget) {
  const maxInput = positiveInt(models?.[`${stage}_max_input_tokens`]);
  if (budget === 'input' || maxInput === null) return { maxInputTokens: maxInput, reserved: 0 };
  const maxTokens = positiveInt(models?.[`${stage}_max_tokens`]);
  if (maxTokens === null) return { maxInputTokens: null, reserved: 0 };
  // The user prompt may use all of <stage>_max_input_tokens: only the rest is left for the system prompt.
  return { maxInputTokens: Math.floor((GROQ_TPM_LIMIT - maxTokens) / TOKEN_ESTIMATE_MARGIN), reserved: maxInput };
}

/**
 * Top-level prompts/*.md files the diff changes, with `added` / `deleted` from the git headers.
 * `basePath` is where the base version lives: the `a/` path, which differs for a renamed file.
 */
export function changedPrompts(rawDiff) {
  return String(rawDiff ?? '')
    .split(/^(?=diff --git )/m)
    .map((chunk) => {
      const [, basePath, path] = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m) ?? [];
      return { path, basePath, added: /^new file mode /m.test(chunk), deleted: /^deleted file mode /m.test(chunk) };
    })
    .filter((p) => p.path && PROMPT_PATH.test(p.path));
}

/**
 * For each changed prompts/*.md and each stage loading it: token delta (head − base), head tokens,
 * the stage budget, and the headroom left once all the stage's prompts under that budget are paid.
 * `readBase(path)` / `readHead(path)` are injected (base: `git show <base>:<path>` in pr_review.mjs).
 * A prompt no stage loads gets `stage: null`. Without a configured budget, `maxInputTokens`,
 * `headroomTokens` are null and `lowHeadroom` false. A read error logs a `review.prompt_budget_error`
 * warn event and returns [].
 * @returns {Array<{ prompt: string, stage: string|null, budget: 'input'|'tpm'|null, deltaTokens: number, headTokens: number,
 *   maxInputTokens: number|null, headroomTokens: number|null, lowHeadroom: boolean }>}
 */
export function computePromptBudgetImpact({
  rawDiff, readBase, readHead, models, promptStages = PROMPT_STAGES, lowHeadroomRatio = LOW_HEADROOM_RATIO, logFn = log,
}) {
  const changed = changedPrompts(rawDiff);
  if (!changed.length) return [];
  // A deleted prompt costs nothing on the head side, wherever it is summed.
  const headCache = new Map(changed.filter((p) => p.deleted).map((p) => [p.path, 0]));
  const head = (p) => {
    if (!headCache.has(p)) headCache.set(p, promptTokens(readHead(p)));
    return headCache.get(p);
  };
  try {
    return changed.flatMap(({ path, basePath, added }) => {
      const headTokens = head(path);
      const deltaTokens = headTokens - (added ? 0 : promptTokens(readBase(basePath)));
      const stages = promptStages[path] ?? [{ stage: null, budget: null }];
      return stages.map(({ stage, budget }) => {
        const { maxInputTokens, reserved } = stage ? stageBudget(models, stage, budget) : { maxInputTokens: null, reserved: 0 };
        let headroomTokens = null;
        if (maxInputTokens !== null) {
          const paid = Object.entries(promptStages)
            .filter(([, list]) => list.some((s) => s.stage === stage && s.budget === budget))
            .reduce((sum, [p]) => sum + (p === path ? headTokens : head(p)), 0);
          headroomTokens = maxInputTokens - reserved - paid;
        }
        const lowHeadroom = headroomTokens !== null && headroomTokens < maxInputTokens * lowHeadroomRatio;
        return { prompt: path, stage, budget, deltaTokens, headTokens, maxInputTokens, headroomTokens, lowHeadroom };
      });
    });
  } catch (err) {
    logFn({ stage: 'review', event: 'review.prompt_budget_error', level: 'warn', meta: { error: err.message } });
    return [];
  }
}

const signed = (n) => (n > 0 ? `+${n}` : String(n));
const budgetLabel = (r) => (r.budget === 'tpm'
  ? `TPM-bounded input ${r.maxInputTokens} (on top of ${r.stage}_max_input_tokens)`
  : `${r.stage}_max_input_tokens ${r.maxInputTokens}`);

function describe(r) {
  const base = `${r.prompt}: ${signed(r.deltaTokens)} tokens (now ${r.headTokens})`;
  if (!r.stage) return `${base} — not loaded by any pipeline stage`;
  if (r.maxInputTokens === null) return `${base} — stage \`${r.stage}\`: no input budget configured`;
  return `${base} — stage \`${r.stage}\`, ${budgetLabel(r)}: ${r.headroomTokens} tokens left for the variable input${r.lowHeadroom ? ' ⚠️ LOW HEADROOM' : ''}`;
}

/** Prompt block for the review (empty without changed prompts). */
export function formatPromptBudgetContext(impacts, { lowHeadroomRatio = LOW_HEADROOM_RATIO } = {}) {
  if (!impacts?.length) return '';
  const lines = [
    '',
    '',
    '## Prompt budget impact (estimated tokens, chars/4)',
    `Informational, computed from the PR tree and config/models.yaml. Every token a stage prompt gains is taken from that stage's variable input (issue, diff, files); headroom ignores the contexts injected at runtime, so it is an upper bound. LOW HEADROOM: under ${Math.round(lowHeadroomRatio * 100)}% of the budget left.`,
    ...impacts.map((r) => `- ${describe(r)}`),
  ];
  return lines.join('\n');
}

/** Review-comment section (empty without changed prompts): informational, not a verdict input. */
export function formatPromptBudgetSection(impacts, { lowHeadroomRatio = LOW_HEADROOM_RATIO } = {}) {
  if (!impacts?.length) return '';
  const lines = ['', '### 📏 Prompt Budget Impact', '| Prompt | Stage | Δ tokens | Prompt tokens | Budget | Headroom |', '|---|---|---|---|---|---|'];
  for (const r of impacts) {
    const budget = r.maxInputTokens === null ? '—' : `${r.maxInputTokens}${r.budget === 'tpm' ? ' (TPM)' : ''}`;
    const headroom = r.headroomTokens === null ? '—' : `${r.headroomTokens}${r.lowHeadroom ? ' ⚠️' : ''}`;
    lines.push(`| \`${r.prompt}\` | ${r.stage ?? '—'} | ${signed(r.deltaTokens)} | ${r.headTokens} | ${budget} | ${headroom} |`);
  }
  if (impacts.some((r) => r.lowHeadroom)) lines.push('', `> ⚠️ Headroom under ${Math.round(lowHeadroomRatio * 100)}% of the stage budget: little room is left for the variable input.`);
  return lines.join('\n');
}
