import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm test` only runs scripts/tests/*.test.mjs, so a test file written anywhere
// else, or in Jest syntax, passes CI without ever running. The auto-fix loop has
// done both (test/output_writer.test.mjs from #119, ecb6382 on #165). These checks
// run inside `npm test`, so the review evidence job reports them as a failing check.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_DIR = 'scripts/tests/';
const TEST_FILE = /\.test\.(?:m|c)?[jt]sx?$/;
// Exactly the files `npm test` runs: scripts/tests/*.test.mjs, no subdirectories.
const RUNNABLE_TEST = /^scripts\/tests\/[^/]+\.test\.mjs$/;
const JEST_API = /\bjest\.\w+\s*\(|\bexpect\s*\(/;
const SELF = path.basename(fileURLToPath(import.meta.url));
const NODE_TEST_IMPORT = /from\s+['"]node:test['"]/;

function listTrackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function findMisplacedTestFiles(files) {
  return files.filter((file) => TEST_FILE.test(path.posix.basename(file)) && !RUNNABLE_TEST.test(file));
}

function findTestFileViolations(file, content) {
  const violations = [];
  if (!NODE_TEST_IMPORT.test(content)) violations.push(`${file}: does not import from 'node:test'`);
  if (JEST_API.test(content)) violations.push(`${file}: uses the Jest API (jest.* or expect())`);
  return violations;
}

test('findMisplacedTestFiles flags test files outside scripts/tests/', () => {
  assert.deepEqual(
    findMisplacedTestFiles(['test/output_writer.test.mjs', 'scripts/lib/a.test.js', 'src/b.test.ts']),
    ['test/output_writer.test.mjs', 'scripts/lib/a.test.js', 'src/b.test.ts'],
  );
});

test('findMisplacedTestFiles flags test files under scripts/tests/ that npm test does not glob', () => {
  assert.deepEqual(
    findMisplacedTestFiles(['scripts/tests/foo.test.js', 'scripts/tests/sub/bar.test.mjs', 'scripts/tests/baz.test.ts']),
    ['scripts/tests/foo.test.js', 'scripts/tests/sub/bar.test.mjs', 'scripts/tests/baz.test.ts'],
  );
});

test('findMisplacedTestFiles accepts test files under scripts/tests/ and non-test files anywhere', () => {
  assert.deepEqual(findMisplacedTestFiles(['scripts/tests/x.test.mjs', 'test/helpers.mjs', 'README.md']), []);
});

test('findTestFileViolations flags a file without a node:test import', () => {
  assert.deepEqual(findTestFileViolations('t.test.mjs', "import assert from 'node:assert';"), [
    "t.test.mjs: does not import from 'node:test'",
  ]);
});

test('findTestFileViolations flags jest.mock and expect()', () => {
  const jestFile = "import { test } from 'node:test';\njest.mock('node:fs');\n";
  const expectFile = "import { test } from 'node:test';\nexpect(x).toBe(1);\n";
  assert.deepEqual(findTestFileViolations('a.test.mjs', jestFile), ['a.test.mjs: uses the Jest API (jest.* or expect())']);
  assert.deepEqual(findTestFileViolations('b.test.mjs', expectFile), ['b.test.mjs: uses the Jest API (jest.* or expect())']);
});

test('findTestFileViolations accepts node:test describe/it', () => {
  const content = "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\ndescribe('x', () => { it('y', () => assert.equal(1, 1)); });\n";
  assert.deepEqual(findTestFileViolations('ok.test.mjs', content), []);
});

test('repository: every tracked test file matches the npm test glob (scripts/tests/*.test.mjs)', (t) => {
  const files = listTrackedFiles();
  if (!files) return t.skip('not a git checkout');
  assert.deepEqual(findMisplacedTestFiles(files), [], 'npm test only runs scripts/tests/*.test.mjs; move or rename these files');
});

test('repository: every test file in scripts/tests/ uses node:test, not Jest', () => {
  const dir = path.join(REPO_ROOT, TEST_DIR);
  const violations = fs.readdirSync(dir)
    // This file quotes the Jest API in its own fixtures and messages.
    .filter((name) => TEST_FILE.test(name) && name !== SELF)
    .flatMap((name) => findTestFileViolations(`${TEST_DIR}${name}`, fs.readFileSync(path.join(dir, name), 'utf8')));
  assert.deepEqual(violations, []);
});
