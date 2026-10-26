import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINE_WINDOW, MAX_EVIDENCE_PER_FINDING, MAX_FINDINGS_CHECKED, assessFindings, evidenceCounts, formatEvidenceCheck, formatUnprovenNote, impactLookup, parseEvidence, quoteIsAt,
} from '../lib/finding_evidence.mjs';

const CHECKOUT = ['import { applyDiscount } from "./pricing.mjs";', '', 'export function total(cart) {', '  return applyDiscount(cart.subtotal, cart.rate);', '}', ''].join('\n');
const tree = { 'src/checkout.mjs': CHECKOUT, 'docs/pricing.md': '# Pricing\n\nDiscounts are always rounded to cents.\n' };
const lookup = (p) => tree[p] ?? null;
const review = (...findings) => `### ✅ Summary\nx\n\n### ⚠️ Issues Found\n${findings.join('\n')}\n\n### 🚀 Verdict\nREQUEST_CHANGES\n`;
const finding = (sev, file, rest) => `- [${sev}] Title — File: ${file} Lines: 4 Root cause: it breaks. ${rest} Fix: change it.`;

test('parseEvidence reads path:line "quote" items in the three quote styles, ranges and several items', () => {
  const text = 'Root cause: x. Evidence: src/a.mjs:4 "one two"; docs/b.md:2-3 “three”; `c/d.mjs`:9 `four five` Fix: y';
  assert.deepEqual(parseEvidence(text), [
    { path: 'src/a.mjs', line: 4, quote: 'one two' },
    { path: 'docs/b.md', line: 2, quote: 'three' },
    { path: 'c/d.mjs', line: 9, quote: 'four five' },
  ]);
});

test('parseEvidence stops at the next field, ignores free text, and keeps at most MAX_EVIDENCE_PER_FINDING', () => {
  assert.deepEqual(parseEvidence('Evidence: a.mjs:1 "first text" Fix: b.mjs:2 "not evidence"'), [{ path: 'a.mjs', line: 1, quote: 'first text' }]);
  assert.deepEqual(parseEvidence('Evidence: see the caller in checkout'), []);
  assert.deepEqual(parseEvidence('No evidence field here, a.mjs:1 "x y z w"'), []);
  assert.deepEqual(parseEvidence(null), []);
  const many = `Evidence: ${Array.from({ length: 9 }, (_, i) => `f${i}.mjs:${i + 1} "quote ${i}"`).join('; ')}`;
  assert.equal(parseEvidence(many).length, MAX_EVIDENCE_PER_FINDING);
});

test('quoteIsAt: within the line window, whitespace and quote marks ignored, too short or out of range refused', () => {
  assert.equal(quoteIsAt(CHECKOUT, 4, 'return applyDiscount(cart.subtotal, cart.rate);'), true);
  assert.equal(quoteIsAt(CHECKOUT, 4, 'return   applyDiscount( cart.subtotal,\n cart.rate );'), false, 'punctuation spacing is not whitespace folding');
  assert.equal(quoteIsAt(CHECKOUT, 4, 'return  applyDiscount(cart.subtotal,   cart.rate);'), true, 'runs of spaces fold');
  assert.equal(quoteIsAt(CHECKOUT, 4 + LINE_WINDOW, 'return applyDiscount(cart.subtotal, cart.rate);'), true, 'edge of the window');
  assert.equal(quoteIsAt(`${'\n'.repeat(30)}${CHECKOUT}`, 4, 'return applyDiscount(cart.subtotal, cart.rate);'), false, 'far from the line');
  assert.equal(quoteIsAt(CHECKOUT, 4, 'abc'), false, 'too short to prove anything');
  assert.equal(quoteIsAt(CHECKOUT, 0, 'return applyDiscount'), false);
  assert.equal(quoteIsAt(CHECKOUT, 1.5, 'return applyDiscount'), false);
  assert.equal(quoteIsAt(null, 4, 'return applyDiscount'), false);
  assert.equal(quoteIsAt('He said "hi" there', 1, 'He said hi there'), true, 'quote marks are not part of the proof');
});

test('assessFindings: a finding about outside code is verified, unverified or unproven by its evidence', () => {
  const diffFiles = ['src/pricing.mjs'];
  const a = assessFindings({
    review: review(
      finding('High', 'src/checkout.mjs', 'Evidence: src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate);"'),
      finding('High', 'src/checkout.mjs', 'Evidence: src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate, cart.currency);"'),
      finding('Medium', 'docs/pricing.md', ''),
      finding('Medium', 'src/pricing.mjs', ''),
      finding('Low', 'docs/pricing.md', ''),
    ),
    diffFiles,
    lookup,
  });
  assert.deepEqual(a.findings.map((f) => [f.severity, f.outside, f.status, f.unproven]), [
    ['high', true, 'verified', false],
    ['high', true, 'unverified', true],
    ['medium', true, 'none', true],
    ['medium', false, 'none', false],
    ['low', true, 'none', false],
  ]);
  assert.deepEqual([a.blocking, a.outside, a.verified, a.unverified, a.unproven], [4, 4, 1, 1, 2]);
  assert.deepEqual(evidenceCounts(a), { findings: 5, blocking: 4, outside: 4, verified: 1, unverified: 1, unproven: 2 });
});

test('assessFindings: a finding in the diff, or citing no file, needs no proof; a lookup that fails proves nothing', () => {
  const a = assessFindings({ review: review('- [High] No location at all.', finding('High', 'tests/a.test.mjs', ''), finding('High', 'a.mjs', 'Evidence: nowhere.mjs:3 "some text here"')), diffFiles: ['src/a.mjs', 'tests/a.test.mjs'], lookup: () => { throw new Error('boom'); } });
  assert.deepEqual(a.findings.map((f) => [f.outside, f.status, f.unproven]), [[false, 'none', false], [false, 'none', false], [false, 'unverified', false]]);
  const gone = assessFindings({ review: review(finding('High', 'src/checkout.mjs', 'Evidence: src/checkout.mjs:4 "return applyDiscount"')), diffFiles: ['src/pricing.mjs'], lookup: () => null });
  assert.deepEqual([gone.findings[0].status, gone.unproven], ['unverified', 1], 'the file is not in the tree');
  assert.deepEqual(assessFindings({ review: 'No issues section at all.', diffFiles: [], lookup }).findings, []);
  assert.deepEqual(assessFindings({ review: undefined, diffFiles: undefined, lookup }).findings, []);
});

test('assessFindings reads the evidence of the incident of PR #279 (a document contradicted by the change) like any other', () => {
  const doc = 'The review suite stops at the evidence and cut-code stages.\n';
  const a = assessFindings({
    review: review(finding('Medium', 'docs/code-generation.md', 'Evidence: docs/code-generation.md:1 "The review suite stops at the evidence and cut-code stages."')),
    diffFiles: ['scripts/lib/eval_suites.mjs', 'docs/evals.md'],
    lookup: (p) => (p === 'docs/code-generation.md' ? doc : null),
  });
  assert.deepEqual([a.findings[0].outside, a.findings[0].status, a.unproven], [true, 'verified', 0]);
});

test('assessFindings checks at most MAX_FINDINGS_CHECKED findings', () => {
  const many = Array.from({ length: MAX_FINDINGS_CHECKED + 10 }, () => finding('High', 'x/y.mjs', ''));
  assert.equal(assessFindings({ review: review(...many), diffFiles: ['other.mjs'], lookup }).findings.length, MAX_FINDINGS_CHECKED);
});

test('formatEvidenceCheck lists the outside findings and their evidence; formatUnprovenNote says why the review is withheld', () => {
  const a = assessFindings({
    review: review(
      finding('High', 'src/checkout.mjs', 'Evidence: src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate);"'),
      finding('High', 'docs/pricing.md', ''),
      finding('Medium', 'src/pricing.mjs', ''),
    ),
    diffFiles: ['src/pricing.mjs'],
    lookup,
  });
  const section = formatEvidenceCheck(a);
  assert.match(section, /### 🔎 Evidence Check/);
  assert.match(section, /- ✅ verified — \[high\] `src\/checkout\.mjs` \(outside the diff\): `src\/checkout\.mjs:4` found/);
  assert.match(section, /- ⚠️ unproven — \[high\] `docs\/pricing\.md` \(outside the diff\): no evidence quoted/);
  assert.doesNotMatch(section, /src\/pricing\.mjs/, 'a finding in the diff is not listed');
  assert.match(formatUnprovenNote({ unproven: 2 }), /every blocking finding above \(2\) concerns code outside the diff/);
  assert.equal(formatEvidenceCheck({ findings: [] }), '');
  assert.equal(formatEvidenceCheck(undefined), '');
});

test('formatEvidenceCheck flattens model text: no backtick, control character or long paths get through', () => {
  const evil = `x/${'y'.repeat(300)}\`\u0001.mjs`;
  const a = { findings: [{ severity: 'high', files: [evil], blocking: true, outside: true, evidence: [{ path: evil, line: 2, quote: 'q', found: false }], status: 'unverified', unproven: true }] };
  const section = formatEvidenceCheck(a);
  assert.doesNotMatch(section.split('\n').slice(4).join('\n').replace(/`/g, ''), /\u0001/);
  assert.ok(section.split('\n').every((line) => line.length < 600));
});

test('assessFindings: with no list of the files of the diff nothing is outside it, and nothing is judged', () => {
  const r = review(finding('High', 'src/checkout.mjs', ''));
  for (const diffFiles of [[], undefined]) {
    const a = assessFindings({ review: r, diffFiles, lookup });
    assert.deepEqual([a.findings[0].outside, a.findings[0].unproven, a.outside, a.unproven], [false, false, 0, 0]);
  }
});

test('impactLookup rebuilds the lines an Impact analysis lists, at their line numbers, and nothing else', () => {
  const impact = { symbols: [
    { name: 'a', refs: [{ path: 'src/checkout.mjs', line: 4, text: '  return applyDiscount(cart.subtotal, cart.rate);' }, { path: 'src/checkout.mjs', line: 1, text: 'import { applyDiscount } from "./pricing.mjs";' }] },
    { name: 'b', refs: [{ path: 'src/other.mjs', line: 2, text: 'b(1, 2)' }, { path: 'src/bad.mjs', line: 0, text: 'x' }, { path: 'src/bad.mjs', line: 1e9, text: 'x' }, { path: 'src/bad.mjs', line: 1.5, text: 'x' }] },
  ] };
  const lookup = impactLookup(impact);
  assert.equal(lookup('src/checkout.mjs').split('\n')[3], '  return applyDiscount(cart.subtotal, cart.rate);');
  assert.equal(quoteIsAt(lookup('src/checkout.mjs'), 4, 'return applyDiscount(cart.subtotal, cart.rate);'), true);
  assert.equal(quoteIsAt(lookup('src/checkout.mjs'), 4, 'something the block never listed'), false);
  assert.equal(lookup('src/elsewhere.mjs'), null);
  assert.equal(lookup('src/bad.mjs'), null, 'lines out of range are not kept');
  assert.equal(impactLookup(null)('x'), null);
  assert.equal(impactLookup({ symbols: [{ name: 'a' }] })('x'), null);
});
