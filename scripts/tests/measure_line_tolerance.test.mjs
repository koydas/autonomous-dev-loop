import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PINNED_RUN, buildReplays, classifyUnverified, formatTable, measureReplays } from '../measure_line_tolerance.mjs';
import { diffHunkRanges } from '../lib/finding_evidence.mjs';

// Synthetic offline fixture: src/a.mjs has one hunk, lines 10-12 on both sides; old.txt -> new.txt is a pure rename (no hunk).
const DIFF = [
  'diff --git a/src/a.mjs b/src/a.mjs',
  '--- a/src/a.mjs',
  '+++ b/src/a.mjs',
  '@@ -10,3 +10,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  'diff --git a/old.txt b/new.txt',
  'similarity index 100%',
  'rename from old.txt',
  'rename to new.txt',
  '',
].join('\n');
const ranges = diffHunkRanges(DIFF);
const at = (file, lines, sev = 'High') => `- [${sev}] Title — File: ${file}${lines ? ` Lines: ${lines}` : ''} Root cause: it breaks. Fix: change it. Axis: robustness`;
const review = (...findings) => `### ✅ Summary\nx\n\n### ⚠️ Issues Found\n${findings.join('\n')}\n\n### 🚀 Verdict\nREQUEST_CHANGES\n`;
const replay = (findings, repeat = 0, id = 'c1') => ({ id, repeat, review: review(...findings), diff: DIFF });

test('classifyUnverified: the gap is the minimum absolute distance to the nearest hunk, 0 inside it', () => {
  const gap = (lines) => classifyUnverified({ files: ['src/a.mjs'], lines }, ranges);
  assert.deepEqual(gap([11, 11]), { kind: 'gap', gap: 0 });
  assert.deepEqual(gap([5, 10]), { kind: 'gap', gap: 0 }, 'overlapping the first hunk line');
  assert.deepEqual(gap([17, 17]), { kind: 'gap', gap: 5 });
  assert.deepEqual(gap([18, 30]), { kind: 'gap', gap: 6 });
  assert.deepEqual(gap([1, 4]), { kind: 'gap', gap: 6 }, 'before the hunk: 10 - 4');
});

test('classifyUnverified: no file, file outside the diff, line missing and file without hunk are separate kinds', () => {
  assert.deepEqual(classifyUnverified({ files: [], lines: null }, ranges), { kind: 'no_file' });
  assert.deepEqual(classifyUnverified({ files: ['src/other.mjs'], lines: [1, 1] }, ranges), { kind: 'off_diff' });
  assert.deepEqual(classifyUnverified({ files: ['src/a.mjs'], lines: null }, ranges), { kind: 'no_line' });
  assert.deepEqual(classifyUnverified({ files: ['new.txt'], lines: [40, 40] }, ranges), { kind: 'no_hunk' });
});

test('a finding at distance 6 is unverified under the tolerance of 5, one at 5 is supported', () => {
  const m = measureReplays([replay([at('src/a.mjs', '17'), at('src/a.mjs', '18')])]);
  assert.equal(m.statuses.supported, 1);
  assert.equal(m.statuses.unverified, 1);
  assert.deepEqual(m.supported.gaps, { 5: 1 });
  assert.deepEqual(m.unverified.gaps, [{ id: 'c1', repeat: 0, gap: 6 }]);
  assert.equal(m.window.length, 1);
  assert.equal(m.locationTolerance, 6, 'the 6-10 window raises the location tolerance to its maximum gap');
});

test('buckets are cumulative, off-diff / no-file are counted apart, and only 6-10 gaps enter the window', () => {
  const m = measureReplays([replay([at('src/a.mjs', '20'), at('src/a.mjs', '22'), at('src/a.mjs', '31'), at('src/a.mjs', '60'), at('src/zzz.mjs', '3'), at('nowhere', null), '- [High] Title — Root cause: no file named. Fix: change it. Axis: robustness', at('src/a.mjs', '11')])]);
  assert.equal(m.total, 8);
  assert.deepEqual(m.statuses, { verified: 0, supported: 1, unverified: 7, refuted: 0 });
  // line 20 -> gap 8, 22 -> 10, 31 -> 19, 60 -> 48
  assert.deepEqual(m.unverified.gaps.map((g) => g.gap), [8, 10, 19, 48]);
  assert.equal(m.unverified.within10, 2);
  assert.equal(m.unverified.within20, 3);
  assert.equal(m.unverified.beyond20, 1);
  assert.equal(m.unverified.off_diff, 2);
  assert.equal(m.unverified.no_file, 1);
  assert.equal(m.supported.no_line, 0);
  assert.equal(m.window.length, 2);
  assert.equal(m.locationTolerance, 10);
});

test('a finding with no line or on a file without hunk is supported, never unverified', () => {
  const m = measureReplays([replay([at('src/a.mjs', null), at('new.txt', '99')])]);
  assert.deepEqual(m.statuses, { verified: 0, supported: 2, unverified: 0, refuted: 0 });
  assert.equal(m.supported.no_line, 1);
  assert.equal(m.supported.no_hunk, 1);
  assert.equal(m.unverified.no_line + m.unverified.no_hunk, 0);
});

test('with nothing in the 6-10 window the location tolerance stays at the default of 5', () => {
  const m = measureReplays([replay([at('src/a.mjs', '11'), at('src/a.mjs', '40')])]);
  assert.equal(m.window.length, 0);
  assert.equal(m.locationTolerance, 5);
});

test('each blocking finding counts once per case and repeat; Low findings are not counted', () => {
  const m = measureReplays([replay([at('src/a.mjs', '11'), at('src/a.mjs', '11', 'Low')], 0), replay([at('src/a.mjs', '11')], 1), replay([at('src/a.mjs', '11')], 0, 'c2')]);
  assert.equal(m.total, 3);
  assert.equal(m.statuses.supported, 3);
});

test('formatTable prints every bucket of the measurement', () => {
  const text = formatTable(measureReplays([replay([at('src/a.mjs', '18'), at('src/zzz.mjs', '1')])]));
  assert.match(text, /\| unverified \| 2 \|/);
  assert.match(text, /gap ≤ 10 \(cumulative\) \| 1 \|/);
  assert.match(text, /file outside the diff \| 1 \|/);
  assert.match(text, /gap 6–10 \(decides the tolerance\) \| 1 \|/);
});

// buildReplays: the pinned-input checks (the dataset text is synthetic, so its hash is patched into the pinned value).
const datasetLine = JSON.stringify({ id: 'c1', input: { diff: DIFF }, expected: { verdict: 'REQUEST_CHANGES' } });
const sha = createHash('sha256').update(datasetLine).digest('hex');
const rawAnswer = review(at('src/a.mjs', '11'));
const goodRun = () => ({
  meta: { ...PINNED_RUN, dataset_sha256: PINNED_RUN.dataset_sha256 },
  results: [0, 1, 2].map((repeat) => ({ case_id: 'c1', repeat, error: null, calls: [{ raw: rawAnswer }] })),
});

test('buildReplays accepts only the pinned run: repeats, model, run id and dataset hash are checked', () => {
  assert.throws(() => buildReplays({ run: { ...goodRun(), meta: { ...PINNED_RUN, repeats: 1 } }, datasetText: datasetLine }), /meta\.repeats is 1/);
  assert.throws(() => buildReplays({ run: { ...goodRun(), meta: { ...PINNED_RUN, model: 'other' } }, datasetText: datasetLine }), /meta\.model is other/);
  assert.throws(() => buildReplays({ run: { ...goodRun(), meta: { ...PINNED_RUN, workflow_run_id: '1' } }, datasetText: datasetLine }), /workflow_run_id is 1/);
  assert.throws(() => buildReplays({ run: { ...goodRun(), meta: { ...PINNED_RUN, dataset_sha256: 'x' } }, datasetText: datasetLine }), /meta\.dataset_sha256 is x/);
  assert.throws(() => buildReplays({ run: goodRun(), datasetText: datasetLine }), new RegExp(`dataset sha256 is ${sha}`), 'a dataset whose hash differs from the pinned one');
  assert.throws(() => buildReplays({ run: undefined, datasetText: datasetLine }), /meta\.repeats is undefined/);
});

test('the pinned dataset hash is the one of the published run', () => {
  assert.equal(PINNED_RUN.dataset_sha256, '9add3de8ef544693a1fc73d51b01278869b8f2bcd1fb534b5938b678d178ce25');
  assert.equal(PINNED_RUN.repeats, 3);
  assert.equal(PINNED_RUN.workflow_run_id, '40161093183');
});
