import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlatYaml } from '../lib/yaml.mjs';
import { LOW_HEADROOM_RATIO, computePromptBudgetImpact } from '../lib/prompt_budget.mjs';

// CI gate (ADR-0037): prompts/auto-fix-system.md sits on top of autofix_max_input_tokens inside the
// 8K TPM window. Review evidence only flags low headroom on a PR that edits the prompt; this test
// fails the suite as soon as the committed prompt or config/models.yaml leaves less than the margin.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROMPT = 'prompts/auto-fix-system.md';
const models = parseFlatYaml(readFileSync(resolve(ROOT, 'config/models.yaml'), 'utf8'));
const committed = readFileSync(resolve(ROOT, PROMPT), 'utf8');
const diff = `diff --git a/${PROMPT} b/${PROMPT}\n--- a/${PROMPT}\n+++ b/${PROMPT}\n@@ -1 +1 @@\n-a\n+b\n`;
const impactOf = (head) => {
  const impacts = computePromptBudgetImpact({
    rawDiff: diff, readBase: () => committed, readHead: () => head, models, logFn: () => {},
  });
  assert.equal(impacts.length, 1);
  return impacts[0];
};

test('auto-fix-system.md leaves at least LOW_HEADROOM_RATIO of the TPM-bounded autofix input', () => {
  const r = impactOf(committed);
  assert.equal(r.budget, 'tpm');
  assert.ok(r.maxInputTokens > 0, 'autofix_max_tokens / autofix_max_input_tokens must be configured');
  const margin = Math.ceil(r.maxInputTokens * LOW_HEADROOM_RATIO);
  assert.ok(!r.lowHeadroom && r.headroomTokens >= margin,
    `${PROMPT} is ${r.headTokens} tokens: ${r.headroomTokens} left of ${r.maxInputTokens}, under the ${margin}-token margin. `
    + 'Remove duplicated or restated rules, or rebalance autofix_max_input_tokens in config/models.yaml.');
});

test('the gate trips once auto-fix-system.md grows past the margin', () => {
  const { headroomTokens, maxInputTokens } = impactOf(committed);
  const margin = Math.ceil(maxInputTokens * LOW_HEADROOM_RATIO);
  const grown = impactOf(committed + 'x'.repeat(Math.max(1, headroomTokens - margin + 1) * 4));
  assert.equal(grown.lowHeadroom, true);
  assert.ok(grown.headroomTokens < margin);
});
