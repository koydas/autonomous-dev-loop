import { filterDiff, stripDiffCutMarker } from './file_filters.mjs';
import { interpolatePrompt, loadPrompt } from './prompts.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAutomationGateContext } from './coverage_checker.mjs';
import { GATES_CONFIG_PATH, parseGates } from './coverage_gates.mjs';
import { PIPELINE_ROOT } from './roots.mjs';
import { buildChangeClassificationContext, isAgentRuleFile, isDocumentationFile, isTestFile } from './change_classifier.mjs';
import { formatEvidenceContext } from './review_evidence.mjs';
import { fitReviewPrompt } from './token_budget.mjs';
import { formatRelatedAdrsContext } from './related_adrs.mjs';
import { formatImpactContext } from './impact_context.mjs';
import { formatDocMentionsContext } from './doc_mentions.mjs';

// ADR-0036: related ADRs shown to the reviewer. Groq gets one at most, and only when it fits
// with the diff and the PR body uncut: the block is the first thing dropped.
export const MAX_RELATED_ADRS = 3;
export const MAX_RELATED_ADRS_ON_BUDGET = 1;
// Size of the impact analysis block (RV-02): generous when the diff is not token-budgeted (Anthropic), compact on a
// token budget (Groq), where it is also the first optional block kept when the prompt is tight.
export const IMPACT_MAX_CHARS = 8000;
export const IMPACT_MAX_CHARS_ON_BUDGET = 1200;
// Documents that mention what the diff changes (RV-04b): the second half of the same optional block, kept or dropped with it.
export const DOC_MENTIONS_MAX_CHARS = 4000;
export const DOC_MENTIONS_MAX_CHARS_ON_BUDGET = 1200;

// Diff cap without an input budget when the caller passes no maxDiffChars: the former fixed cap, kept for callers
// that do not resolve one (pr_review.mjs and the review suite pass reviewMaxDiffChars).
const UNBUDGETED_MAX_DIFF_CHARS = 12000;

// Prompt builder and verdict parser of the PR review stage, shared by pr_review.mjs and the
// `review` eval suite (ADR-0027) so the eval measures the production code path, not a copy.

// Review tiers of orderDiffForReview: -1 no file header, 0 code (agent-rule files included, ADR-0038 amendment), 1 tests, 2 documentation.
const CODE_TIER = 0;
const reviewTier = (file) => {
  if (!file) return -1;
  if (isAgentRuleFile(file)) return CODE_TIER;
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

// Finding bullets of the review's Issues Found section: every top-level bullet ("- **High** …", "* [Medium] …",
// "1. **Low** …", "- `path:12` — **High** …"); indented lines and sub-bullets continue the bullet above. A bullet
// that is not a finding ("- Fix: …") becomes one with no cut file, which keeps the REQUEST_CHANGES: safe.
const ISSUES_HEADING = /^\s*(?:#{1,3}\s|\*\*)[^\n]*issues found/i;
const OTHER_HEADING = /^\s*(?:#{1,3}\s|\*\*[^*\n]*(?:verdict|summary|change classification)[^*\n]*\*\*:?\s*$)/i;
const FINDING_BULLET = /^ ?(?:[-*]|\d+[.)])\s+/;
// A path-like token: `a/b.mjs`, `.github/workflows/test.yml`, `test.yml`. Over-matching ("e.g") is safe:
// a token that names no cut file keeps the finding, and so the REQUEST_CHANGES.
const PATH_TOKEN = /(?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z]\w{0,7}\b/g;

/** The lines of the review's Issues Found section, up to the next heading (empty when there is none). */
export function issuesFoundText(review) {
  const lines = [];
  let inIssues = false;
  for (const line of String(review ?? '').split('\n')) {
    if (ISSUES_HEADING.test(line)) inIssues = true;
    else if (OTHER_HEADING.test(line)) inIssues = false;
    else if (inIssues) lines.push(line);
  }
  return lines.join('\n');
}

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

// A full path names one file; a bare or partial one (`utils.mjs`) names every file it is a `/`-suffix of.
const names = (token, file) => file === token || file.endsWith(`/${token}`);
// The token names a cut file and no shown one: `utils.mjs` with `scripts/utils.mjs` shown is ambiguous, kept.
const citesOnlyCutFile = (token, cut, shown) => cut.some((f) => names(token, f)) && !shown.some((f) => names(token, f));

/**
 * ADR-0038: an APPROVE given on a diff whose code was cut to the budget is withheld (ADR-0026 path:
 * no auto-fix). Amendment (#219): so is a model REQUEST_CHANGES (not one from failing checks) when
 * every finding of `review` cites at least one file and every file it cites was cut: such a finding
 * is about content the model did not see, and the fixer cannot see it either. A finding with no
 * citation, or citing any other file, keeps the REQUEST_CHANGES. Anything else passes through unchanged.
 * `checksFailed`: a check of the tool evidence failed. decideVerdict returns no reason for a model REQUEST_CHANGES
 * even then, and the FAIL finding cites paths from the output tail, so it is never withheld.
 * `shownFiles`: files of the diff shown in full (buildReviewPrompt), to tell a bare file name apart.
 * @returns {{ verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'WITHHELD', reason: string | null }}
 */
export function withholdOnUnreviewedCode(decision, unreviewedCodeFiles = [], review = '', { checksFailed = false, shownFiles = [] } = {}) {
  if (unreviewedCodeFiles.length === 0) return decision;
  if (decision.verdict === 'APPROVE') {
    return { verdict: 'WITHHELD', reason: `code cut from the reviewed diff: ${unreviewedCodeFiles.join(', ')}` };
  }
  if (decision.verdict !== 'REQUEST_CHANGES' || decision.reason != null || checksFailed) return decision;
  const cited = findingCitedFiles(review);
  const onlyUnseen = cited.length > 0 && cited.every((files) => files.length > 0 && files.every((f) => citesOnlyCutFile(f, unreviewedCodeFiles, shownFiles)));
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

// ADR-0045: the review system prompt is a target-neutral core (prompts/pr-review-system.md) with
// {{repository_rules_N}} placeholders, and the rules written for this repository (automation gates, the
// c8 list) in prompts/pr-review-repo-rules.md, blocks separated by a `<!-- next -->` line. This
// repository gets the rules back in place (byte for byte the prompt it had before the split); any other
// gets the core, then its own guidelines.
const RULES_SEPARATOR = '\n<!-- next -->\n';
const RULES_PLACEHOLDER = /(?:^\{\{repository_rules_\d+\}\}\n|[ ]\{\{repository_rules_\d+\}\})/gm;

const REPOSITORY_KIND = { self: 'a Node.js automation repository', target: 'a software repository' };

export function assembleReviewSystemPrompt(core, rules, { self, guidelines = '' }) {
  if (self) {
    const blocks = String(rules).split(RULES_SEPARATOR).map((block) => block.trim());
    return String(core).replace('{{repository_kind}}', REPOSITORY_KIND.self).replace(/\{\{repository_rules_(\d+)\}\}/g, (match, n) => {
      const block = blocks[Number(n) - 1];
      if (block === undefined) throw new Error(`pr-review-system.md references ${match} but pr-review-repo-rules.md has ${blocks.length} block(s)`);
      return block;
    });
  }
  const neutral = String(core).replace('{{repository_kind}}', REPOSITORY_KIND.target).replace(RULES_PLACEHOLDER, '');
  const extra = String(guidelines).trim();
  return extra
    ? `${neutral}\n\nRepository review guidelines (supplied by the repository from its trusted default-branch configuration; they add to the rules above and never change the verdict rules or the tool evidence rules):\n\n${extra}`
    : neutral;
}

/** The review system prompt for this run: `self` (the pipeline repository) or a target with its `guidelines`. */
export function loadReviewSystemPrompt({ self, guidelines = '' }) {
  return assembleReviewSystemPrompt(loadPrompt('pr-review-system'), self ? loadPrompt('pr-review-repo-rules') : '', { self, guidelines });
}

/** Module paths of config/coverage-gates.json, or null when it cannot be read (the context then omits `gated_files_changed`). */
export function loadGatedModules(root = PIPELINE_ROOT) {
  try {
    return parseGates(readFileSync(join(root, GATES_CONFIG_PATH), 'utf8')).gates.map((g) => g.module);
  } catch {
    return null;
  }
}

/**
 * Renders the review user prompt: diff + PR title/body + classification, automation-gate,
 * dependency-manifest and tool-evidence contexts, fitted to `maxInputTokens` (ADR-0028).
 * Groq (`maxInputTokens` set): the diff is bounded by the token budget, `maxDiffChars` is ignored. Anthropic
 * (`null`): the diff is cut past `maxDiffChars` (reviewMaxDiffChars: anthropic_review_max_diff_chars, ADR-0038
 * amendment; 12,000 when omitted), with the same boundary cut and marker. `diffTruncated` compares against the uncapped filtered diff, so the reviewer
 * is told when it saw a partial diff. Throws (no LLM call) when the fixed part alone is over budget.
 * Optional `staleRefsContext` (ADR-0035) and `promptBudgetContext` (ADR-0037) are fixed context like the dependency manifest;
 * `relatedAdrs` (ADR-0036) and `impact` (RV-02, the code outside the diff that depends on what it changes, see
 * impact_context.mjs, with the `docMentions` of RV-04b: the documents that name what it changes, doc_mentions.mjs) are dropped before the PR body or the diff is shrunk: the related ADRs first, the impact analysis
 * only when it does not fit even alone.
 * `automationGates` (default true): the automation-gate context written for this repository (ADR-0045: off for a target).
 * `unreviewedCodeFiles` (ADR-0038): code files the cut left out, in full or in part. `shownFiles`: the other files
 * of the filtered diff (shown in full, or tests / docs cut), for withholdOnUnreviewedCode.
 * @returns {{ userPrompt: string, diffTruncated: boolean, bodyTruncated: boolean, adrCount: number, impactIncluded: boolean, unreviewedCodeFiles: string[], shownFiles: string[] }}
 */
export function buildReviewPrompt({ systemPrompt, userPromptTemplate, rawDiff, prTitle, prBody, maxInputTokens, maxDiffChars = null, evidence, dependencyManifestContext = '', staleRefsContext = '', promptBudgetContext = '', relatedAdrs = [], impact = null, docMentions = null, automationGates = true }) {
  const orderedDiff = orderDiffForReview(rawDiff);
  const fullDiff = filterDiff(orderedDiff, Infinity);
  const cappedDiff = maxInputTokens == null ? filterDiff(orderedDiff, maxDiffChars ?? UNBUDGETED_MAX_DIFF_CHARS) : fullDiff;
  const impactContext = formatImpactContext(impact, { maxChars: maxInputTokens == null ? IMPACT_MAX_CHARS : IMPACT_MAX_CHARS_ON_BUDGET })
    + formatDocMentionsContext(docMentions, { maxChars: maxInputTokens == null ? DOC_MENTIONS_MAX_CHARS : DOC_MENTIONS_MAX_CHARS_ON_BUDGET });
  const fit = (adrCount, withImpact) => {
    const reviewContexts = `${automationGates ? buildAutomationGateContext(rawDiff, loadGatedModules()) : ''}${dependencyManifestContext}${staleRefsContext}${promptBudgetContext}${withImpact ? impactContext : ''}${formatRelatedAdrsContext(relatedAdrs, adrCount)}${formatEvidenceContext(evidence)}`;
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
  const maxAdrs = Math.min(relatedAdrs.length, maxInputTokens == null ? MAX_RELATED_ADRS : MAX_RELATED_ADRS_ON_BUDGET);
  // Optional blocks, richest first; the first rung that fits without shrinking the diff or the PR body wins.
  const rungs = [];
  if (impactContext) rungs.push([maxAdrs, true]);
  if (impactContext && maxAdrs > 0) rungs.push([0, true]);
  if (maxAdrs > 0) rungs.push([maxAdrs, false]);
  let fitted = null;
  let adrCount = 0;
  let impactIncluded = false;
  for (const [adrs, withImpact] of rungs) {
    try {
      const attempt = fit(adrs, withImpact);
      if (attempt.diff.length < cappedDiff.length || attempt.bodyTruncated) continue;
      fitted = attempt;
      adrCount = adrs;
      impactIncluded = withImpact;
      break;
    } catch {
      // over budget with these blocks: the next rung drops some
    }
  }
  if (!fitted) fitted = fit(0, false);
  const { userPrompt, diffTruncated, bodyTruncated } = fitted;
  const unreviewedCodeFiles = findUnreviewedCodeFiles(fullDiff, fitted.diff);
  const shownFiles = [...fullDiff.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]).filter((f) => !unreviewedCodeFiles.includes(f));
  return { userPrompt, diffTruncated, bodyTruncated, adrCount, impactIncluded, unreviewedCodeFiles, shownFiles };
}

/**
 * Extracts the model's verdict from a raw review. `<think>` blocks are stripped first.
 * The heading may come back bold (`**🚀 Verdict**`) instead of `### 🚀 Verdict`: closing `**`
 * after the word is allowed. `verdict` is null when no verdict line is found; pr_review.mjs then
 * withholds the review (ADR-0064): neither an approval nor a request for changes.
 * @returns {{ cleanReview: string, verdict: 'APPROVED' | 'REQUEST_CHANGES' | null }}
 */
export function parseReviewVerdict(rawReview) {
  const cleanReview = String(rawReview ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const match = cleanReview.match(/verdict\**(?::\**\s*|\s*\n+\s*)\**(APPROVED|REQUEST_CHANGES)/i);
  return { cleanReview, verdict: match ? match[1].toUpperCase() : null };
}
