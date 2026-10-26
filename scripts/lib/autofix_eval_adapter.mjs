// The model phase of the `autofix` eval suite (EV-03, ADR-0052): the stage's production path from a review's feedback to
// a checked patch, on a fixture tree. It reuses the stage's own code (autofix_core: budget, context, parser, write
// guard; the production prompts; hasNoProposedChanges; validateAiOutput) so what is scored is what production runs.
// It calls the injected `llm`, makes no GitHub call and never writes or applies the patch: the grader job does that,
// on a copy of the fixture, from the artifact this returns (`schema_version`, `changes`, as eval_grader validates it).
// Not covered here, on purpose: lessons (ADR-0051: they change with the runs of the day, an eval must be repeatable)
// and the write-time symlink check of `writeGeneratedFiles` (the tree reader already refuses a symlinked target).

import { loadPrompt } from './prompts.mjs';
import { estimateTokens } from './metrics.mjs';
import { validateAiOutput, GuardrailError } from './output_writer.mjs';
import { hasNoProposedChanges } from './review_marker.mjs';
import { guardrailRules } from './static_verifier.mjs';
import { MODEL_OUTPUT_SCHEMA_VERSION } from './eval_grader.mjs';
import {
  resolveBudgetRatios,
  fitAutofixBudget,
  buildAutofixContext,
  parseAutofixResponse,
  findAutofixViolations,
  findShrinkViolations,
} from './autofix_core.mjs';

/** What the model's answer came to, through the stage's own checks. Only `PATCH` is graded by running tests. */
export const AUTOFIX_STATUS = Object.freeze({
  PATCH: 'PATCH', // a patch that passed every guard: the grader applies it
  NO_CHANGES: 'NO_CHANGES', // `changes: []`: the model declined or found nothing (production escalates to a human)
  GUARD_REJECTED: 'GUARD_REJECTED', // the write guard, the static rules or the shrink guard refused it
  INVALID_ANSWER: 'INVALID_ANSWER', // JSON, but not a usable answer (no summary, no changes, duplicate path, too many)
  UNPARSEABLE: 'UNPARSEABLE', // not JSON, or JSON that is not an object
});

// Model text lands in a PR comment in production: one line, bounded. The eval keeps the same bound.
const oneLine = (text, max) => String(text).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @param {object} args
 * @param {{ feedback: string | string[], diff: string }} args.input the review feedback and the PR diff (unified)
 * @param {string} args.root the fixture tree the diff applies to (production: the PR checkout)
 * @param {(call: { prompt: string, systemPrompt: string }) => Promise<string>} args.llm
 * @param {{ provider: string, model: string, maxTokens?: number, maxInputTokens?: number | null, diffRatio?: number, feedbackRatio?: number }} args.config
 *   the stage's loadLLMConfig('autofix') fields that shape the prompt
 * @param {{ system: string, user: string }} [args.prompts] the production prompts unless a test passes its own
 * @returns {Promise<object>} the model-phase artifact: `{ schema_version, status, summary, blocked_reason, rules, violations, changes, … }`
 */
export async function runAutofixModelPhase({ input, root, llm, config, prompts }) {
  if (!input || typeof input.diff !== 'string') throw new Error('autofix eval input.diff must be a string');
  const feedbackParts = (Array.isArray(input.feedback) ? input.feedback : [input.feedback]).filter((part) => typeof part === 'string' && part.trim());
  const systemPrompt = prompts?.system ?? loadPrompt('auto-fix-system');
  const userPromptTemplate = prompts?.user ?? loadPrompt('auto-fix-user');

  const ratios = resolveBudgetRatios({ diffRatio: config.diffRatio, feedbackRatio: config.feedbackRatio });
  const budgets = fitAutofixBudget({
    provider: config.provider,
    model: config.model,
    systemTokens: estimateTokens(systemPrompt),
    userWrapperTokens: estimateTokens(userPromptTemplate.replace(/\{\{[^}]+\}\}/g, '')),
    maxOutputBudget: config.maxTokens ?? 4096,
    maxInputTokens: config.maxInputTokens ?? null,
    ...ratios,
  });
  const context = await buildAutofixContext({ root, userPromptTemplate, feedbackParts, rawDiff: input.diff, budgets });

  const raw = await llm({ prompt: context.userPrompt, systemPrompt });

  const base = {
    schema_version: MODEL_OUTPUT_SCHEMA_VERSION,
    summary: '',
    blocked_reason: null,
    rules: [],
    violations: [],
    changes: [],
    shown_paths: [...context.shownPaths],
    hidden_paths: [...context.hiddenPaths],
    budget_cuts: context.budgetCuts,
    input_tokens_est: estimateTokens(systemPrompt + context.userPrompt),
  };

  let aiOutput;
  try {
    aiOutput = parseAutofixResponse(raw);
  } catch (err) {
    return { ...base, status: AUTOFIX_STATUS.UNPARSEABLE, reason: err.kind };
  }

  if (hasNoProposedChanges(aiOutput)) {
    return { ...base, status: AUTOFIX_STATUS.NO_CHANGES, summary: oneLine(aiOutput.summary ?? '', 500), blocked_reason: oneLine(aiOutput.blocked_reason || aiOutput.summary || '(no summary)', 500) };
  }

  let validated;
  try {
    validated = validateAiOutput(aiOutput);
  } catch (err) {
    if (err instanceof GuardrailError) {
      return { ...base, status: AUTOFIX_STATUS.GUARD_REJECTED, rules: guardrailRules(err), violations: [{ targetPath: null, rule: guardrailRules(err)[0], reason: oneLine(err.message, 2000) }] };
    }
    return { ...base, status: AUTOFIX_STATUS.INVALID_ANSWER, reason: oneLine(err.message, 500) };
  }

  // Production order: the static rules throw before anything is written; the shrink guard runs at write time, so it
  // only speaks for a patch the static rules let through.
  const staticViolations = findAutofixViolations({ changes: validated.changes, context, root, mentionText: context.reviewFeedback });
  const violations = staticViolations.length ? staticViolations : findShrinkViolations({ changes: validated.changes, root });
  if (violations.length) {
    return { ...base, status: AUTOFIX_STATUS.GUARD_REJECTED, summary: validated.summary, rules: [...new Set(violations.map((v) => v.rule))], violations: violations.map(({ targetPath, rule, reason }) => ({ targetPath, rule, reason: oneLine(reason, 2000) })) };
  }
  return {
    ...base,
    status: AUTOFIX_STATUS.PATCH,
    summary: validated.summary,
    changes: validated.changes.map(({ targetPath, fileContent }) => ({ targetPath, content: fileContent })),
  };
}
