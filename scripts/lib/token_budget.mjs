import { estimateTokens } from './metrics.mjs';

// Groq free tier: tokens per minute shared by the whole org. One request (input + max_tokens)
// above it is rejected with 413 (ADR-0028).
export const GROQ_TPM_LIMIT = 8000;

// estimateTokens (chars/4) under-estimates real tokens by ~3% (7,283 estimated vs ~7,497 billed
// on run 37174238930): budgets keep a 10% margin on the estimate.
export const TOKEN_ESTIMATE_MARGIN = 1.1;

/** True when `estimatedInputTokens × 1.10 + maxTokens ≤ tpmLimit`. */
export function fitsTpmWindow(estimatedInputTokens, maxTokens, tpmLimit = GROQ_TPM_LIMIT) {
  return estimatedInputTokens * TOKEN_ESTIMATE_MARGIN + maxTokens <= tpmLimit;
}

/**
 * Throws when the estimated input exceeds the stage budget: such a request can only end in a
 * 413, which is now retried as a rate limit, so sending it would burn the job timeout.
 * No budget (Anthropic provider) means no check.
 */
export function assertInputBudget(stage, estimatedInputTokens, maxInputTokens) {
  if (maxInputTokens == null || estimatedInputTokens <= maxInputTokens) return;
  throw new Error(
    `${stage} prompt is ~${estimatedInputTokens} estimated input tokens, over ${stage}_max_input_tokens (${maxInputTokens}) in config/models.yaml: `
    + 'Groq would reject it with 413 (one request > 8K TPM). Shorten the input or raise the budget on a higher Groq tier.',
  );
}

const BODY_TRUNCATION_NOTE = '\n\n…(PR description truncated to fit the token budget)';

function cut(text, overflowTokens) {
  return text.slice(0, Math.max(0, text.length - overflowTokens * 4));
}

/**
 * Shrinks the variable parts of the review prompt until `system + user` fits `maxInputTokens`:
 * the diff first, then the PR body. `buildUserPrompt({ diff, prBody, diffTruncated })` renders
 * the user prompt. Returns `{ userPrompt, diff, prBody, diffTruncated, bodyTruncated }`.
 * Throws when the prompt is still over budget with no diff and no body left.
 * Without a budget (Anthropic provider) the inputs pass through unchanged.
 */
export function fitReviewPrompt({ systemPrompt, buildUserPrompt, diff: fullDiff, prBody: fullBody, maxInputTokens, diffTruncated: alreadyTruncated = false }) {
  let diff = fullDiff;
  let prBody = fullBody;
  let bodyChars = fullBody.length;
  const render = () => {
    const diffTruncated = alreadyTruncated || diff.length < fullDiff.length;
    return { userPrompt: buildUserPrompt({ diff, prBody, diffTruncated }), diffTruncated };
  };
  let current = render();
  if (maxInputTokens == null) return { ...current, diff, prBody, bodyTruncated: false };

  // chars/4 is linear, so one cut usually fits; the loop absorbs the rounding and the
  // diff_truncated flag flipping in the rendered context.
  for (;;) {
    const overflow = estimateTokens(systemPrompt + current.userPrompt) - maxInputTokens;
    if (overflow <= 0) break;
    if (diff.length > 0) {
      diff = cut(diff, overflow);
    } else if (bodyChars > 0) {
      // The first cut also makes room for the truncation note it appends.
      const noteChars = prBody === fullBody ? BODY_TRUNCATION_NOTE.length : 0;
      bodyChars = Math.max(0, bodyChars - overflow * 4 - noteChars);
      prBody = bodyChars > 0 ? `${fullBody.slice(0, bodyChars)}${BODY_TRUNCATION_NOTE}` : BODY_TRUNCATION_NOTE.trim();
    } else {
      throw new Error(
        `review prompt is ~${estimateTokens(systemPrompt + current.userPrompt)} estimated input tokens with no diff and no PR description left, `
        + `over review_max_input_tokens (${maxInputTokens}) in config/models.yaml: shorten prompts/pr-review-*.md or the injected review contexts. `
        + 'Not sending a request Groq would reject with 413.',
      );
    }
    current = render();
  }
  return { ...current, diff, prBody, bodyTruncated: prBody !== fullBody };
}
