import { filterDiff, stripDiffCutMarker } from './file_filters.mjs';
import { interpolatePrompt } from './prompts.mjs';
import { buildAutomationGateContext } from './coverage_checker.mjs';
import { buildChangeClassificationContext, isDocumentationFile, isTestFile } from './change_classifier.mjs';
import { formatEvidenceContext } from './review_evidence.mjs';
import { fitReviewPrompt } from './token_budget.mjs';
import { formatRelatedAdrsContext } from './related_adrs.mjs';

// ADR-0036: related ADRs shown to the reviewer. Groq gets one at most, and only when it fits
// with the diff and the PR body uncut: the block is the first thing dropped.
export const MAX_RELATED_ADRS = 3;
export const MAX_RELATED_ADRS_ON_BUDGET = 1;

// Prompt builder and verdict parser of the PR review stage, shared by pr_review.mjs and the
// `review` eval suite (ADR-0027) so the eval measures the production code path, not a copy.

// Review tiers of orderDiffForReview: -1 no file header, 0 code, 1 tests, 2 documentation.
const CODE_TIER = 0;
const reviewTier = (file) => {
  if (!file) return -1;
  if (isTestFile(file)) return 1;
  if (isDocumentationFile(file)) return 2;
  return CODE_TIER;
};

/**
 * Reorders a unified diff by file for review (ADR-0034): changed code first (scripts, workflows,
 * prompts, config), then tests, then documentation. A diff cut to the token budget then loses
 * prose before it loses the code under review or its tests. Git order is kept within each tier;
 * a leading chunk with no `diff --git` header stays first.
 * @returns {string}
 */
export function orderDiffForReview(rawDiff) {
  const text = String(rawDiff ?? '');
  const trailingNewline = text.endsWith('\n');
  const tier = (chunk) => reviewTier(chunk.match(/^diff --git a\/(.+?) b\//)?.[1]);
  const ordered = text
    .split('\ndiff --git ')
    .map((chunk, index) => ({ chunk: (index ? `diff --git ${chunk}` : chunk).replace(/\n+$/, ''), index }))
    .map((entry) => ({ ...entry, tier: tier(entry.chunk) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ chunk }) => chunk)
    .join('\n');
  return trailingNewline ? `${ordered}\n` : ordered;
}

/**
 * Code files (not a test, not documentation: the first tier of orderDiffForReview) whose diff the
 * reviewer did not see in full (ADR-0038). `shownDiff` is the diff put in the prompt: a prefix of
 * `fullDiff` cut on a line boundary, plus the cut marker line, which is not part of the prefix.
 * A file with only some of its hunks shown counts as unreviewed.
 * @returns {string[]}
 */
export function findUnreviewedCodeFiles(fullDiff, shownDiff) {
  const full = String(fullDiff ?? '').replace(/\n+$/, '');
  const shownLength = stripDiffCutMarker(shownDiff).length;
  if (shownLength >= full.length) return [];
  const headers = [...full.matchAll(/^diff --git a\/(.+?) b\//gm)];
  return headers
    .filter((header, i) => {
      const end = i + 1 < headers.length ? headers[i + 1].index - 1 : full.length;
      return end > shownLength && reviewTier(header[1]) === CODE_TIER;
    })
    .map((header) => header[1]);
}

// Finding bullets of the review's Issues Found section: "- **High** …", "* [Medium] …", "1. **Low** …".
const ISSUES_HEADING = /^\s*(?:#{1,3}\s|\*\*)[^\n]*issues found/i;
const OTHER_HEADING = /^\s*(?:#{1,3}\s|\*\*[^*\n]*(?:verdict|summary|change classification)[^*\n]*\*\*:?\s*$)/i;
const FINDING_BULLET = /^\s*(?:[-*]|\d+[.)])\s*\**\[?\**(?:High|Medium|Low)\b/i;
// A path-like token: `a/b.mjs`, `.github/workflows/test.yml`, `test.yml`. Over-matching ("e.g") is safe:
// a token that names no cut file keeps the finding, and so the REQUEST_CHANGES.
const PATH_TOKEN = /(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z]\w{0,7}\b/g;

/**
 * Files cited by each finding of the review's Issues Found section (#219): one array per finding
 * bullet (its continuation lines included). [] when the section has no finding bullet.
 * @returns {string[][]}
 */
export function findingCitedFiles(review) {
  const findings = [];
  let inIssues = false;
  for (const line of String(review ?? '').split('\n')) {
    if (ISSUES_HEADING.test(line)) inIssues = true;
    else if (OTHER_HEADING.test(line)) inIssues = false;
    else if (inIssues && FINDING_BULLET.test(line)) findings.push([line]);
    else if (inIssues && findings.length) findings.at(-1).push(line);
  }
  return findings.map((lines) => [...new Set(lines.join('\n').match(PATH_TOKEN) ?? [])]);
}

const citesCutFile = (token, files) => files.some((f) => f === token || f.endsWith(`/${token}`));

/**
 * ADR-0038: an APPROVE given on a diff whose code was cut to the budget is withheld (ADR-0026 path:
 * no auto-fix). Amendment (#219): so is a model REQUEST_CHANGES (not one from failing checks) when
 * every finding of `review` cites at least one file and every file it cites was cut: such a finding
 * is about content the model did not see, and the fixer cannot see it either. A finding with no
 * citation, or citing any other file, keeps the REQUEST_CHANGES. Anything else passes through unchanged.
 * @returns {{ verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'WITHHELD', reason: string | null }}
 */
export function withholdOnUnreviewedCode(decision, unreviewedCodeFiles = [], review = '') {
  if (unreviewedCodeFiles.length === 0) return decision;
  if (decision.verdict === 'APPROVE') {
    return { verdict: 'WITHHELD', reason: `code cut from the reviewed diff: ${unreviewedCodeFiles.join(', ')}` };
  }
  if (decision.verdict !== 'REQUEST_CHANGES' || decision.reason != null) return decision;
  const cited = findingCitedFiles(review);
  const onlyUnseen = cited.length > 0 && cited.every((files) => files.length > 0 && files.every((f) => citesCutFile(f, unreviewedCodeFiles)));
  if (!onlyUnseen) return decision;
  return { verdict: 'WITHHELD', reason: `every finding cites only code cut from the reviewed diff: ${unreviewedCodeFiles.join(', ')}` };
}

/** Markdown note appended to the review comment when approval is withheld for unseen code (ADR-0038). */
export function formatUnreviewedCodeNote(unreviewedCodeFiles) {
  return [
    '',
    `> **Approval withheld** — the diff was cut to the token budget, and these code files were not shown to the reviewer in full: ${unreviewedCodeFiles.map((f) => `\`${f}\``).join(', ')}.`,
    '> The model approved what it saw; a human must review the rest. No check failed, so auto-fix is not triggered.',
    '> A full review needs a smaller PR or a provider with a larger input budget (ADR-0032).',
  ].join('\n');
}

/** Markdown note appended to the review comment when a REQUEST_CHANGES on unseen code is withheld (ADR-0038, #219). */
export function formatUnseenFindingsNote(unreviewedCodeFiles) {
  return [
    '',
    `> **Changes not requested** — the diff was cut to the token budget, and every finding above cites only code files the reviewer did not see in full: ${unreviewedCodeFiles.map((f) => `\`${f}\``).join(', ')}.`,
    '> A finding about unseen content cannot be verified, and auto-fix cannot edit what it is not shown: a human must review those files. Auto-fix is not triggered.',
  ].join('\n');
}

/**
 * Renders the review user prompt: diff + PR title/body + classification, automation-gate,
 * dependency-manifest and tool-evidence contexts, fitted to `maxInputTokens` (ADR-0028).
 * Groq (`maxInputTokens` set): the diff is bounded by the token budget. Anthropic (`null`) keeps
 * the 12,000-char cap. `diffTruncated` compares against the uncapped filtered diff, so the reviewer
 * is told when it saw a partial diff. Throws (no LLM call) when the fixed part alone is over budget.
 * Optional `staleRefsContext` (ADR-0035) and `promptBudgetContext` (ADR-0037) are fixed context like the dependency manifest;
 * `relatedAdrs` (ADR-0036) is dropped before the PR body or the diff is shrunk.
 * `unreviewedCodeFiles` (ADR-0038): code files the cut left out, in full or in part.
 * @returns {{ userPrompt: string, diffTruncated: boolean, bodyTruncated: boolean, adrCount: number, unreviewedCodeFiles: string[] }}
 */
export function buildReviewPrompt({ systemPrompt, userPromptTemplate, rawDiff, prTitle, prBody, maxInputTokens, evidence, dependencyManifestContext = '', staleRefsContext = '', promptBudgetContext = '', relatedAdrs = [] }) {
  const orderedDiff = orderDiffForReview(rawDiff);
  const fullDiff = filterDiff(orderedDiff, Infinity);
  const cappedDiff = maxInputTokens == null ? filterDiff(orderedDiff) : fullDiff;
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
  return { userPrompt, diffTruncated, bodyTruncated, adrCount, unreviewedCodeFiles: findUnreviewedCodeFiles(fullDiff, fitted.diff) };
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
