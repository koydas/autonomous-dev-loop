import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findUnsafeChanges,
  countDeletedLines,
  countTestCalls,
  isTestFile,
  normalizeRepoPath,
  MIN_DELETED_LINES_ALLOWED,
} from '../lib/autofix_guard.mjs';

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');

function ctx({ existing = {}, shown = [], hidden = [] } = {}) {
  return {
    existing: new Map(Object.entries(existing)),
    shownPaths: new Set(shown),
    hiddenPaths: new Set(hidden),
  };
}

test('normalizeRepoPath strips ./ prefixes, backslashes and redundant segments', () => {
  assert.equal(normalizeRepoPath('./src//a/../b.js'), 'src/b.js');
  assert.equal(normalizeRepoPath('src\\b.js'), 'src/b.js');
  assert.equal(normalizeRepoPath(undefined), '.');
});

test('isTestFile matches test/spec suffixes and test directories, not regular sources', () => {
  assert.equal(isTestFile('src/foo.test.mjs'), true);
  assert.equal(isTestFile('src/foo.spec.ts'), true);
  assert.equal(isTestFile('tests/helpers.js'), true);
  assert.equal(isTestFile('src/__tests__/a.js'), true);
  assert.equal(isTestFile('src/contest.js'), false);
});

test('countTestCalls counts test(), it() and their only/skip/todo variants', () => {
  assert.equal(countTestCalls("test('a', () => {});\nit('b', () => {});\ntest.skip('c');\nit.only('d')"), 4);
  assert.equal(countTestCalls('const attest = 1; latest(x);'), 0);
  assert.equal(countTestCalls(null), 0);
});

test('countDeletedLines ignores blank lines and moved lines', () => {
  assert.deepEqual(countDeletedLines('a\n\nb\nc', 'c\na\nb'), { deleted: 0, total: 3 });
  assert.deepEqual(countDeletedLines('a\nb\nc', 'a'), { deleted: 2, total: 3 });
});

test('countDeletedLines treats duplicated lines as a multiset', () => {
  assert.deepEqual(countDeletedLines('x\nx\nx', 'x'), { deleted: 2, total: 3 });
});

test('findUnsafeChanges accepts a new file', () => {
  const changes = [{ targetPath: 'src/new.js', fileContent: 'x' }];
  assert.deepEqual(findUnsafeChanges(changes, ctx({ existing: { 'src/new.js': null } })), []);
});

test('findUnsafeChanges treats a path missing from the existing map as a new file', () => {
  assert.deepEqual(findUnsafeChanges([{ targetPath: 'a.js', fileContent: 'x' }], ctx()), []);
});

test('findUnsafeChanges accepts a targeted edit on a shown file', () => {
  const before = lines(100);
  const after = before.replace('line 5', 'line 5 fixed');
  const changes = [{ targetPath: './src/a.js', fileContent: after }];
  assert.deepEqual(findUnsafeChanges(changes, ctx({ existing: { 'src/a.js': before }, shown: ['src/a.js'] })), []);
});

test('findUnsafeChanges rejects a withheld file', () => {
  const changes = [{ targetPath: 'src/big.js', fileContent: 'x' }];
  const violations = findUnsafeChanges(changes, ctx({ existing: { 'src/big.js': lines(10) }, hidden: ['src/big.js'] }));
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /withheld/);
});

test('findUnsafeChanges rejects an existing file that was not shown', () => {
  const changes = [{ targetPath: 'src/other.js', fileContent: 'x' }];
  const violations = findUnsafeChanges(changes, ctx({ existing: { 'src/other.js': lines(3) } }));
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /not shown/);
});

test('findUnsafeChanges rejects deleting more than 30% of a large file', () => {
  const before = lines(200);
  const after = lines(100);
  const violations = findUnsafeChanges(
    [{ targetPath: 'src/a.js', fileContent: after }],
    ctx({ existing: { 'src/a.js': before }, shown: ['src/a.js'] }),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /removes 100 of 200 non-blank lines \(limit 60\)/);
});

test('findUnsafeChanges allows deleting up to the absolute floor on a small file', () => {
  const before = lines(MIN_DELETED_LINES_ALLOWED);
  const violations = findUnsafeChanges(
    [{ targetPath: 'src/a.js', fileContent: 'replacement' }],
    ctx({ existing: { 'src/a.js': before }, shown: ['src/a.js'] }),
  );
  assert.deepEqual(violations, []);
});

test('findUnsafeChanges rejects a full rewrite: every changed line counts as deleted', () => {
  const before = lines(100);
  const after = lines(100, 'rewritten');
  const violations = findUnsafeChanges(
    [{ targetPath: 'src/a.js', fileContent: after }],
    ctx({ existing: { 'src/a.js': before }, shown: ['src/a.js'] }),
  );
  assert.equal(violations.length, 1);
});

test('findUnsafeChanges rejects a test file whose test count drops', () => {
  const before = "test('a', () => {});\ntest('b', () => {});\ntest('c', () => {});";
  const after = "test('a', () => {});\ntest('b', () => {});";
  const violations = findUnsafeChanges(
    [{ targetPath: 'src/a.test.js', fileContent: after }],
    ctx({ existing: { 'src/a.test.js': before }, shown: ['src/a.test.js'] }),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /test count drops from 3 to 2/);
});

test('findUnsafeChanges accepts a test file that adds tests', () => {
  const before = "test('a', () => {});";
  const after = "test('a', () => {});\ntest('b', () => {});";
  assert.deepEqual(
    findUnsafeChanges(
      [{ targetPath: 'src/a.test.js', fileContent: after }],
      ctx({ existing: { 'src/a.test.js': before }, shown: ['src/a.test.js'] }),
    ),
    [],
  );
});

test('findUnsafeChanges reports every unsafe change, not only the first', () => {
  const violations = findUnsafeChanges(
    [
      { targetPath: 'a.js', fileContent: 'x' },
      { targetPath: 'b.js', fileContent: 'x' },
      { targetPath: 'c.js', fileContent: 'x' },
    ],
    ctx({ existing: { 'a.js': 'old', 'b.js': 'old', 'c.js': null }, hidden: ['a.js'] }),
  );
  assert.deepEqual(violations.map((v) => v.targetPath), ['a.js', 'b.js']);
});
