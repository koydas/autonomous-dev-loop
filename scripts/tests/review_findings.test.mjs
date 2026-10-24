import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFindings, pathMatches, matchFindings, analyzeFindings, validateExpectedFindings, FINDING_NEEDS,
} from '../lib/review_findings.mjs';

const finding = (sev, title, file, lines, cause = 'a cause') => `- [${sev}] ${title} — File: ${file} Lines: ${lines} Root cause: ${cause} Fix: f Axis: robustness`;

test('parseFindings reads severity, files and lines of each finding bullet', () => {
  const out = parseFindings([finding('High', 'Off by one', 'src/a.mjs', '10-12', 'loop uses <='), finding('Low', 'Naming', '`src/b.mjs`', 'unknown')].join('\n'));
  assert.deepEqual(out.map((f) => [f.severity, f.files, f.lines]), [['high', ['src/a.mjs'], [10, 12]], ['low', ['src/b.mjs'], null]]);
});

test('parseFindings: bold severity, numbered bullets, inline path:line, several files, a single line', () => {
  const out = parseFindings([
    '* **[Medium]** Mixed — File: ./src/a.mjs, src/b.mjs Lines: 7 Root cause: r',
    '2. [High] Inline — File: `src/c.mjs:40-44` Root cause: r',
  ].join('\n'));
  assert.deepEqual(out[0].files, ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(out[0].lines, [7, 7]);
  assert.equal(out[1].severity, 'high');
  assert.deepEqual([out[1].files, out[1].lines], [['src/c.mjs'], [40, 44]]);
});

test('parseFindings: continuation lines belong to their finding, a bullet that is not a finding ends it', () => {
  const out = parseFindings([
    finding('High', 'First', 'src/a.mjs', '1'),
    '  Axis detail on a second line',
    '- None.',
    '  this indented line follows a bullet that is not a finding',
    finding('Low', 'Second', 'src/b.mjs', '2'),
  ].join('\n'));
  assert.equal(out.length, 2);
  assert.match(out[0].text, /Axis detail on a second line/);
  assert.doesNotMatch(out[0].text, /follows a bullet/);
  assert.doesNotMatch(out[1].text, /follows a bullet/);
});

test('parseFindings: no section, empty or no finding gives none', () => {
  assert.deepEqual(parseFindings(''), []);
  assert.deepEqual(parseFindings(undefined), []);
  assert.deepEqual(parseFindings('None.'), []);
  assert.deepEqual(parseFindings('- None.\n- nothing to report'), []);
});

test('pathMatches: equal, or one a /-suffix of the other, never a partial name', () => {
  assert.equal(pathMatches('scripts/lib/a.mjs', 'scripts/lib/a.mjs'), true);
  assert.equal(pathMatches('a.mjs', 'scripts/lib/a.mjs'), true);
  assert.equal(pathMatches('scripts/lib/a.mjs', 'a.mjs'), true);
  assert.equal(pathMatches('./lib/a.mjs', 'lib/a.mjs'), true);
  assert.equal(pathMatches('xa.mjs', 'scripts/a.mjs'), false);
  assert.equal(pathMatches('lib/a.mjs', 'lib/b.mjs'), false);
});

const E = (over = {}) => ({ id: 'BUG-1', path: 'src/a.mjs', severity: 'high', ...over });
const D = (sev, file, lines, text = 'cause') => ({ severity: sev, files: [file], lines, text });

test('matchFindings: path is required, lines are compared with a tolerance, unknown lines do not disqualify', () => {
  const near = matchFindings([E({ lines: [10, 12] })], [D('high', 'src/a.mjs', [15, 15])]);
  assert.equal(near.matched.length, 1);
  const far = matchFindings([E({ lines: [10, 12] })], [D('high', 'src/a.mjs', [40, 41])]);
  assert.deepEqual([far.matched.length, far.missed], [0, ['BUG-1']]);
  const unknown = matchFindings([E({ lines: [10, 12] })], [D('high', 'src/a.mjs', null)]);
  assert.equal(unknown.matched.length, 1);
  const otherFile = matchFindings([E()], [D('high', 'src/other.mjs', [10, 12])]);
  assert.equal(otherFile.matched.length, 0);
});

test('matchFindings: the cause must be named when the case says what it is', () => {
  const e = E({ match: 'symlink|link' });
  assert.equal(matchFindings([e], [D('high', 'src/a.mjs', [1, 1], 'a symlink is followed')]).matched.length, 1);
  assert.equal(matchFindings([e], [D('high', 'src/a.mjs', [1, 1], 'naming is unclear')]).matched.length, 0);
});

test('matchFindings: a blocking defect needs a High or Medium finding, an advisory one accepts Low', () => {
  assert.equal(matchFindings([E()], [D('low', 'src/a.mjs', [1, 1])]).matched.length, 0);
  assert.equal(matchFindings([E()], [D('medium', 'src/a.mjs', [1, 1])]).matched.length, 1);
  assert.equal(matchFindings([E({ blocking: false })], [D('low', 'src/a.mjs', [1, 1])]).matched.length, 1);
});

test('matchFindings is one to one: a single finding cannot account for two defects, and the best fit wins', () => {
  const two = matchFindings([E({ id: 'A' }), E({ id: 'B' })], [D('high', 'src/a.mjs', [1, 1])]);
  assert.deepEqual([two.matched.map((m) => m.id), two.missed], [['A'], ['B']]);
  const generic = D('high', 'src/a.mjs', [1, 1], 'unrelated');
  const specific = D('high', 'src/a.mjs', [1, 1], 'symlink pinned by target');
  const best = matchFindings([E({ match: 'symlink' })], [generic, specific]);
  assert.deepEqual(best.matched, [{ id: 'BUG-1', detected: 1 }]);
  assert.deepEqual(best.unmatched, [0]);
});

test('matchFindings assigns a finding to the defect it describes best, not to the first defect that could take it', () => {
  const first = E({ id: 'FRAMING', match: 'digest|hash|separator|collision|framing' });
  const second = E({ id: 'LINK', match: 'symlink|symbolic|link|follow' });
  const finding = D('medium', 'src/a.mjs', [1, 1], 'A symbolic link is pinned by its target name in the digest, but copying follows the link');
  const r = matchFindings([first, second], [finding]);
  assert.deepEqual(r.matched, [{ id: 'LINK', detected: 0 }]);
  assert.deepEqual(r.missed, ['FRAMING']);
  // The same finding with a single defect to explain still goes to it.
  assert.deepEqual(matchFindings([first], [finding]).matched, [{ id: 'FRAMING', detected: 0 }]);
});

test('matchFindings: ties go to the earlier defect and the earlier finding, and matches are reported in the order of the defects', () => {
  const same = D('high', 'src/a.mjs', [1, 1], 'same text');
  const r = matchFindings([E({ id: 'A' }), E({ id: 'B' })], [same, { ...same }]);
  assert.deepEqual(r.matched, [{ id: 'A', detected: 0 }, { id: 'B', detected: 1 }]);
  const ordered = matchFindings([E({ id: 'A', path: 'src/x.mjs', match: 'zzz' }), E({ id: 'B' })], [D('high', 'src/a.mjs', [1, 1])]);
  assert.deepEqual(ordered.matched, [{ id: 'B', detected: 0 }]);
});

const review = (...lines) => lines.join('\n');
const three = [
  E({ id: 'BUG-1', path: 'src/a.mjs', lines: [10], needs: 'diff' }),
  E({ id: 'BUG-2', path: 'src/b.mjs', lines: [20], needs: 'context' }),
  E({ id: 'BUG-3', path: 'src/c.mjs', lines: [30], needs: 'reasoning', severity: 'medium' }),
];
const found = (n) => review(...[finding('High', 'one', 'src/a.mjs', '10'), finding('High', 'two', 'src/b.mjs', '20'), finding('Medium', 'three', 'src/c.mjs', '30')].slice(0, n));

test('analyzeFindings measures 0/3, 1/3, 2/3 and 3/3 defects found, not the verdict', () => {
  for (const n of [0, 1, 2, 3]) {
    const r = analyzeFindings(found(n), three);
    assert.equal(r.recall, n / 3, `${n}/3`);
    assert.equal(r.matched.length, n);
    assert.equal(r.missed.length, 3 - n);
  }
});

test('analyzeFindings: missed defects carry what it takes to see them', () => {
  assert.deepEqual(analyzeFindings(found(1), three).missed, [{ id: 'BUG-2', needs: 'context' }, { id: 'BUG-3', needs: 'reasoning' }]);
});

test('analyzeFindings: precision counts blocking findings that are no known defect; Low findings and acceptable ones do not', () => {
  const noisy = review(found(2), finding('High', 'invented', 'src/z.mjs', '1'), finding('Low', 'style', 'src/y.mjs', '2'));
  const r = analyzeFindings(noisy, three);
  assert.equal(r.precision, 2 / 3);
  assert.equal(r.falsePositives.length, 1);
  const accepted = analyzeFindings(noisy, three, { acceptable: [{ path: 'src/z.mjs' }] });
  assert.equal(accepted.precision, 1);
  assert.equal(accepted.falsePositives.length, 0);
  const byText = analyzeFindings(noisy, three, { acceptable: [{ match: 'invented' }] });
  assert.equal(byText.falsePositives.length, 0);
});

test('analyzeFindings: critical recall looks at the High defects only', () => {
  assert.equal(analyzeFindings(found(1), three).criticalRecall, 1 / 2);
  assert.equal(analyzeFindings(found(0), three).criticalRecall, 0);
  assert.equal(analyzeFindings(found(3), [E({ id: 'M', path: 'src/c.mjs', severity: 'medium' })]).criticalRecall, null);
});

test('analyzeFindings: a ratio without a denominator is null, not 0 or 1', () => {
  const none = analyzeFindings('', three);
  assert.equal(none.precision, null);
  assert.equal(none.recall, 0);
  const noExpected = analyzeFindings(found(1), []);
  assert.deepEqual([noExpected.recall, noExpected.criticalRecall, noExpected.precision], [null, null, 0]);
  assert.equal(analyzeFindings(found(1), undefined).recall, null);
  const advisoryOnly = analyzeFindings(finding('Low', 'n', 'src/a.mjs', '1'), [E({ blocking: false })]);
  assert.deepEqual([advisoryOnly.recall, advisoryOnly.precision], [null, null]);
});

test('validateExpectedFindings accepts a well formed list and names every problem', () => {
  assert.deepEqual(validateExpectedFindings([{ id: 'A', path: 'src/a.mjs', severity: 'high', lines: [1, 3], match: 'x|y', needs: 'diff', blocking: true }]), []);
  assert.deepEqual(validateExpectedFindings([{ id: 'A', path: 'p', severity: 'low' }]), []);
  for (const bad of [undefined, [], 'x']) assert.equal(validateExpectedFindings(bad).length, 1);
  const problems = validateExpectedFindings([
    null,
    { path: 'p', severity: 'high' },
    { id: 'A', severity: 'high' },
    { id: 'A', path: 'p', severity: 'critical' },
    { id: 'B', path: 'p', severity: 'high', lines: [5, 2] },
    { id: 'C', path: 'p', severity: 'high', lines: 'x', match: '', needs: 'magic', blocking: 'yes' },
  ]).join('\n');
  for (const part of ['not an object', 'id missing', 'path missing', 'duplicate id A', 'severity must be', 'lines must be', 'match must be', 'needs must be', 'blocking must be']) assert.match(problems, new RegExp(part));
  assert.deepEqual([...FINDING_NEEDS], ['diff', 'context', 'knowledge', 'reasoning', 'execution']);
});
