/**
 * Eval suite registry. One suite per pipeline stage; add a stage by adding an entry.
 *
 * Suite contract (consumed by eval_harness.mjs):
 *   name           — registry key, used in report and history
 *   stage          — loadLLMConfig() stage the live LLM is bound to
 *   dataset        — JSONL path, one { id, tags?, input, expected } per line
 *   run            — (input, { llm, testCase }) → output; throwing counts as an errored run (testCase: the whole entry)
 *   scorers        — { name: (expected, output, { error, calls }) → 0..1 | boolean | null }
 *   label          — output → class label (confusion matrix, consistency)
 *   expectedLabel  — expected → class label
 *   thresholds     — { "<summary dot.path>": { min?, max? } }, exit code 1 when one fails
 *   tokensPerRunEst — provider tokens (in + out) one case × repeat costs; pre-flight estimate and
 *                     EVAL_TOKEN_BUDGET when no error-free run of the suite is in EVAL_HISTORY_FILE
 *   llmCall        — the callLLM call of the production stage, mirrored by the live eval LLM:
 *                    configKeys (loadLLMConfig fields it forwards) + options (literal call options, e.g.
 *                    responseFormat). eval_suites.test.mjs checks it against the stage's call site.
 */

import path from 'node:path';
import { validateIssue, VALIDATION_SYSTEM_PROMPT } from './issue_validator.mjs';
import { loadPrompt } from './prompts.mjs';
import { detectProvider, GROQ_MODEL_DEFAULTS, reviewMaxDiffChars } from './config.mjs';
import { buildReviewPrompt, loadReviewSystemPrompt, parseReviewVerdict } from './review_prompt.mjs';
import { resolveReviewDecision } from './review_decision.mjs';
import { collectGuardrailFindings, findTestCountDrops, withGuardrailIssues } from './guardrail_review.mjs';
import { substantiateFindings, evidenceCounts, impactLookup } from './finding_evidence.mjs';
import { MIN_CRITICAL_POINTS } from './adversarial_review.mjs';
import { analyzeFindings } from './review_findings.mjs';
import { formatDependencyManifestContext } from './dependency_manifest.mjs';
import { parseEvidence, assessEvidence, findTouchedEvidencePaths } from './review_evidence.mjs';
import { formatStaleRefsContext } from './stale_refs.mjs';
import { formatPromptBudgetContext } from './prompt_budget.mjs';

const verdict = (valid) => (valid ? 'valid' : 'invalid');

// Blocker codes the prompt asks the model to prefix each blocker with ("B2: …").
export function blockerCodes(blockers = []) {
  const codes = blockers.map((b) => String(b).match(/^\W*(B[1-4])\b/i)?.[1].toUpperCase()).filter(Boolean);
  return [...new Set(codes)];
}

export const validationSuite = {
  name: 'validation',
  stage: 'validation',
  dataset: 'evals/datasets/validation.jsonl',
  // Groq-reported usage (incl. reasoning tokens): ≈ 95k per repeat over 35 cases (docs/evals.md).
  tokensPerRunEst: 2700,
  // scripts/validate_issue.mjs: no responseFormat, so Groq's json_object default (the stage parses JSON).
  llmCall: {
    configKeys: ['apiKey', 'model', 'apiUrl', 'temperature', 'maxTokens', 'maxInputTokens', 'reasoningEffort'],
    options: {},
  },

  async run(input, { llm }) {
    return validateIssue({
      issueTitle: input.title,
      issueBody: input.body,
      callGroq: ({ prompt }) => llm({ prompt, systemPrompt: VALIDATION_SYSTEM_PROMPT }),
    });
  },

  scorers: {
    verdict_match: (expected, output) => output?.valid === expected.valid,
    score_in_range: (expected, output) => {
      if (expected.score_min == null && expected.score_max == null) return null;
      const s = output?.score;
      return s != null && s >= (expected.score_min ?? 0) && s <= (expected.score_max ?? 100);
    },
    // Right rule, not just the right verdict: Jaccard between expected and returned blocker codes.
    // Applies to cases labelled with expected.blockers. Not gated yet.
    blocker_match: (expected, output) => {
      if (!Array.isArray(expected.blockers) || output == null) return null;
      const want = new Set(expected.blockers);
      const got = new Set(blockerCodes(output.blockers));
      const union = new Set([...want, ...got]);
      if (union.size === 0) return 1;
      return [...want].filter((c) => got.has(c)).length / union.size;
    },
    // Prompt contract: 3–5 suggested AC whenever the LLM was consulted.
    suggested_ac_count: (expected, output, { calls }) => {
      if (calls.length === 0) return null;
      const n = output?.suggested_ac?.length ?? 0;
      return n >= 3 && n <= 5;
    },
  },

  label: (output) => verdict(output.valid),
  expectedLabel: (expected) => verdict(expected.valid),

  // Starting point — tighten once a baseline over several runs is known.
  thresholds: {
    'scores.verdict_match.mean': { min: 0.8 },
    'per_class.invalid.recall': { min: 0.8 },
    // Over-strictness blocks good issues and stalls the pipeline: gate it too (support 12 → one case ≈ 8 pts).
    'per_class.valid.recall': { min: 0.8 },
    // A case whose verdict flips between repeats is a coin toss. Only measured with --repeats > 1.
    consistency: { min: 0.9, optional: true },
    error_rate: { max: 0.05 },
  },
};

// ---------------------------------------------------------------------------
// review — pr_review.mjs prompt builder, verdict parser and resolveReviewDecision (ADR-0024/0026/0028/0038/0049)
// ---------------------------------------------------------------------------

// A top-level section heading (#178): a "#"–"###" heading ("### ✅ Summary"), or a bold-only line whose
// whole text, emoji, ":" and whitespace aside, is a section title ("**🚀 Verdict**", "**Issues Found:**").
// A "#### scripts/foo.mjs" sub-heading, a "**scripts/foo.mjs**" group or a "**Summary of risks**" line
// inside Issues Found does not end the section.
const SECTION_TITLE = /^(?:Change Classification|Summary|Issues Found|Verdict)$/i;
const isHeading = (line) => {
  if (/^\s*#{1,3}\s/.test(line)) return true;
  const bold = line.match(/^\s*\*\*([^*]+)\*\*:?\s*$/)?.[1];
  return bold != null && SECTION_TITLE.test(bold.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
};

// Lines of the review whose section heading passes keep(heading); lines before any heading have heading ''.
function filterSections(review, keep) {
  let heading = '';
  return String(review ?? '').split('\n').filter((line) => {
    if (isHeading(line)) heading = line;
    return keep(heading);
  }).join('\n');
}

// The review minus its Change Classification section, whose "Tests expected: yes" line would match
// any test-related keyword.
const reviewFindingsText = (review) => filterSections(review, (heading) => !/Change Classification/i.test(heading));
const issuesSection = (review) => filterSections(review, (heading) => /Issues Found/i.test(heading));

// Severities of the finding bullets in the Issues Found section: "- [High] …", "* **[Medium]** …".
export function findingSeverities(review) {
  return [...issuesSection(review).matchAll(/^\s*[-*]\s*\**\[?\**(High|Medium|Low)\b/gim)].map((m) => m[1].toLowerCase());
}

// Finding bullets of Issues Found whose severity is Low, each with its continuation lines (#199 advisory scorer).
const FINDING_START = /^\s*[-*]\s*\**\[?\**(High|Medium|Low)\b/i;
function lowFindings(review) {
  const findings = [];
  for (const line of issuesSection(review).split('\n')) {
    const severity = line.match(FINDING_START)?.[1];
    if (severity) findings.push({ low: severity.toLowerCase() === 'low', text: line });
    else if (findings.length && !isHeading(line)) findings.at(-1).text += `\n${line}`;
  }
  return findings.filter((f) => f.low).map((f) => f.text);
}

// must_flag entry: "a|b|c" — matched when the findings text contains any alternative (case-insensitive).
export function matchesFlag(text, entry) {
  const haystack = String(text ?? '').toLowerCase();
  return String(entry).split('|').map((k) => k.trim().toLowerCase()).filter(Boolean).some((k) => haystack.includes(k));
}

// Finding-level view of a review against the defects its case lists in `expected.findings` (RV-01): null when the
// case lists none. `expected.acceptable_findings` are blocking findings that are not defects but not false alarms.
const findingAnalysis = (expected, review) => (Array.isArray(expected?.findings)
  ? analyzeFindings(issuesSection(review), expected.findings, { acceptable: expected.acceptable_findings ?? [] })
  : null);

// What the results file keeps of the analysis: enough to read, per run, which defects were found and why the others
// were not (`needs`), without the review text twice.
const summarizeFindingAnalysis = (a) => (a == null ? undefined : {
  detected: a.detected.length,
  matched: a.matched.map((m) => m.id),
  missed: a.missed,
  false_positives: a.falsePositives.length,
});

let reviewPrompts;
const loadReviewPrompts = () => (reviewPrompts ??= { system: loadReviewSystemPrompt({ self: true }), user: loadPrompt('pr-review-user') });

// Same budget as loadLLMConfig('review').maxInputTokens: review_max_input_tokens, else max_input_tokens, on Groq;
// none on Anthropic, whose diff is capped at anthropic_review_max_diff_chars instead (reviewDiffLimits). Not
// loadLLMConfig itself: it requires an API key, which a replay has not.
export function reviewInputBudget(defaults = GROQ_MODEL_DEFAULTS) {
  if (detectProvider('review') === 'anthropic') return null;
  const raw = defaults.review_max_input_tokens ?? defaults.max_input_tokens;
  if (raw === undefined) return null;
  const budget = parseInt(raw, 10);
  if (isNaN(budget) || budget <= 0) throw new Error(`Invalid max_input_tokens for stage "review": ${raw} (must be a positive integer)`);
  return budget;
}

/**
 * Cut applied to a `requires_cut` review case on `provider` (ADR-0038 amendment), from config/models.yaml:
 * review_eval_cut_<provider>_max_input_tokens (token budget fit, like Groq production) or
 * review_eval_cut_<provider>_max_diff_chars (char cap, like Anthropic production); at most one of the two.
 * null when neither is set: the case then runs on the provider's production limits.
 * @returns {{ maxInputTokens: number | null, maxDiffChars: number | null } | null}
 */
export function requiresCutLimits(provider, defaults = GROQ_MODEL_DEFAULTS) {
  const key = (limit) => `review_eval_cut_${provider}_${limit}`;
  const read = (limit) => {
    const raw = defaults[key(limit)];
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${key(limit)}: ${raw} (must be a positive integer)`);
    return value;
  };
  const maxInputTokens = read('max_input_tokens');
  const maxDiffChars = read('max_diff_chars');
  if (maxInputTokens != null && maxDiffChars != null) throw new Error(`Set one of ${key('max_input_tokens')} and ${key('max_diff_chars')}, not both`);
  if (maxInputTokens == null && maxDiffChars == null) return null;
  return { maxInputTokens, maxDiffChars };
}

/**
 * Diff limits of one review case (ADR-0038 amendment). By default, production's: the stage provider's input budget
 * (Groq) or diff cap (Anthropic, reviewMaxDiffChars). A case with `requires_cut: true` expects a verdict that only a
 * cut diff yields (WITHHELD, a finding past the cut, a truncation note): it gets the stage provider's
 * requiresCutLimits, else production's limits. reviewSuite.run errors the run when that leaves it uncut.
 * Any other `requires_cut` value is a dataset error.
 * @returns {{ maxInputTokens: number | null, maxDiffChars: number | null }}
 */
export function reviewDiffLimits(testCase, defaults = GROQ_MODEL_DEFAULTS) {
  const requiresCut = testCase?.requires_cut;
  if (requiresCut !== undefined && requiresCut !== true) {
    throw new Error(`${testCase.id}: requires_cut must be true or absent, got ${JSON.stringify(requiresCut)}`);
  }
  const provider = detectProvider('review');
  const forced = requiresCut ? requiresCutLimits(provider, defaults) : null;
  return forced ?? { maxInputTokens: reviewInputBudget(defaults), maxDiffChars: reviewMaxDiffChars(provider, defaults) };
}

export const reviewSuite = {
  name: 'review',
  stage: 'review',
  dataset: 'evals/datasets/review.jsonl',
  // ≈ 4.15k chars/4 input per call (35 cases, system prompt ≈ 2.83k; the two #219 cases and the #199 cut case fill the
  // 6.3k budget) × 1.34 (validation's Groq-reported / chars/4 ratio) + output: ≈ 200k per repeat. Was 5500 (4.02k input,
  // 30 cases) before the #199 untested-claim cases, 5300 (3.76k input, 28 cases) before the #219 cases, 4200 (2.9k
  // input, 23 cases) before the first incident cases (docs/evals.md).
  tokensPerRunEst: 5700,
  // scripts/pr_review.mjs: the review is Markdown, so responseFormat null (json_object: Groq 400
  // "Failed to generate JSON"). No maxInputTokens: the prompt is fitted by buildReviewPrompt instead.
  llmCall: {
    configKeys: ['apiKey', 'model', 'apiUrl', 'temperature', 'maxTokens', 'reasoningEffort'],
    options: { responseFormat: null },
  },

  // input: { title, body, diff, dependencies?, evidence?, head_sha?, stale_refs?, related_adrs?, impact?, doc_mentions?, prompt_budget? }.
  // A case without `evidence` is a repository that has not opted in (no config): the evidence is missing and
  // does not withhold approval. stale_refs / related_adrs / impact / prompt_budget are precomputed, in the shapes
  // findStaleReferences / findRelatedAdrs / findImpact / computePromptBudgetImpact return (the PR tree is not in the case),
  // and go through the same formatters as in pr_review.mjs. eval_suites.test.mjs pins the field parity.
  // requires_cut (case level, outside the pinned input): see reviewDiffLimits.
  async run(input, { llm, testCase }) {
    const { system, user } = loadReviewPrompts();
    const { maxInputTokens, maxDiffChars } = reviewDiffLimits(testCase);
    const evidence = assessEvidence(
      input.evidence === undefined ? { ok: false, reason: `no evidence file at ${path.join('evidence', 'review-evidence.json')}` } : parseEvidence(JSON.stringify(input.evidence)),
      { prHeadSha: input.head_sha ?? null, touchedPaths: findTouchedEvidencePaths(input.diff) },
    );
    const { userPrompt, diffTruncated, bodyTruncated, unreviewedCodeFiles, shownFiles } = buildReviewPrompt({
      systemPrompt: system,
      userPromptTemplate: user,
      automationGates: true, // the suites measure this repository's own review (ADR-0045)
      rawDiff: input.diff,
      prTitle: input.title,
      prBody: input.body || '(no description provided)',
      maxInputTokens,
      maxDiffChars,
      evidence,
      dependencyManifestContext: formatDependencyManifestContext(input.dependencies),
      staleRefsContext: formatStaleRefsContext(input.stale_refs),
      relatedAdrs: input.related_adrs ?? [],
      impact: input.impact ?? null,
      docMentions: input.doc_mentions ?? null,
      promptBudgetContext: formatPromptBudgetContext(input.prompt_budget),
    });
    // A requires_cut case left whole would score a verdict its expectation does not hold for: no LLM call, errored run.
    if (testCase?.requires_cut && !diffTruncated) {
      throw new Error(`${testCase.id}: requires_cut but not cut on ${detectProvider('review')}: set review_eval_cut_${detectProvider('review')}_max_input_tokens or _max_diff_chars in config/models.yaml`);
    }
    const { cleanReview, verdict: llmVerdict } = parseReviewVerdict(await llm({ prompt: userPrompt, systemPrompt: system }));
    // Production withholds a review with no verdict line (ADR-0064); the eval counts it as an errored run instead,
    // so a format regression shows in error_rate rather than inflating request_changes recall.
    if (!llmVerdict) throw new Error('No verdict line in the review (expected APPROVED or REQUEST_CHANGES)');
    // The same resolution as pr_review.mjs (evidence, cut code, adversarial protocol): the scored verdict is the published one.
    // RV-03: the guardrail checks that need only the diff (a test case removed); the file-based ones need the PR tree.
    const guardrails = collectGuardrailFindings([findTestCountDrops(input.diff, { mentionText: `${input.title}\n${input.body || '(no description provided)'}` })]);
    // RV-04a: proof for the findings about code outside the diff; with no tree, the lines of the case's Impact analysis.
    const findingAssessment = substantiateFindings({ review: cleanReview, rawDiff: input.diff, lookup: impactLookup({ symbols: [...(input.impact?.symbols ?? []), ...(input.doc_mentions?.terms ?? [])] }) });
    const { verdict, reason, withheldFor, adversarial } = resolveReviewDecision({
      llmApproved: llmVerdict === 'APPROVED',
      cleanReview,
      evidence,
      evidenceRequired: input.evidence !== undefined,
      unreviewedCodeFiles,
      shownFiles,
      guardrailFindings: guardrails.findings,
      findingAssessment,
    });
    const scoredReview = withGuardrailIssues(cleanReview, guardrails);
    return { verdict, llm_verdict: llmVerdict, reason, withheld_for: withheldFor, adversarial_protocol_met: adversarial.criticalPoints >= MIN_CRITICAL_POINTS, adversarial_points: adversarial.criticalPoints, evidence_state: evidence.state, diff_truncated: diffTruncated, body_truncated: bodyTruncated, unreviewed_code_files: unreviewedCodeFiles, guardrail_findings: guardrails.findings.map((f) => ({ rule: f.rule, path: f.path })), evidence_check: evidenceCounts(findingAssessment), review: scoredReview, finding_analysis: summarizeFindingAnalysis(findingAnalysis(testCase?.expected, scoredReview)) };
  },

  scorers: {
    verdict_match: (expected, output) => output?.verdict === expected.verdict,
    // Right reason, not only the right verdict: share of expected entries the review raises.
    // must_flag is searched in Issues Found only (a Summary describing the diff is not a finding);
    // must_note (e.g. the truncation note the prompt puts under the summary) in the whole review minus
    // its classification section. An approving review raised nothing: 0.
    flags_issue: (expected, output) => {
      const flags = Array.isArray(expected.must_flag) ? expected.must_flag : [];
      const notes = Array.isArray(expected.must_note) ? expected.must_note : [];
      if (flags.length + notes.length === 0) return null;
      if (output?.llm_verdict !== 'REQUEST_CHANGES') return 0;
      const issues = issuesSection(output.review);
      const text = reviewFindingsText(output.review);
      const hits = flags.filter((entry) => matchesFlag(issues, entry)).length + notes.filter((entry) => matchesFlag(text, entry)).length;
      return hits / (flags.length + notes.length);
    },
    // Clean cases (expected APPROVE or WITHHELD): the model approved and raised no High/Medium finding.
    no_false_alarm: (expected, output) => {
      if (expected.verdict === 'REQUEST_CHANGES') return null;
      return output?.llm_verdict === 'APPROVED' && !findingSeverities(output.review).some((s) => s === 'high' || s === 'medium');
    },
    // Advisory findings (#199, e.g. "Untested claim: …"), any verdict: share of must_advise entries raised by a
    // Low finding of Issues Found. A High or Medium finding with the keyword does not count: it is no advisory.
    advisory: (expected, output) => {
      const entries = Array.isArray(expected.must_advise) ? expected.must_advise : [];
      if (entries.length === 0) return null;
      const low = lowFindings(output?.review);
      return entries.filter((entry) => low.some((finding) => matchesFlag(finding, entry))).length / entries.length;
    },
    // No entry of must_not_flag appears in Issues Found, at any severity and any verdict.
    // Finding level (RV-01), for the cases that list their known defects in expected.findings; null for the others.
    // Share of the blocking defects the review reports (a High or Medium finding at the right file and lines).
    finding_recall: (expected, output) => findingAnalysis(expected, output?.review)?.recall ?? null,
    // Share of the blocking findings that are one of the known defects (or listed as acceptable); null when none was raised.
    finding_precision: (expected, output) => findingAnalysis(expected, output?.review)?.precision ?? null,
    // The same recall over the High defects only: the ones a human merge gate must never receive unflagged.
    critical_recall: (expected, output) => findingAnalysis(expected, output?.review)?.criticalRecall ?? null,
    no_spurious_flag: (expected, output) => {
      const entries = Array.isArray(expected.must_not_flag) ? expected.must_not_flag : [];
      if (entries.length === 0) return null;
      if (output == null) return false;
      const issues = issuesSection(output?.review);
      return !entries.some((entry) => matchesFlag(issues, entry));
    },
  },

  label: (output) => output.verdict.toLowerCase(),
  expectedLabel: (expected) => expected.verdict.toLowerCase(),

  // Starting point — tighten once a baseline over several runs is known.
  thresholds: {
    'scores.verdict_match.mean': { min: 0.75 },
    // A missed bug reaches the human merge gate unflagged: the reviewer's first job.
    'per_class.request_changes.recall': { min: 0.8 },
    // Over-severity: a false REQUEST_CHANGES starts an auto-fix loop on a correct PR (support 8 → one case ≈ 12 pts).
    'per_class.approve.recall': { min: 0.6 },
    // Historical threshold retained with the temperature-zero default; only measured with --repeats > 1.
    consistency: { min: 0.8, optional: true },
    error_rate: { max: 0.05 },
  },
};

export const SUITES = {
  [validationSuite.name]: validationSuite,
  [reviewSuite.name]: reviewSuite,
};
