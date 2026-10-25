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

test('matchFindings reports as many defects as possible: a finding that two defects could take goes to the one nothing else explains', () => {
  // The first finding fits both defects (lines and a cleanup word for the first, a link word for the second); the
  // second fits only the first. Best-fit-first would give the first finding to the first defect and strand the second.
  const leak = E({ id: 'LEAK', lines: [30, 36], match: 'leak|cleanup|temporary' });
  const link = E({ id: 'LINK', match: 'symlink|symbolic|link' });
  const both = D('medium', 'src/a.mjs', [31, 31], 'a symlink is followed into the temporary tree during cleanup');
  const onlyLeak = D('medium', 'src/a.mjs', [34, 34], 'no cleanup when the copy fails');
  const r = matchFindings([leak, link], [both, onlyLeak]);
  assert.deepEqual(r.matched, [{ id: 'LEAK', detected: 1 }, { id: 'LINK', detected: 0 }]);
  assert.deepEqual([r.missed, r.unmatched], [[], []]);
  const rest = analyzeFindings(review(finding('Medium', 'a', 'src/a.mjs', '31', 'a symlink is followed into the temporary tree during cleanup'), finding('Medium', 'b', 'src/a.mjs', '34', 'no cleanup when the copy fails')), [leak, link]);
  assert.deepEqual([rest.recall, rest.precision], [1, 1]);
});

test('matchFindings reports the maximum number of defects, checked against an exhaustive search on random cases', () => {
  // Feasibility is the file, the lines when both are known, and one shared word when the defect names its cause.
  // Scores differ (lines, how many of the defect's words a finding uses), so a strong pair can tempt an assignment
  // away from the largest set of pairs.
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const files = ['a.mjs', 'b.mjs', 'c.mjs'];
  const words = ['red', 'green', 'blue', 'cyan'];
  const some = (list) => list.filter(() => rand(2) === 0);
  for (let round = 0; round < 400; round++) {
    const expected = Array.from({ length: 1 + rand(5) }, (_, i) => {
      const cause = some(words);
      const at = rand(30);
      return E({ id: `E${i}`, path: files[rand(3)], ...(cause.length ? { match: cause.join('|') } : {}), ...(rand(2) ? { lines: [at, at + rand(3)] } : {}) });
    });
    const detected = Array.from({ length: rand(6) }, () => {
      const at = rand(30);
      return { severity: 'high', files: some(files), lines: rand(3) ? [at, at + rand(2)] : null, text: some(words).join(' ') };
    });
    const near = (a, b) => a[0] - 5 <= b[1] && b[0] - 5 <= a[1];
    const fits = (e, d) => d.files.includes(e.path)
      && (!e.lines || !d.lines || near([e.lines[0], e.lines[1]], d.lines))
      && (!e.match || e.match.split('|').some((w) => d.text.includes(w)));
    const best = (ei, used) => (ei === expected.length ? 0 : Math.max(
      best(ei + 1, used),
      ...detected.map((d, di) => (!used.has(di) && fits(expected[ei], d) ? 1 + best(ei + 1, new Set([...used, di])) : -1)),
    ));
    const r = matchFindings(expected, detected);
    assert.equal(r.matched.length, best(0, new Set()), `round ${round}`);
    assert.equal(new Set(r.matched.map((m) => m.detected)).size, r.matched.length, `round ${round}: a finding used twice`);
    for (const m of r.matched) assert.ok(fits(expected.find((e) => e.id === m.id), detected[m.detected]), `round ${round}: unfit pair`);
    assert.equal(r.matched.length + r.missed.length, expected.length);
  }
});

test('matchFindings: a strong pair never costs a defect that a weaker pair could have reported', () => {
  // X fits finding 1 very well (file, lines, both words) and finding 2 only a little; the other defect fits finding 1 only.
  // Taking the strong pair first would strand the second defect: 4 points for one defect, against 2.5 + 1 for two.
  const strong = E({ id: 'X', path: 'src/a.mjs', lines: [10], match: 'red|green' });
  const weak = E({ id: 'Y', path: 'src/b.mjs' });
  const f1 = { severity: 'high', files: ['src/a.mjs', 'src/b.mjs'], lines: [10, 10], text: 'red green' };
  const f2 = { severity: 'high', files: ['src/a.mjs'], lines: null, text: 'red' };
  const r = matchFindings([strong, weak], [f1, f2]);
  assert.deepEqual(r.matched, [{ id: 'X', detected: 1 }, { id: 'Y', detected: 0 }]);
  assert.deepEqual(r.missed, []);
});

test('matchFindings: more defects than findings, more findings than defects, and none of either', () => {
  const defects = [E({ id: 'A' }), E({ id: 'B', path: 'src/b.mjs' }), E({ id: 'C', path: 'src/c.mjs' })];
  const one = matchFindings(defects, [D('high', 'src/b.mjs', [1, 1])]);
  assert.deepEqual([one.matched, one.missed], [[{ id: 'B', detected: 0 }], ['A', 'C']]);
  const many = matchFindings([E({ id: 'A' })], [D('high', 'src/x.mjs', [1, 1]), D('high', 'src/a.mjs', [1, 1]), D('high', 'src/y.mjs', [1, 1])]);
  assert.deepEqual([many.matched, many.unmatched], [[{ id: 'A', detected: 1 }], [0, 2]]);
  assert.deepEqual(matchFindings([], [D('high', 'src/a.mjs', [1, 1])]), { matched: [], missed: [], unmatched: [0] });
  assert.deepEqual(matchFindings([E()], []), { matched: [], missed: ['BUG-1'], unmatched: [] });
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
