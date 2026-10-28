import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockerCodesOf, buildCaseReport, formatCaseReport } from '../lib/eval_case_report.mjs';
import { caseReportFromFiles } from '../eval_case_report.mjs';

// One recorded run: label is the verdict the suite derived, expected_label the dataset's.
const run = (caseId, repeat, label, expected, blockers = [], extra = {}) => ({
  case_id: caseId, tags: ['t'], repeat, label, expected_label: expected, error: null,
  output: { valid: label === 'valid', blockers }, scores: {}, calls: [], ...extra,
});

test('blockerCodesOf: B1–B4 prefixes, deduplicated and sorted; any other blocker is unknown, never dropped', () => {
  assert.deepEqual(blockerCodesOf(['B3: who manages members?', 'b2 - "fast"', '**B3**: env', 'Missing stub', 'B5: no such rule']),
    ['B2', 'B3', 'unknown']);
  assert.deepEqual(blockerCodesOf([]), []);
  assert.deepEqual(blockerCodesOf(undefined), []);
  assert.deepEqual(blockerCodesOf('B2: not an array'), []);
});

test('a case wrong on every repeat is consistently_wrong; a case whose repeats disagree is inconsistent', () => {
  const report = buildCaseReport([
    run('wrong', 0, 'valid', 'invalid'), run('wrong', 1, 'valid', 'invalid'), run('wrong', 2, 'valid', 'invalid'),
    run('flaky', 0, 'invalid', 'invalid', ['B3: x']), run('flaky', 1, 'valid', 'invalid'), run('flaky', 2, 'invalid', 'invalid', ['B3: y']),
    run('ok', 0, 'valid', 'valid'), run('ok', 1, 'valid', 'valid'), run('ok', 2, 'valid', 'valid'),
  ]);
  const byId = Object.fromEntries(report.cases.map((c) => [c.case_id, c]));
  assert.equal(byId.wrong.kind, 'consistently_wrong');
  assert.equal(byId.wrong.n_incorrect, 3);
  assert.equal(byId.wrong.flips, 0);
  assert.equal(byId.flaky.kind, 'inconsistent');
  assert.equal(byId.flaky.n_incorrect, 1);
  assert.equal(byId.flaky.flips, 2);
  assert.deepEqual(byId.flaky.repeats.map((r) => r.codes), [['B3'], [], ['B3']]);
  assert.equal(byId.ok.kind, 'stable');
  assert.deepEqual([report.inconsistent, report.consistently_wrong, report.stable, report.incorrect_runs], [1, 1, 1, 4]);
  assert.deepEqual([report.n_cases, report.n_runs], [3, 9]);
});

test('sort: incorrect repeats first, then verdict flips, then blocker-code changes, then id', () => {
  const report = buildCaseReport([
    // 1 wrong, 2 flips
    run('b-flaky', 0, 'invalid', 'invalid'), run('b-flaky', 1, 'valid', 'invalid'), run('b-flaky', 2, 'invalid', 'invalid'),
    // 1 wrong, 1 flip
    run('a-once', 0, 'invalid', 'invalid'), run('a-once', 1, 'invalid', 'invalid'), run('a-once', 2, 'valid', 'invalid'),
    // 3 wrong
    run('z-wrong', 0, 'valid', 'invalid'), run('z-wrong', 1, 'valid', 'invalid'), run('z-wrong', 2, 'valid', 'invalid'),
    // correct, the rule changes between repeats
    run('c-codes', 0, 'invalid', 'invalid', ['B2: a']), run('c-codes', 1, 'invalid', 'invalid', ['B3: a']), run('c-codes', 2, 'invalid', 'invalid', ['B3: a']),
    run('d-ok', 0, 'valid', 'valid'), run('d-ok', 1, 'valid', 'valid'), run('d-ok', 2, 'valid', 'valid'),
    run('a-ok', 0, 'valid', 'valid'), run('a-ok', 1, 'valid', 'valid'), run('a-ok', 2, 'valid', 'valid'),
  ]);
  assert.deepEqual(report.cases.map((c) => c.case_id), ['z-wrong', 'b-flaky', 'a-once', 'c-codes', 'a-ok', 'd-ok']);
  assert.equal(report.cases.find((c) => c.case_id === 'c-codes').blocker_flips, 1);
  assert.equal(report.blocker_unstable, 1);
});

test('an errored repeat is a wrong verdict of its own and counts as a flip; repeats are ordered by index', () => {
  const report = buildCaseReport([
    run('e', 2, 'invalid', 'invalid', ['B4: x']),
    run('e', 0, 'invalid', 'invalid', ['B4: x']),
    run('e', 1, null, 'invalid', [], { error: 'Groq API HTTP error 500', output: null }),
  ]);
  const [c] = report.cases;
  assert.deepEqual(c.repeats.map((r) => [r.repeat, r.verdict, r.correct, r.codes]),
    [[0, 'invalid', true, ['B4']], [1, 'error', false, []], [2, 'invalid', true, ['B4']]]);
  assert.equal(c.kind, 'inconsistent');
  assert.equal(c.flips, 2);
  assert.equal(c.n_incorrect, 1);
});

test('a skipped run (no expected label) takes the case\'s expected label; a case with none is never correct', () => {
  const report = buildCaseReport([
    run('s', 0, 'valid', 'valid'),
    run('s', 1, null, null, [], { error: 'Skipped: circuit breaker open', output: null, skipped: true }),
    run('u', 0, 'valid', null),
  ]);
  const byId = Object.fromEntries(report.cases.map((c) => [c.case_id, c]));
  assert.equal(byId.s.expected, 'valid');
  assert.deepEqual(byId.s.repeats.map((r) => r.correct), [true, false]);
  assert.equal(byId.u.expected, null);
  assert.equal(byId.u.kind, 'consistently_wrong');
});

test('an empty or missing results list gives an empty report', () => {
  for (const results of [[], undefined]) {
    const report = buildCaseReport(results);
    assert.deepEqual([report.n_cases, report.n_runs, report.cases], [0, 0, []]);
    assert.match(formatCaseReport(report), /Every case is stable and correct/);
  }
});

test('formatCaseReport: one column per repeat, wrong repeats marked, expected codes shown; stable cases only with all', () => {
  const report = buildCaseReport([
    run('wrong', 0, 'valid', 'invalid'), run('wrong', 1, 'valid', 'invalid'),
    run('ok', 0, 'valid', 'valid'), run('ok', 1, 'valid', 'valid'),
    run('short', 0, 'invalid', 'invalid', ['B2: x']),
  ], { expectedBlockers: { wrong: ['B2'] } });
  const md = formatCaseReport(report);
  assert.match(md, /\| case \| kind \| expected \| #1 \| #2 \| wrong \| flips \| code changes \|/);
  assert.match(md, /\| wrong \| consistently_wrong \| invalid B2 \| valid ✗ — \| valid ✗ — \| 2\/2 \| 0 \| 0 \|/);
  assert.doesNotMatch(md, /\| ok \|/);
  assert.doesNotMatch(md, /\| short \|/);
  const all = formatCaseReport(report, { all: true });
  assert.match(all, /\| ok \| stable \| valid \| valid — \| valid — \| 0\/2 \| 0 \| 0 \|/);
  // A case with fewer repeats than the widest one leaves its missing cells empty.
  assert.match(all, /\| short \| stable \| invalid \| invalid B2 \|  \| 0\/1 \| 0 \| 0 \|/);
  assert.match(md, /3 cases \/ 5 runs · 2 incorrect runs · inconsistent 0 · consistently wrong 1 · stable 2/);
});

// The CLI reads files only: every path it may touch is served from memory, anything else throws.
const files = (map) => ({
  read: (p) => { if (!(p in map)) throw new Error(`ENOENT ${p}`); return map[p]; },
  exists: (p) => p in map,
});
const recorded = JSON.stringify({
  meta: { dataset: 'data.jsonl' },
  results: [run('a', 0, 'valid', 'invalid'), run('a', 1, 'invalid', 'invalid', ['B3: who?']), run('b', 0, 'valid', 'valid')],
});
const dataset = [
  '// comment',
  JSON.stringify({ id: 'a', input: {}, expected: { valid: false, blockers: ['B3'] } }),
  JSON.stringify({ id: 'b', input: {}, expected: { valid: true } }),
].join('\n');

test('CLI: same recorded JSON → byte-identical report, expected codes read from the run\'s dataset', () => {
  const fs = files({ 'run.json': recorded, 'data.jsonl': dataset });
  const first = caseReportFromFiles(['run.json'], fs);
  assert.equal(caseReportFromFiles(['run.json'], fs), first);
  assert.match(first, /\| a \| inconsistent \| invalid B3 \| valid ✗ — \| invalid B3 \| 1\/2 \| 1 \| 1 \|/);
  const json = JSON.parse(caseReportFromFiles(['run.json', '--json'], fs));
  assert.deepEqual(json.cases.find((c) => c.case_id === 'a').expected_codes, ['B3']);
  assert.match(caseReportFromFiles(['run.json', '--all'], fs), /\| b \| stable \|/);
});

test('CLI: the meta.dataset of a results file from another checkout may be absent; --dataset must exist', () => {
  const fs = files({ 'run.json': recorded });
  assert.match(caseReportFromFiles(['run.json'], fs), /\| a \| inconsistent \| invalid \|/);
  assert.throws(() => caseReportFromFiles(['run.json', '--dataset', 'missing.jsonl'], fs), /ENOENT missing\.jsonl/);
  const other = files({ 'run.json': recorded, 'other.jsonl': JSON.stringify({ id: 'a', input: {}, expected: { valid: false, blockers: ['B2'] } }) });
  assert.match(caseReportFromFiles(['run.json', '--dataset', 'other.jsonl'], other), /\| a \| inconsistent \| invalid B2 \|/);
});

test('CLI: usage, unreadable, malformed and result-less files fail with the file named', () => {
  const fs = files({ 'bad.json': '{', 'none.json': '{"meta":{}}', 'run.json': recorded });
  assert.throws(() => caseReportFromFiles([], fs), /usage: eval_case_report\.mjs/);
  assert.throws(() => caseReportFromFiles(['run.json', 'run.json'], fs), /usage/);
  assert.throws(() => caseReportFromFiles(['missing.json'], fs), /missing\.json: cannot read results \(ENOENT/);
  assert.throws(() => caseReportFromFiles(['bad.json'], fs), /bad\.json: cannot read results/);
  assert.throws(() => caseReportFromFiles(['none.json'], fs), /none\.json: no results\[\] array/);
});
