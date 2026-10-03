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

import { validateIssue, VALIDATION_SYSTEM_PROMPT } from './issue_validator.mjs';

const verdict = (valid) => (valid ? 'valid' : 'invalid');

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
    error_rate: { max: 0.05 },
  },
};

export const SUITES = {
  [validationSuite.name]: validationSuite,
};
