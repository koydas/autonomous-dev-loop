import { filterDiff } from './file_filters.mjs';
import { interpolatePrompt } from './prompts.mjs';
import { buildAutomationGateContext } from './coverage_checker.mjs';
import { buildChangeClassificationContext } from './change_classifier.mjs';
import { formatEvidenceContext } from './review_evidence.mjs';
import { fitReviewPrompt } from './token_budget.mjs';
import { formatRelatedAdrsContext } from './related_adrs.mjs';

// ADR-0034: related ADRs shown to the reviewer. Groq gets one at most, and only when it fits
// with the diff and the PR body uncut: the block is the first thing dropped.
export const MAX_RELATED_ADRS = 3;
export const MAX_RELATED_ADRS_ON_BUDGET = 1;

// Prompt builder and verdict parser of the PR review stage, shared by pr_review.mjs and the
// `review` eval suite (ADR-0027) so the eval measures the production code path, not a copy.

/**
 * Renders the review user prompt: diff + PR title/body + classification, automation-gate,
 * dependency-manifest and tool-evidence contexts, fitted to `maxInputTokens` (ADR-0028).
 * Groq (`maxInputTokens` set): the diff is bounded by the token budget. Anthropic (`null`) keeps
 * the 12,000-char cap. `diffTruncated` compares against the uncapped filtered diff, so the reviewer
 * is told when it saw a partial diff. Throws (no LLM call) when the fixed part alone is over budget.
 * Optional `staleRefsContext` (ADR-0033) and `promptBudgetContext` (ADR-0035) are fixed context like the dependency manifest;
 * `relatedAdrs` (ADR-0034) is dropped before the PR body or the diff is shrunk.
 * @returns {{ userPrompt: string, diffTruncated: boolean, bodyTruncated: boolean, adrCount: number }}
 */
export function buildReviewPrompt({ systemPrompt, userPromptTemplate, rawDiff, prTitle, prBody, maxInputTokens, evidence, dependencyManifestContext = '', staleRefsContext = '', promptBudgetContext = '', relatedAdrs = [] }) {
  const fullDiff = filterDiff(rawDiff, Infinity);
  const cappedDiff = maxInputTokens == null ? filterDiff(rawDiff) : fullDiff;
  const fit = (adrCount) => {
    const reviewContexts = `${buildAutomationGateContext(rawDiff)}${dependencyManifestContext}${staleRefsContext}${promptBudgetContext}${formatRelatedAdrsContext(relatedAdrs, adrCount)}${formatEvidenceContext(evidence)}`;
    return fitReviewPrompt({
      systemPrompt,
      diff: cappedDiff,
      prBody,
      maxInputTokens,
      diffTruncated: cappedDiff.length < fullDiff.length,
      buildUserPrompt: ({ diff, prBody: body, diffTruncated: truncated }) =>
        `${interpolatePrompt(userPromptTemplate, { diff, issueTitle: prTitle, issueBody: body })}${buildChangeClassificationContext(rawDiff, truncated)}${reviewContexts}`,
    });
  };
  let adrCount = Math.min(relatedAdrs.length, maxInputTokens == null ? MAX_RELATED_ADRS : MAX_RELATED_ADRS_ON_BUDGET);
  let fitted = null;
  if (adrCount > 0) {
    try {
      fitted = fit(adrCount);
    } catch {
      fitted = null; // over budget with the ADR block: retried without it below
    }
    if (fitted && (fitted.diff.length < cappedDiff.length || fitted.bodyTruncated)) fitted = null;
  }
  if (!fitted) {
    adrCount = 0;
    fitted = fit(0);
  }
  const { userPrompt, diffTruncated, bodyTruncated } = fitted;
  return { userPrompt, diffTruncated, bodyTruncated, adrCount };
}

/**
 * Extracts the model's verdict from a raw review. `<think>` blocks are stripped first.
 * The heading may come back bold (`**🚀 Verdict**`) instead of `### 🚀 Verdict`: closing `**`
 * after the word is allowed. `verdict` is null when no verdict line is found; pr_review.mjs then
 * fails closed (not approved).
 * @returns {{ cleanReview: string, verdict: 'APPROVED' | 'REQUEST_CHANGES' | null }}
 */
export function parseReviewVerdict(rawReview) {
  const cleanReview = String(rawReview ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const match = cleanReview.match(/verdict\**(?::\**\s*|\s*\n+\s*)\**(APPROVED|REQUEST_CHANGES)/i);
  return { cleanReview, verdict: match ? match[1].toUpperCase() : null };
}
