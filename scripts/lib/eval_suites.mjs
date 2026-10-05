/**
 * Eval suite registry. One suite per pipeline stage; add a stage by adding an entry.
 *
 * Suite contract (consumed by eval_harness.mjs):
 *   name           — registry key, used in report and history
 *   stage          — loadLLMConfig() stage the live LLM is bound to
 *   dataset        — JSONL path, one { id, tags?, input, expected } per line
 *   run            — (input, { llm }) → output; throwing counts as an errored run
 *   scorers        — { name: (expected, output, { error, calls }) → 0..1 | boolean | null }
 *   label          — output → class label (confusion matrix, consistency)
 *   expectedLabel  — expected → class label
 *   thresholds     — { "<summary dot.path>": { min?, max? } }, exit code 1 when one fails
 */

import path from 'node:path';
import { validateIssue, VALIDATION_SYSTEM_PROMPT } from './issue_validator.mjs';
import { loadPrompt } from './prompts.mjs';
import { detectProvider, GROQ_MODEL_DEFAULTS } from './config.mjs';
import { buildReviewPrompt, parseReviewVerdict } from './review_prompt.mjs';
import { formatDependencyManifestContext } from './dependency_manifest.mjs';
import { parseEvidence, assessEvidence, findTouchedEvidencePaths, decideVerdict } from './review_evidence.mjs';

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
// review — pr_review.mjs prompt builder, verdict parser and decideVerdict (ADR-0024/0026/0028)
// ---------------------------------------------------------------------------

// A heading line: "### ✅ Summary" or a line that is bold only ("**🚀 Verdict**").
const isHeading = (line) => /^\s*(?:#{1,6}\s|\*\*[^*]+\*\*:?\s*$)/.test(line);

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

// must_flag entry: "a|b|c" — matched when the findings text contains any alternative (case-insensitive).
export function matchesFlag(text, entry) {
  const haystack = String(text ?? '').toLowerCase();
  return String(entry).split('|').map((k) => k.trim().toLowerCase()).filter(Boolean).some((k) => haystack.includes(k));
}

let reviewPrompts;
const loadReviewPrompts = () => (reviewPrompts ??= { system: loadPrompt('pr-review-system'), user: loadPrompt('pr-review-user') });

// Same budget as production: review_max_input_tokens on Groq, none (12,000-char diff cap) on Anthropic.
function reviewInputBudget() {
  return detectProvider() === 'anthropic' ? null : parseInt(GROQ_MODEL_DEFAULTS.review_max_input_tokens, 10);
}

export const reviewSuite = {
  name: 'review',
  stage: 'review',
  dataset: 'evals/datasets/review.jsonl',

  // input: { title, body, diff, dependencies?, evidence?, head_sha? }. A case without `evidence` is a
  // repository that has not opted in (no config): the evidence is missing and does not withhold approval.
  async run(input, { llm }) {
    const { system, user } = loadReviewPrompts();
    const evidence = assessEvidence(
      input.evidence === undefined ? { ok: false, reason: `no evidence file at ${path.join('evidence', 'review-evidence.json')}` } : parseEvidence(JSON.stringify(input.evidence)),
      { prHeadSha: input.head_sha ?? null, touchedPaths: findTouchedEvidencePaths(input.diff) },
    );
    const { userPrompt, diffTruncated, bodyTruncated } = buildReviewPrompt({
      systemPrompt: system,
      userPromptTemplate: user,
      rawDiff: input.diff,
      prTitle: input.title,
      prBody: input.body || '(no description provided)',
      maxInputTokens: reviewInputBudget(),
      evidence,
      dependencyManifestContext: formatDependencyManifestContext(input.dependencies),
    });
    const { cleanReview, verdict: llmVerdict } = parseReviewVerdict(await llm({ prompt: userPrompt, systemPrompt: system }));
    // Production fails closed on a missing verdict line; the eval counts it as an errored run instead,
    // so a format regression shows in error_rate rather than inflating request_changes recall.
    if (!llmVerdict) throw new Error('No verdict line in the review (expected APPROVED or REQUEST_CHANGES)');
    const { verdict, reason } = decideVerdict(llmVerdict === 'APPROVED', evidence, { evidenceRequired: input.evidence !== undefined });
    return { verdict, llm_verdict: llmVerdict, reason, evidence_state: evidence.state, diff_truncated: diffTruncated, body_truncated: bodyTruncated, review: cleanReview };
  },

  scorers: {
    verdict_match: (expected, output) => output?.verdict === expected.verdict,
    // Right reason, not only the right verdict: share of must_flag entries the review mentions.
    flags_issue: (expected, output) => {
      if (!Array.isArray(expected.must_flag) || expected.must_flag.length === 0) return null;
      const text = reviewFindingsText(output?.review);
      return expected.must_flag.filter((entry) => matchesFlag(text, entry)).length / expected.must_flag.length;
    },
    // Clean cases (expected APPROVE or WITHHELD): the model approved and raised no High/Medium finding.
    no_false_alarm: (expected, output) => {
      if (expected.verdict === 'REQUEST_CHANGES') return null;
      return output?.llm_verdict === 'APPROVED' && !findingSeverities(output.review).some((s) => s === 'high' || s === 'medium');
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
    // review_temperature is 0.6: looser than validation (temperature 0). Only measured with --repeats > 1.
    consistency: { min: 0.8, optional: true },
    error_rate: { max: 0.05 },
  },
};

export const SUITES = {
  [validationSuite.name]: validationSuite,
  [reviewSuite.name]: reviewSuite,
};
