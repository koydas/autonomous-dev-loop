import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVERSARIAL_AXES, MIN_CRITICAL_POINTS, analyzeAdversarial, enforceAdversarialProtocol, formatProtocolNote,
} from '../lib/adversarial_review.mjs';

const review = (analysis, verdict = 'APPROVED') => `### ✅ Summary\nSmall change.\n\n### 🔬 Adversarial Analysis\n${analysis}\n\n### ⚠️ Issues Found\nNone.\n\n### 🚀 Verdict\n${verdict}`;
const FULL = [
  '- **Robustness** — a.mjs:12 an empty list reaches reduce() with no initial value',
  '- **Side effects** — b.mjs:3 the cache is shared with the retry path',
  '- **Type integrity** — none, checked the return shape of parse()',
  '- **Issue fit** — none, the diff matches the issue',
].join('\n');

test('analyzeAdversarial counts the axes that name a risk, not the ones that say none', () => {
  const a = analyzeAdversarial(review(FULL));
  assert.equal(a.present, true);
  assert.equal(a.criticalPoints, 2);
  assert.deepEqual(a.atRisk, ['robustness', 'side_effects']);
  assert.deepEqual(a.axes.map((x) => [x.id, x.covered, x.risk]), [['robustness', true, true], ['side_effects', true, true], ['types', true, false], ['issue_fit', true, false]]);
});

test('analyzeAdversarial accepts the separator and bullet variants a model produces', () => {
  const variants = [
    '* Robustness: a.mjs:1 null input crashes\n* Side effects - b.mjs:2 mutates the shared options object',
    '1. **Robustness:** a.mjs:1 null input crashes\n2. **Side effects:** b.mjs:2 mutates the shared options object',
    '- Edge cases — a.mjs:1 null input crashes\n- Hidden side-effects — b.mjs:2 mutates the shared options object',
    '- **Robustness** – a.mjs:1 null input crashes\n- **Side effects** – b.mjs:2 mutates the shared options object',
  ];
  for (const v of variants) assert.equal(analyzeAdversarial(review(v)).criticalPoints, 2, v);
  const labels = analyzeAdversarial(review('- **Types** — a.mjs:4 the id is coerced to a string\n- **Issue adequacy** — the issue also asks for a retry cap, absent'));
  assert.deepEqual(labels.atRisk, ['types', 'issue_fit']);
});

test('analyzeAdversarial: "none" in its several forms, a bare label and an echoed template placeholder are not risks', () => {
  const none = [
    '- **Robustness** — none, checked empty and null inputs',
    '- **Side effects** — No risk found in the callers',
    '- **Type integrity** — N/A',
    '- **Issue fit** — Nothing beyond the issue',
  ].join('\n');
  assert.equal(analyzeAdversarial(review(none)).criticalPoints, 0);
  assert.equal(analyzeAdversarial(review('- **Robustness** — ok')).criticalPoints, 0, 'too short to be an observation');
  const echoed = '- **Robustness** — <risk file:line, or none + what you checked>\n- **Side effects** — <same>';
  assert.equal(analyzeAdversarial(review(echoed)).criticalPoints, 0, 'a placeholder is not an analysis');
});

test('analyzeAdversarial counts an axis once, ignores unknown axes and stops at the next heading', () => {
  const twice = '- **Robustness** — a.mjs:1 null input crashes\n- **Robustness** — a.mjs:9 an empty string crashes too';
  assert.equal(analyzeAdversarial(review(twice)).criticalPoints, 1);
  assert.equal(analyzeAdversarial(review('- **Performance** — a.mjs:1 quadratic loop in the hot path')).criticalPoints, 0);
  // Issues Found bullets after the section must not be read as axes.
  const after = `### 🔬 Adversarial Analysis\n- **Robustness** — a.mjs:1 null input crashes\n\n### ⚠️ Issues Found\n- **Side effects** — [High] b.mjs:2 mutates the shared options object\n`;
  assert.equal(analyzeAdversarial(after).criticalPoints, 1);
  const bold = `**🔬 Adversarial Analysis**\n- Robustness: a.mjs:1 null input crashes\n**🚀 Verdict**\n- Side effects: b.mjs:2 mutates the shared options object`;
  assert.deepEqual(analyzeAdversarial(bold).atRisk, ['robustness']);
});

test('analyzeAdversarial: no section, empty or non-string input is present:false with no point', () => {
  for (const input of ['### Verdict\nAPPROVED', '', null, undefined, 42]) {
    const a = analyzeAdversarial(input);
    assert.deepEqual([a.present, a.criticalPoints, a.atRisk], [false, 0, []]);
    assert.equal(a.axes.length, ADVERSARIAL_AXES.length);
  }
  const header = analyzeAdversarial('### 🔬 Adversarial Analysis\n\n### 🚀 Verdict\nAPPROVED');
  assert.deepEqual([header.present, header.criticalPoints], [true, 0]);
});

test('enforceAdversarialProtocol withholds an APPROVE below the minimum and nothing else', () => {
  const ok = analyzeAdversarial(review(FULL));
  const one = analyzeAdversarial(review('- **Robustness** — a.mjs:12 an empty list reaches reduce()\n- **Side effects** — none, checked the callers'));
  const missing = analyzeAdversarial('### Verdict\nAPPROVED');
  const approve = { verdict: 'APPROVE', reason: null };
  assert.deepEqual(enforceAdversarialProtocol(approve, ok), approve);
  assert.deepEqual(enforceAdversarialProtocol(approve, one), { verdict: 'WITHHELD', reason: `adversarial protocol not met (1 of ${MIN_CRITICAL_POINTS} critical points listed)` });
  assert.deepEqual(enforceAdversarialProtocol(approve, missing), { verdict: 'WITHHELD', reason: 'adversarial protocol not met (no Adversarial Analysis section)' });
  for (const decision of [{ verdict: 'REQUEST_CHANGES', reason: null }, { verdict: 'REQUEST_CHANGES', reason: 'failing checks: tests' }, { verdict: 'WITHHELD', reason: 'evidence missing' }]) {
    assert.equal(enforceAdversarialProtocol(decision, missing), decision, `${decision.verdict} passes through`);
  }
  assert.equal(enforceAdversarialProtocol(approve, one, { minPoints: 1 }), approve, 'the minimum is a parameter');
});

test('formatProtocolNote says which axes named a risk, or that the section is missing', () => {
  const partial = formatProtocolNote(analyzeAdversarial(review('- **Robustness** — a.mjs:12 an empty list reaches reduce()\n- **Side effects** — none')));
  assert.match(partial, /Approval withheld/);
  assert.match(partial, /Robustness: risk named; Side effects: no risk named; Type integrity: no risk named; Issue fit: no risk named/);
  assert.match(partial, /auto-fix is not triggered/);
  assert.match(formatProtocolNote(analyzeAdversarial('Verdict: APPROVED')), /the section is missing/);
});

test('blockingFindingAxes keeps the closed axis ids tagged on High and Medium findings only', async () => {
  const { blockingFindingAxes } = await import('../lib/adversarial_review.mjs');
  const issues = [
    '### ⚠️ Issues Found',
    '- [High] Crash on empty input — File: a.mjs Lines: 3 Root cause: r Fix: f Axis: robustness',
    '- [Medium] Caller broken — File: b.mjs Lines: 9 Root cause: r Fix: f Axis: Side effects',
    '- [Low] Naming — File: c.mjs Lines: 1 Root cause: r Fix: f Axis: types',
    '- [High] Wrong shape — File: d.mjs Lines: 2',
    '  Root cause: r Fix: f Axis: **type_integrity**',
    '- [Medium] Odd — File: e.mjs Axis: performance',
    '',
    '### 🚀 Verdict',
    '- [High] Not a finding — Axis: issue_fit',
  ].join('\n');
  assert.deepEqual(blockingFindingAxes(issues), ['robustness', 'side_effects', 'types'], 'axis order; Low, unknown and post-verdict tags ignored');
  assert.deepEqual(blockingFindingAxes('### ⚠️ Issues Found\nNone.'), []);
  assert.deepEqual(blockingFindingAxes('- [High] x Axis: robustness'), [], 'outside Issues Found');
  assert.deepEqual(blockingFindingAxes(null), []);
  assert.deepEqual(blockingFindingAxes('### Issues Found\n1. [High] x — Axis: issue_fit\n2. [Medium] y — Axis: issue fit'), ['issue_fit']);
});
