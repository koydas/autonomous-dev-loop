import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveReviewDecision } from '../lib/review_decision.mjs';
import { reviewSuite } from '../lib/eval_suites.mjs';

const ANALYSIS_2 = '### 🔬 Adversarial Analysis\n- **Robustness** — a.mjs:1 an empty list is not handled\n- **Side effects** — b.mjs:2 the cache is shared\n- **Type integrity** — none, checked\n- **Issue fit** — none, matches\n\n';
const ANALYSIS_1 = '### 🔬 Adversarial Analysis\n- **Robustness** — a.mjs:1 an empty list is not handled\n- **Side effects** — none, checked\n\n';
const review = (analysis, issues = 'None.') => `### ✅ Summary\nSmall.\n\n${analysis}### ⚠️ Issues Found\n${issues}\n\n### 🚀 Verdict\nAPPROVED`;
const AVAILABLE = { state: 'available', reason: null, failing: [], unverified: [] };
const base = { llmApproved: true, cleanReview: review(ANALYSIS_2), evidence: AVAILABLE, evidenceRequired: true, unreviewedCodeFiles: [], shownFiles: [] };

const CASES = [
  ['approved, protocol met, evidence available', {}, 'APPROVE', null],
  ['approved without the adversarial section', { cleanReview: review('') }, 'WITHHELD', 'protocol'],
  ['approved with one risk only', { cleanReview: review(ANALYSIS_1) }, 'WITHHELD', 'protocol'],
  ['evidence failing', { evidence: { ...AVAILABLE, failing: ['tests'] } }, 'REQUEST_CHANGES', null],
  ['evidence missing, required', { evidence: { state: 'missing', reason: 'no file', failing: [], unverified: [] } }, 'WITHHELD', 'evidence'],
  ['evidence missing, not required', { evidence: { state: 'missing', reason: 'no file', failing: [], unverified: [] }, evidenceRequired: false }, 'APPROVE', null],
  ['evidence unverified', { evidence: { ...AVAILABLE, unverified: ['lint'] } }, 'WITHHELD', 'evidence'],
  ['code cut, approved', { unreviewedCodeFiles: ['src/big.js'] }, 'WITHHELD', 'unreviewed_code'],
  ['model REQUEST_CHANGES, no analysis needed', { llmApproved: false, cleanReview: review('', '- [High] bug — File: a.mjs Lines: 1') }, 'REQUEST_CHANGES', null],
  ['REQUEST_CHANGES citing only cut files', { llmApproved: false, cleanReview: review('', '- [High] bug — File: src/big.js Lines: 1'), unreviewedCodeFiles: ['src/big.js'] }, 'WITHHELD', 'unseen_findings'],
];

for (const [name, patch, verdict, withheldFor] of CASES) {
  test(`resolveReviewDecision: ${name} → ${verdict}${withheldFor ? ` (${withheldFor})` : ''}`, () => {
    const d = resolveReviewDecision({ ...base, ...patch });
    assert.equal(d.verdict, verdict);
    assert.equal(d.withheldFor, withheldFor);
  });
}

test('resolveReviewDecision: the protocol reason names the missing points and the stages are exposed', () => {
  const d = resolveReviewDecision({ ...base, cleanReview: review(ANALYSIS_1) });
  assert.match(d.reason, /1 of 2 critical points/);
  assert.equal(d.stages.code.verdict, 'APPROVE');
  assert.equal(d.adversarial.criticalPoints, 1);
});

// Parity (EV-01): both callers delegate to resolveReviewDecision and re-implement none of its stages.
for (const [file, strip] of [['scripts/pr_review.mjs', 'pr_review'], ['scripts/lib/eval_suites.mjs', 'eval_suites']]) {
  test(`${strip} resolves the verdict through resolveReviewDecision only`, () => {
    const src = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(src, /resolveReviewDecision\(/);
    for (const stage of ['decideVerdict(', 'withholdOnUnreviewedCode(', 'enforceAdversarialProtocol(']) {
      assert.ok(!src.includes(stage), `${file} calls ${stage} itself: the decision would drift from ${strip === 'pr_review' ? 'the eval' : 'production'}`);
    }
  });
}

test('reviewSuite.run: an approval without the adversarial analysis scores WITHHELD, as in production', async () => {
  const run = (raw) => reviewSuite.run({ title: 't', body: 'b', diff: 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n' }, { llm: async () => raw, testCase: undefined });
  const withheld = await run(review(''));
  assert.equal(withheld.verdict, 'WITHHELD');
  assert.equal(withheld.withheld_for, 'protocol');
  assert.equal(withheld.adversarial_protocol_met, false);
  const approved = await run(review(ANALYSIS_2));
  assert.equal(approved.verdict, 'APPROVE');
  assert.equal(approved.adversarial_protocol_met, true);
  assert.equal(approved.adversarial_points, 2);
});
