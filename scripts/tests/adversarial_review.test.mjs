import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVERSARIAL_AXES, MIN_CRITICAL_POINTS, analyzeAdversarial, enforceAdversarialProtocol, formatProtocolNote, verifyAxes,
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

test('blockingFindingAxes ignores the continuation lines of a Low finding, and of any non-finding bullet', async () => {
  const { blockingFindingAxes } = await import('../lib/adversarial_review.mjs');
  const review = [
    '### ⚠️ Issues Found',
    '- [High] Crash — File: a.mjs Lines: 3 Axis: robustness',
    '- [Low] Naming — File: b.mjs Lines: 1',
    '  Root cause: r Fix: f Axis: types',
    '- Not a finding',
    '  Axis: issue_fit',
    '',
    '### 🚀 Verdict',
    'REQUEST_CHANGES',
  ].join('\n');
  assert.deepEqual(blockingFindingAxes(review), ['robustness']);
  assert.deepEqual(blockingFindingAxes('### Issues Found\n- [Medium] x — File: a.mjs\n  continued Axis: side_effects'), ['side_effects'], 'a High / Medium continuation still counts');
});

const DIFF = 'diff --git a/config/models.yaml b/config/models.yaml\n--- a/config/models.yaml\n+++ b/config/models.yaml\n@@ -3,2 +3,4 @@\n-# old note\n+# New note about review_max_input_tokens\n+# and parseConfig() callers\n';

test('verifyAxes (ADR-0065, shadow): an axis line is verified when it names something that is in the diff', () => {
  const v = verifyAxes(review([
    '- **Robustness** — none: `config/models.yaml` lines 3-5 are comments, no key or value changed',
    '- **Side effects** — config/models.yaml:4 the note quotes review_max_input_tokens, a dated claim that can go stale',
    '- **Type integrity** — none, checked the return shape',
    '- **Issue fit** — none: the issue asks for parseConfig() callers to be documented and the diff does',
  ].join('\n')), DIFF);
  assert.deepEqual(v, { verified: ['robustness', 'side_effects', 'issue_fit'], count: 3 });
});

test('verifyAxes: a label, a placeholder, a plain-word line and a name that is not in the diff verify nothing', () => {
  const lines = [
    '- **Robustness** — <risk file:line, or none + what you checked>',
    '- **Side effects** — none',
    '- **Type integrity** — nothing found in the empty and boundary cases that were checked',
    '- **Issue fit** — none: other.mjs:9 is untouched and `unrelatedSymbol` is not used here',
  ].join('\n');
  assert.deepEqual(verifyAxes(review(lines), DIFF), { verified: [], count: 0 });
});

test('verifyAxes: any one line of an axis may verify it, a missing section or an empty diff verifies nothing, input may be null', () => {
  const two = review('- **Robustness** — none, checked the null case\n- **Robustness** — config/models.yaml:3 only comment lines changed here');
  assert.deepEqual(verifyAxes(two, DIFF), { verified: ['robustness'], count: 1 });
  assert.deepEqual(verifyAxes('### ✅ Summary\nNo analysis here.', DIFF), { verified: [], count: 0 });
  assert.deepEqual(verifyAxes(two, ''), { verified: [], count: 0 });
  assert.deepEqual(verifyAxes(null, undefined), { verified: [], count: 0 });
});

test('verifyAxes reads names through markup and a :line suffix, and keeps the axis order', () => {
  const v = verifyAxes(review([
    '- **Issue fit** — none: **`parseConfig()`** callers are described in the new note',
    '- **Robustness** — none: config/models.yaml:3-4 holds only comment lines',
    '- **Side effects** — none: `config/models.yaml:4` is a comment, nothing reads it',
  ].join('\n')), DIFF);
  assert.deepEqual(v.verified, ['robustness', 'side_effects', 'issue_fit']);
});

test('verifyAxes: a template placeholder is not a statement, even when it holds a name from the diff', () => {
  assert.deepEqual(verifyAxes(review('- **Robustness** — <`config/models.yaml:3` or none + what you checked>'), DIFF), { verified: [], count: 0 });
  assert.deepEqual(verifyAxes(review('- **Robustness** — `config/models.yaml:3` or none + what you checked'), DIFF), { verified: ['robustness'], count: 1 });
});

test('analyzeAdversarial is unchanged by the shared axis parser: the same counts on the same reviews', () => {
  const a = analyzeAdversarial(review(FULL));
  assert.deepEqual([a.present, a.criticalPoints, a.atRisk], [true, 2, ['robustness', 'side_effects']]);
  assert.deepEqual(analyzeAdversarial('### Summary\nnone').axes.map((x) => x.covered), [false, false, false, false]);
});

test('verifyAxes: a name must stand alone in the diff, not be a piece of a longer name', () => {
  const diff = 'diff --git a/src/data.json b/src/data.json\n--- a/src/data.json\n+++ b/src/data.json\n@@ -1 +1 @@\n-RATED = 1\n+RATED = 2\n';
  const line = (text) => review(`- **Robustness** — ${text}`);
  assert.deepEqual(verifyAxes(line('none: `a.js` is not touched by this change at all'), diff), { verified: [], count: 0 }, 'a.js inside data.json');
  assert.deepEqual(verifyAxes(line('none: `RATE` is not touched by this change at all'), diff), { verified: [], count: 0 }, 'RATE inside RATED');
  assert.deepEqual(verifyAxes(line('none: src/data.json holds only the value that changes here'), diff), { verified: ['robustness'], count: 1 });
  assert.deepEqual(verifyAxes(line('none: `RATED` is the only name that changes in this diff'), diff), { verified: ['robustness'], count: 1 });
  assert.deepEqual(verifyAxes(line('none: `a.b(c)` is read with regex chars like [x] and (y) in this line'), 'x\n+a.b(c)\n'), { verified: ['robustness'], count: 1 }, 'regex characters are escaped');
});

test('verifyAxes: for a file name or a path a dot or a dash goes on with the name; an identifier may be followed by a dot', () => {
  const diffOf = (file, body = '+x') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}\n`;
  const count = (text, diff) => verifyAxes(review(`- **Robustness** — ${text}`), diff).count;
  const untouched = 'none: `a.js` is not touched by this change here';
  // The name continues: another extension after it, another name before or after it.
  for (const file of ['src/a.js.map', 'src/x.a.js', 'src/my-a.js', 'src/a.js-old']) assert.equal(count(untouched, diffOf(file)), 0, file);
  assert.equal(count('none: src/a.js is not touched by this change here', diffOf('src/a.js.map')), 0, 'a path, followed by another extension');
  assert.equal(count('none: src/a.js.map is only a generated file in this change', diffOf('src/a.js.map')), 1, 'the whole name');
  // The name stands alone: end of a sentence, an import path, the basename of a path.
  assert.equal(count('none: `a.js` is the only file changed by this diff.', diffOf('src/a.js')), 1);
  assert.equal(count('none: `a.js` is the only file changed by this diff', diffOf('src/b.mjs', "+import x from './a.js';")), 1);
  // An identifier is not a file name: a property access after it is fine, a longer identifier is not.
  assert.equal(count('none: `RATE` is the only name changed by this diff', diffOf('src/b.mjs', '+const v = RATE.value;')), 1);
  assert.equal(count('none: `RATE` is the only name changed by this diff', diffOf('src/b.mjs', '+RATED = 2')), 0);
});

test('verifyAxes: a name written in the review is looked up whole, never as a piece of it', () => {
  const diffOf = (file, body = '+x') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${body}\n`;
  const count = (text, diff) => verifyAxes(review(`- **Robustness** — ${text}`), diff).count;
  const notPart = (name) => `none: ${name} is not part of this change at all here`;
  // The review cites a longer name than the diff holds: `a.js` must not be cut out of it, nor `my_file` out of `my_file.mjs.map`.
  assert.equal(count(notPart('src/a.js.map'), diffOf('src/a.js')), 0, 'a path with another extension');
  assert.equal(count(notPart('a.js-old'), diffOf('src/a.js')), 0, 'a file name followed by a dash');
  assert.equal(count(notPart('`a.js.map`'), diffOf('src/a.js')), 0, 'the same in a code span');
  assert.equal(count(notPart('x.a.js'), diffOf('src/a.js')), 0, 'a name that starts with another one');
  assert.equal(count(notPart('my_file.mjs.map'), diffOf('src/my_file.mjs')), 0, 'an identifier inside a file name');
  // The name as written is in the diff: with a sentence dot, a :line suffix, as a property chain or in a code span.
  assert.equal(count('none: the only file is src/a.js.', diffOf('src/a.js')), 1);
  assert.equal(count('none: src/a.js:12 only holds the changed literal here', diffOf('src/a.js')), 1);
  assert.equal(count('none: `RATE.value` is read once in the changed line', diffOf('src/b.mjs', '+const v = RATE.value;')), 1);
  assert.equal(count('none: `parseConfig()` callers are unchanged by this diff', diffOf('src/b.mjs', '+parseConfig(x)')), 1);
  assert.equal(count('none: review_max_input_tokens is the only name here', diffOf('src/b.mjs', '+review_max_input_tokens: 1')), 1);
});
