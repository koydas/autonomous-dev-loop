import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveReviewDecision, withholdUnreadableVerdict, formatUnreadableVerdictNote } from '../lib/review_decision.mjs';
import { reviewSuite } from '../lib/eval_suites.mjs';

const ANALYSIS_2 = '### 🔬 Adversarial Analysis\n- **Robustness** — a.mjs:1 an empty list is not handled\n- **Side effects** — b.mjs:2 the cache is shared\n- **Type integrity** — none, checked\n- **Issue fit** — none, matches\n\n';
const ANALYSIS_1 = '### 🔬 Adversarial Analysis\n- **Robustness** — a.mjs:1 an empty list is not handled\n- **Side effects** — none, checked\n\n';
const review = (analysis, issues = 'None.') => `### ✅ Summary\nSmall.\n\n${analysis}### ⚠️ Issues Found\n${issues}\n\n### 🚀 Verdict\nAPPROVED`;
const AVAILABLE = { state: 'available', reason: null, failing: [], unverified: [] };
const base = { llmApproved: true, cleanReview: review(ANALYSIS_2), evidence: AVAILABLE, evidenceRequired: true, unreviewedCodeFiles: [], shownFiles: [] };

const GUARD = { rule: 'test_count_drop', path: 't/a.test.mjs', severity: 'High', reason: 'removes 1 test case' };

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
  ['guardrail finding, approved', { guardrailFindings: [GUARD] }, 'REQUEST_CHANGES', null],
  ['guardrail finding, approval withheld for the protocol', { guardrailFindings: [GUARD], cleanReview: review('') }, 'REQUEST_CHANGES', null],
  ['guardrail finding, evidence unverified', { guardrailFindings: [GUARD], evidence: { ...AVAILABLE, unverified: ['lint'] } }, 'REQUEST_CHANGES', null],
  ['guardrail finding, code cut', { guardrailFindings: [GUARD], unreviewedCodeFiles: ['src/big.js'] }, 'REQUEST_CHANGES', null],
  ['guardrail finding, model already rejects', { guardrailFindings: [GUARD], llmApproved: false, cleanReview: review('', '- [High] bug — File: a.mjs Lines: 1') }, 'REQUEST_CHANGES', null],
  ['no guardrail finding', { guardrailFindings: [] }, 'APPROVE', null],
  ['rejected, every blocking finding is unproven', { llmApproved: false, cleanReview: review('', '- [High] bug — File: z.mjs Lines: 1'), findingAssessment: { blocking: 2, unproven: 2 } }, 'WITHHELD', 'unproven_findings'],
  ['rejected, one blocking finding is proven', { llmApproved: false, cleanReview: review('', '- [High] bug — File: z.mjs Lines: 1'), findingAssessment: { blocking: 2, unproven: 1 } }, 'REQUEST_CHANGES', null],
  ['rejected, no blocking finding was parsed', { llmApproved: false, cleanReview: review('', '- [High] bug — File: z.mjs Lines: 1'), findingAssessment: { blocking: 0, unproven: 0 } }, 'REQUEST_CHANGES', null],
  ['rejected, unproven, but a check fails', { llmApproved: false, cleanReview: review('', '- [High] bug — File: z.mjs Lines: 1'), evidence: { ...AVAILABLE, failing: ['tests'] }, findingAssessment: { blocking: 1, unproven: 1 } }, 'REQUEST_CHANGES', null],
  ['rejected, unproven, but a guardrail finding', { llmApproved: false, cleanReview: review('', '- [High] bug — File: z.mjs Lines: 1'), guardrailFindings: [GUARD], findingAssessment: { blocking: 1, unproven: 1 } }, 'REQUEST_CHANGES', null],
  ['approved with an unproven assessment', { findingAssessment: { blocking: 1, unproven: 1 } }, 'APPROVE', null],
  ['no assessment', { llmApproved: false, cleanReview: review('', '- [High] bug — File: z.mjs Lines: 1'), findingAssessment: null }, 'REQUEST_CHANGES', null],
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

test('resolveReviewDecision: guardrailOverride is set only when a guardrail finding changed the verdict', () => {
  const overridden = resolveReviewDecision({ ...base, guardrailFindings: [GUARD, { ...GUARD, rule: 'module_system' }] });
  assert.deepEqual([overridden.guardrailOverride, overridden.reason], [true, 'guardrail findings: test_count_drop, module_system']);
  assert.equal(overridden.withheldFor, null);
  assert.equal(resolveReviewDecision({ ...base, guardrailFindings: [GUARD], llmApproved: false, cleanReview: review('', '- [High] bug — File: a.mjs Lines: 1') }).guardrailOverride, false);
  assert.equal(resolveReviewDecision(base).guardrailOverride, false);
});

test('resolveReviewDecision: the unproven-findings reason counts the findings', () => {
  const d = resolveReviewDecision({ ...base, llmApproved: false, cleanReview: review('', '- [High] bug — File: z.mjs Lines: 1'), findingAssessment: { blocking: 3, unproven: 3 } });
  assert.match(d.reason, /^3 blocking finding\(s\), all about code outside the diff without verified evidence$/);
  assert.equal(d.guardrailOverride, false);
});

test('withholdUnreadableVerdict: an unreadable verdict is withheld, unless a check failed or a guardrail finding was raised', () => {
  const rejected = resolveReviewDecision({ ...base, llmApproved: false });
  assert.equal(rejected.verdict, 'REQUEST_CHANGES');
  const withheld = withholdUnreadableVerdict(rejected, { verdictReadable: false });
  assert.deepEqual([withheld.verdict, withheld.reason, withheld.withheldFor], ['WITHHELD', 'the review has no readable verdict line', 'unreadable_verdict']);
  assert.equal(withheld.stages, rejected.stages, 'the rest of the decision is kept');
  assert.equal(withholdUnreadableVerdict(rejected, { verdictReadable: true }), rejected, 'a readable verdict is never touched');
  assert.equal(withholdUnreadableVerdict(rejected, { verdictReadable: false, deterministicDefect: true }), rejected, 'a failing check or a guardrail finding keeps its REQUEST_CHANGES');
  const alreadyWithheld = resolveReviewDecision({ ...base, llmApproved: true, evidence: { ...AVAILABLE, state: 'missing', reason: 'no file' } });
  assert.equal(alreadyWithheld.verdict, 'WITHHELD');
  assert.equal(withholdUnreadableVerdict(alreadyWithheld, { verdictReadable: false }), alreadyWithheld, 'a decision that is already withheld keeps its own reason');
  const approved = resolveReviewDecision({ ...base });
  assert.equal(withholdUnreadableVerdict(approved, { verdictReadable: false }), approved, 'only a REQUEST_CHANGES is withheld');
});

test('formatUnreadableVerdictNote says why and that auto-fix is not triggered', () => {
  const note = formatUnreadableVerdictNote();
  assert.match(note, /^\n> \*\*Changes not requested\*\* — the review has no readable verdict line/);
  assert.match(note, /auto-fix is not triggered/);
});
