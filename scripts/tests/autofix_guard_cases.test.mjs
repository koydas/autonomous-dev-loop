import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnsafeChanges } from '../lib/autofix_guard.mjs';

// The write guard of auto-fix and generation (ADR-0029) on test files: active cases and kept assertions (issue #339).
function ctx({ existing = {}, shown = [], hidden = [] } = {}) {
  return {
    existing: new Map(Object.entries(existing)),
    shownPaths: new Set(shown),
    hiddenPaths: new Set(hidden),
  };
}

const CASES = "test('alpha case', () => {\n  assert.equal(add(1, 2), 3);\n  assert.ok(ready);\n});\ntest('beta case', () => {\n  assert(true);\n});\n";
const guardTest = (before, after) => findUnsafeChanges(
  [{ targetPath: 'scripts/tests/a.test.mjs', fileContent: after }],
  ctx({ existing: { 'scripts/tests/a.test.mjs': before }, shown: ['scripts/tests/a.test.mjs'] }),
);

test('findUnsafeChanges: a case turned skip or todo, by modifier or by options, is a test_count_drop naming the state', () => {
  const conversions = [
    ["test.skip('alpha case', () => {", /"alpha case" skipped/],
    ["test.todo('alpha case', () => {", /"alpha case" todo/],
    ["test('alpha case', { skip: true }, () => {", /"alpha case" skipped/],
    ["test('alpha case', { todo: 'later' }, () => {", /"alpha case" todo/],
  ];
  for (const [line, reason] of conversions) {
    const violations = guardTest(CASES, CASES.replace("test('alpha case', () => {", line));
    assert.deepEqual(violations.map((v) => v.rule), ['test_count_drop'], line);
    assert.match(violations[0].reason, /^active test cases drop by 1 \(/, line);
    assert.match(violations[0].reason, reason, line);
  }
});

test('findUnsafeChanges: an already-skipped case kept as is, test.only and a falsy skip option are not drops', () => {
  const skipped = `${CASES}it.skip('pending case', () => {});\n`;
  assert.deepEqual(guardTest(skipped, `${skipped}test('new case', () => { assert.ok(1); });\n`), []);
  assert.deepEqual(guardTest(CASES, CASES.replace("test('alpha case'", "test.only('alpha case'")), []);
  assert.deepEqual(guardTest(CASES, CASES.replace("test('alpha case', () => {", "test('alpha case', { skip: false, timeout: 5 }, () => {")), []);
  // Deleting an already-skipped case still drops the raw count: detected as before.
  assert.match(guardTest(skipped, CASES)[0].reason, /test count drops from 3 to 2/);
});

test('findUnsafeChanges: assertion_count_drop on a kept case, not on added, moved, commented or quoted assertions', () => {
  const weakened = CASES.replace('  assert.equal(add(1, 2), 3);\n', '');
  const [v] = guardTest(CASES, weakened);
  assert.deepEqual([v.rule, v.reason], ['assertion_count_drop', 'test case "alpha case" keeps its title but its assertions drop from 2 to 1']);
  assert.equal(guardTest(CASES, CASES.replace('assert.equal(add(1, 2), 3);', '// assert.equal(add(1, 2), 3);'))[0].rule, 'assertion_count_drop', 'commented out: a comment is not an assertion');
  assert.equal(guardTest(CASES, CASES.replace('assert.equal(add(1, 2), 3);', "const note = 'assert.equal(add(1, 2), 3)';"))[0].rule, 'assertion_count_drop', 'a string is not an assertion');
  assert.deepEqual(guardTest(CASES, `${CASES}test('gamma case', () => {\n  assert.ok(x);\n});\n`), [], 'added case');
  const moved = "test('beta case', () => {\n  assert(true);\n});\ntest('alpha case', () => {\n  assert.ok(ready);\n  assert.equal(add(1, 2), 3);\n});\n";
  assert.deepEqual(guardTest(CASES, moved), [], 'moved case');
  assert.deepEqual(guardTest(CASES, CASES.replace('assert(true);', 't.assert.ok(true);')), [], 't.assert counts as an assertion');
  assert.deepEqual(guardTest(CASES, CASES.replace('assert.ok(ready);', 'assert.ok(ready); // assert.ok(other)')), [], 'a commented assertion added counts for nothing');
});

test('findUnsafeChanges: the new checks apply to JavaScript test files only, and no waiver applies in the write guard', () => {
  const py = findUnsafeChanges(
    [{ targetPath: 'tests/test_a.py', fileContent: "test.skip('alpha case', () => {});" }],
    ctx({ existing: { 'tests/test_a.py': "test('alpha case', () => { assert.ok(1); });" }, shown: ['tests/test_a.py'] }),
  );
  assert.deepEqual(py, []);
  const named = findUnsafeChanges(
    [{ targetPath: 'scripts/tests/a.test.mjs', fileContent: CASES.replace('  assert.ok(ready);\n', '') }],
    { ...ctx({ existing: { 'scripts/tests/a.test.mjs': CASES }, shown: ['scripts/tests/a.test.mjs'] }), mentionText: 'the alpha case test is wrong' },
  );
  assert.deepEqual(named.map((v) => v.rule), ['assertion_count_drop']);
});

test('findUnsafeChanges (PR #345 review): a skip beside a nested option is a drop; a regex added to a kept case is not an assertion drop', () => {
  assert.match(guardTest(CASES, CASES.replace("test('alpha case', () => {", "test('alpha case', { skip: true, signal: new AbortController({}).signal }, () => {"))[0].reason, /"alpha case" skipped/);
  assert.deepEqual(guardTest(CASES, CASES.replace('  assert.ok(ready);', '  const re = /\\)/;\n  assert.ok(ready);')), []);
});

test('findUnsafeChanges (PR #345 review, round 2): a commented skip option is still a test_count_drop', () => {
  assert.match(guardTest(CASES, CASES.replace("test('alpha case', () => {", "test('alpha case', { /* flaky */ skip: true }, () => {"))[0].reason, /"alpha case" skipped/);
});

test('findUnsafeChanges (PR #345 review, round 3): an escaped quote beside a skip option is still a test_count_drop', () => {
  assert.match(guardTest(CASES, CASES.replace("test('alpha case', () => {", "test('alpha case', { label: 'it\\'s flaky', skip: true }, () => {"))[0].reason, /"alpha case" skipped/);
});
