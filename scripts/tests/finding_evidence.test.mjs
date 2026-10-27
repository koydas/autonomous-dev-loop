import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINE_WINDOW, MAX_EVIDENCE_PER_FINDING, MAX_FINDINGS_CHECKED, MIN_QUOTE_CHARS, FINDING_STATUSES, assessFindings, diffHunkRanges, substantiateFindings, evidenceCounts, formatEvidenceCheck, formatUnprovenNote, impactLookup, parseEvidence, quoteIsAt,
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
  assert.deepEqual(evidenceCounts(a), { findings: 5, blocking: 4, outside: 4, verified: 1, supported: 0, unverified: 1, refuted: 0, unproven: 2 });
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

const DIFF = 'diff --git a/src/pricing.mjs b/src/pricing.mjs\n--- a/src/pricing.mjs\n+++ b/src/pricing.mjs\n@@ -1,3 +1,3 @@\n-export function applyDiscount(price, rate) {\n+export function applyDiscount(price, rate, currency) {\n   return price * rate;\n }\n';

test('formatEvidenceCheck lists every blocking finding with its status; formatUnprovenNote says why the review is withheld', () => {
  const a = substantiateFindings({
    review: review(
      finding('High', 'src/checkout.mjs', 'Evidence: src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate);"'),
      finding('High', 'docs/pricing.md', ''),
      finding('Medium', 'src/pricing.mjs', ''),
      finding('High', 'src/checkout.mjs', 'Evidence: src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate, cart.currency);"'),
      finding('Low', 'src/pricing.mjs', ''),
    ),
    rawDiff: DIFF,
    lookup,
  });
  const section = formatEvidenceCheck(a);
  assert.match(section, /### 🔎 Evidence Check/);
  assert.match(section, /- ✅ verified — \[high\] `src\/checkout\.mjs` \(outside the diff\): `src\/checkout\.mjs:4` found/);
  assert.match(section, /- ⚠️ unverified — \[high\] `docs\/pricing\.md` \(outside the diff\): no evidence quoted/);
  assert.match(section, /- ✔️ supported — \[medium\] `src\/pricing\.mjs`\n/);
  assert.match(section, /- ❌ refuted — \[high\] `src\/checkout\.mjs` \(outside the diff\): `src\/checkout\.mjs:4` not found/);
  assert.equal(section.match(/src\/pricing\.mjs/g).length, 1, 'a Low finding in the diff is not listed');
  assert.match(formatUnprovenNote({ unproven: 2 }), /every blocking finding above \(2\) is unsubstantiated/);
  assert.equal(formatEvidenceCheck({ findings: [] }), '');
  assert.equal(formatEvidenceCheck(undefined), '');
});

test('diffHunkRanges: old and new ranges per file under both paths; a file with no hunk has none', () => {
  const rename = 'diff --git a/old.mjs b/new.mjs\nsimilarity index 100%\nrename from old.mjs\nrename to new.mjs\n';
  const ranges = diffHunkRanges(`${DIFF}${rename}diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -10 +10,0 @@\n-gone\n`);
  assert.deepEqual(ranges.get('src/pricing.mjs'), [[1, 3], [1, 3]]);
  assert.deepEqual([ranges.get('old.mjs'), ranges.get('new.mjs')], [[], []]);
  assert.deepEqual(ranges.get('x.mjs'), [[10, 10], [10, 10]], 'a single-line hunk and an empty new side still cover their line');
  assert.equal(diffHunkRanges('').size, 0);
  assert.equal(diffHunkRanges(undefined).size, 0);
});

test('substantiateFindings: verified, supported, refuted and unverified, and which of them are unproven', () => {
  const at = (sev, file, lines, rest = '') => `- [${sev}] Title — File: ${file} Lines: ${lines} Root cause: it breaks. ${rest} Fix: change it.`;
  const a = substantiateFindings({
    review: review(
      at('High', 'src/pricing.mjs', '2'),
      at('High', 'src/pricing.mjs', '2', 'Evidence: src/pricing.mjs:2 "this text is not in the file at all"'),
      at('High', 'src/pricing.mjs', '400'),
      at('Medium', 'docs/pricing.md', '3', 'Evidence: docs/pricing.md:3 "Discounts are always rounded to cents."'),
      at('Medium', 'docs/pricing.md', '3', 'Evidence: docs/pricing.md:3 "Discounts are never rounded to cents."'),
      at('Medium', 'docs/missing.md', '3', 'Evidence: docs/missing.md:3 "some text that cannot be read"'),
      at('Medium', 'docs/pricing.md', '3'),
      at('Low', 'docs/pricing.md', '3'),
    ),
    rawDiff: DIFF,
    lookup,
  });
  assert.deepEqual(a.findings.map((f) => [f.severity, f.status, f.unproven]), [
    ['high', 'supported', false],
    ['high', 'supported', false],
    ['high', 'unverified', true],
    ['medium', 'verified', false],
    ['medium', 'refuted', true],
    ['medium', 'unverified', true],
    ['medium', 'unverified', true],
    ['low', 'unverified', false],
  ]);
  assert.deepEqual([a.verified, a.supported, a.unverified, a.refuted, a.unproven, a.blocking, a.outside], [1, 2, 4, 1, 4, 7, 5]);
  assert.deepEqual(FINDING_STATUSES, ['verified', 'supported', 'unverified', 'refuted']);
});

test('substantiateFindings: a finding with no file is unverified, a file with no hunk is located, no diff header judges nothing', () => {
  const noFile = '- [High] Title — Root cause: it breaks somewhere. Fix: change it.';
  const rename = 'diff --git a/old.mjs b/new.mjs\nsimilarity index 100%\nrename from old.mjs\nrename to new.mjs\n';
  const f = (rawDiff, text) => substantiateFindings({ review: review(text), rawDiff, lookup }).findings[0];
  assert.deepEqual([f(DIFF, noFile).status, f(DIFF, noFile).unproven], ['unverified', true]);
  assert.equal(f(rename, '- [High] Title — File: new.mjs Lines: 90 Root cause: x. Fix: y.').status, 'supported');
  for (const rawDiff of ['', undefined, 'not a diff']) assert.deepEqual([f(rawDiff, noFile).status, f(rawDiff, noFile).unproven], ['supported', false], String(rawDiff));
  assert.equal(f(DIFF, finding('High', 'pricing.mjs', '')).status, 'supported', 'a path suffix names the file');
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

test('parseEvidence reads a quote whole when it holds quote marks or semicolons of its own', () => {
  const nested = 'Evidence: src/caller.mjs:1 "return applyDiscount(cart.subtotal, "USD", cart.rate);" Fix: x';
  assert.deepEqual(parseEvidence(nested), [{ path: 'src/caller.mjs', line: 1, quote: 'return applyDiscount(cart.subtotal, "USD", cart.rate);' }]);
  assert.deepEqual(parseEvidence('Evidence: a.mjs:1 `const s = `x` + y;` Fix: x'), [{ path: 'a.mjs', line: 1, quote: 'const s = `x` + y;' }]);
  assert.deepEqual(parseEvidence('Evidence: a.mjs:1 “say “hello” twice” Fix: x'), [{ path: 'a.mjs', line: 1, quote: 'say “hello” twice' }]);
  // Items are still told apart, and the text between a closing mark and the next item is not part of a quote.
  assert.deepEqual(parseEvidence('Evidence: a.mjs:1 "first, with a; semicolon" and b.mjs:2 "second item here" (see above) Fix: x'), [
    { path: 'a.mjs', line: 1, quote: 'first, with a; semicolon' },
    { path: 'b.mjs', line: 2, quote: 'second item here' },
  ]);
  // A quote that is never closed proves nothing.
  assert.deepEqual(parseEvidence('Evidence: a.mjs:1 "never closed Fix: x'), []);
  assert.deepEqual(parseEvidence('Evidence: a.mjs:1 " Fix: x'), []);
});

test('assessFindings: a quote that holds more than the file does is unverified, not accepted by its prefix', () => {
  const caller = 'export function total(cart) {\n  return applyDiscount(cart.subtotal, cart.rate);\n}\n';
  const lookupCaller = (p) => (p === 'src/caller.mjs' ? caller : null);
  const claim = (quote) => assessFindings({ review: review(`- [High] Wrong argument — File: src/caller.mjs Lines: 2 Root cause: x. Evidence: src/caller.mjs:2 "${quote}" Fix: y.`), diffFiles: ['src/pricing.mjs'], lookup: lookupCaller }).findings[0];
  assert.equal(claim('return applyDiscount(cart.subtotal, "USD", cart.rate);').status, 'unverified', 'the USD argument is not in the file');
  assert.equal(claim('return applyDiscount(cart.subtotal, cart.rate);').status, 'verified');
  assert.equal(claim('return applyDiscount(cart.subtotal, cart.rate); // and more').status, 'unverified');
});

test('a quote proves something only when it is specific: MIN_QUOTE_CHARS characters at least', () => {
  const text = 'function f() {\n  return value;\n}\n';
  assert.equal(MIN_QUOTE_CHARS, 12);
  assert.equal(quoteIsAt(text, 2, 'return'), false, 'one common word is in every file');
  assert.equal(quoteIsAt(text, 2, 'return valu'), false, '11 characters');
  assert.equal(quoteIsAt(text, 2, 'return value'), true, '12 characters');
});

test('assessFindings: a verified quote from another file proves nothing about the file the finding cites', () => {
  const tree2 = { 'src/checkout.mjs': CHECKOUT, 'docs/pricing.md': '# Pricing\n\nDiscounts are always rounded to cents.\n' };
  const lookup2 = (p) => tree2[p] ?? null;
  const assess = (file, evidence) => assessFindings({ review: review(`- [High] Stale — File: ${file} Lines: 3 Root cause: x. Evidence: ${evidence} Fix: y.`), diffFiles: ['src/pricing.mjs'], lookup: lookup2 }).findings[0];
  assert.equal(assess('docs/pricing.md', 'src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate);"').status, 'unverified', 'true quote, wrong file');
  assert.equal(assess('docs/pricing.md', 'docs/pricing.md:3 "Discounts are always rounded to cents."').status, 'verified');
  assert.equal(assess('docs/pricing.md', 'src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate);"; docs/pricing.md:3 "Discounts are always rounded to cents."').status, 'verified', 'one quote in the cited file is enough, the others must still be found');
  assert.equal(assess('docs/pricing.md', 'src/checkout.mjs:4 "return applyDiscount(cart.subtotal, cart.rate);"; docs/pricing.md:3 "Discounts are never rounded at all."').status, 'unverified');
  assert.equal(assess('pricing.md', 'docs/pricing.md:3 "Discounts are always rounded to cents."').status, 'verified', 'a bare file name is a suffix of the path');
});
