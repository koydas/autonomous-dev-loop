import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyChangedFiles,
  determineTestExpectation,
  buildChangeClassificationContext,
  isTestFile,
} from '../lib/change_classifier.mjs';

// ---------------------------------------------------------------------------
// classifyChangedFiles
// ---------------------------------------------------------------------------

test('classifyChangedFiles: pure documentation files', () => {
  const { categories, hasCode } = classifyChangedFiles([
    'docs/adr/0010-foo.md',
    'docs/runbook.md',
    'README.md',
  ]);
  assert.ok(categories.includes('documentation'));
  assert.equal(hasCode, false);
});

test('classifyChangedFiles: changelog and contributing are documentation', () => {
  const { categories, hasCode } = classifyChangedFiles(['CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE']);
  assert.ok(categories.includes('documentation'));
  assert.equal(hasCode, false);
});

test('classifyChangedFiles: CI/CD workflow files in automation scope set hasCode', () => {
  const { categories, hasCode } = classifyChangedFiles(['.github/workflows/pr-review.yml']);
  assert.ok(categories.includes('ci_cd'));
  assert.equal(hasCode, true);
});

test('classifyChangedFiles: configuration files', () => {
  const { categories, hasCode } = classifyChangedFiles(['config/labels.yaml', 'config/models.yaml']);
  assert.ok(categories.includes('configuration'));
  assert.equal(hasCode, false);
});

test('classifyChangedFiles: tsconfig is configuration', () => {
  const { categories, hasCode } = classifyChangedFiles(['tsconfig.json', 'tsconfig.build.json']);
  assert.ok(categories.includes('configuration'));
  assert.equal(hasCode, false);
});

test('classifyChangedFiles: lock files are dependency_update', () => {
  const { categories, hasCode } = classifyChangedFiles(['package-lock.json', 'yarn.lock']);
  assert.ok(categories.includes('dependency_update'));
  assert.equal(hasCode, false);
});

test('classifyChangedFiles: package.json alone is treated as executable code', () => {
  const { hasCode } = classifyChangedFiles(['package.json']);
  assert.equal(hasCode, true);
});

test('classifyChangedFiles: workflow files are ci_cd with hasCode true (automation scope)', () => {
  const { categories, hasCode } = classifyChangedFiles(['.github/workflows/pr-review.yml']);
  assert.ok(categories.includes('ci_cd'));
  assert.equal(hasCode, true);
});

test('classifyChangedFiles: test-only files', () => {
  const { categories, hasCode } = classifyChangedFiles(['scripts/tests/pr_review.test.mjs']);
  assert.ok(categories.includes('test_only'));
  assert.equal(hasCode, false);
});

test('classifyChangedFiles: executable scripts set hasCode and hasUncategorizedCode', () => {
  const { hasCode, hasUncategorizedCode } = classifyChangedFiles(['scripts/lib/change_classifier.mjs']);
  assert.equal(hasCode, true);
  assert.equal(hasUncategorizedCode, true);
});

test('classifyChangedFiles: workflow files set hasCode but not hasUncategorizedCode', () => {
  const { hasCode, hasUncategorizedCode } = classifyChangedFiles(['.github/workflows/pr-review.yml']);
  assert.equal(hasCode, true);
  assert.equal(hasUncategorizedCode, false);
});

test('classifyChangedFiles: automation-scope md files are treated as code', () => {
  // prompts/ is automation scope — not documentation
  const { categories, hasCode } = classifyChangedFiles(['prompts/pr-review-system.md']);
  assert.equal(hasCode, true);
  assert.ok(!categories.includes('documentation'));
});

test('classifyChangedFiles: docs/code-generation.md is automation scope, not documentation', () => {
  const { categories, hasCode } = classifyChangedFiles(['docs/code-generation.md']);
  assert.equal(hasCode, true);
  assert.ok(!categories.includes('documentation'));
});

test('classifyChangedFiles: mixed PR includes both code and docs categories', () => {
  const { categories, hasCode } = classifyChangedFiles([
    'scripts/lib/pr_review.mjs',
    'docs/adr/0010-foo.md',
  ]);
  assert.equal(hasCode, true);
  assert.ok(categories.includes('documentation'));
});

test('classifyChangedFiles: empty file list', () => {
  const { categories, hasCode } = classifyChangedFiles([]);
  assert.deepEqual(categories, []);
  assert.equal(hasCode, false);
});

// ---------------------------------------------------------------------------
// determineTestExpectation
// ---------------------------------------------------------------------------

test('determineTestExpectation: hasCode → tests_expected true', () => {
  const { tests_expected } = determineTestExpectation(['documentation'], true);
  assert.equal(tests_expected, true);
});

test('determineTestExpectation: documentation-only → tests_expected false', () => {
  const { tests_expected, reason } = determineTestExpectation(['documentation'], false);
  assert.equal(tests_expected, false);
  assert.match(reason, /No executable behavior changed/);
});

test('determineTestExpectation: ci_cd-only → tests_expected false', () => {
  const { tests_expected } = determineTestExpectation(['ci_cd'], false);
  assert.equal(tests_expected, false);
});

test('determineTestExpectation: configuration-only → tests_expected false', () => {
  const { tests_expected } = determineTestExpectation(['configuration'], false);
  assert.equal(tests_expected, false);
});

test('determineTestExpectation: dependency_update-only → tests_expected false', () => {
  const { tests_expected, reason } = determineTestExpectation(['dependency_update'], false);
  assert.equal(tests_expected, false);
  assert.match(reason, /Dependency version update/);
});

test('determineTestExpectation: test_only → tests_expected false', () => {
  const { tests_expected, reason } = determineTestExpectation(['test_only'], false);
  assert.equal(tests_expected, false);
  assert.match(reason, /only test file changes/);
});

test('determineTestExpectation: mixed non-behavioral (docs + ci_cd) → tests_expected false', () => {
  const { tests_expected } = determineTestExpectation(['documentation', 'ci_cd'], false);
  assert.equal(tests_expected, false);
});

test('determineTestExpectation: empty categories → tests_expected true (undetermined)', () => {
  const { tests_expected } = determineTestExpectation([], false);
  assert.equal(tests_expected, true);
});

// ---------------------------------------------------------------------------
// buildChangeClassificationContext
// ---------------------------------------------------------------------------

test('buildChangeClassificationContext: returns empty string for empty diff', () => {
  assert.equal(buildChangeClassificationContext(''), '');
});

test('buildChangeClassificationContext: returns empty string when diff has no file markers', () => {
  assert.equal(buildChangeClassificationContext('just text, no diff markers'), '');
});

test('buildChangeClassificationContext: doc-only diff produces tests_expected: false', () => {
  const diff = [
    'diff --git a/docs/adr/0010-foo.md b/docs/adr/0010-foo.md',
    '+++ b/docs/adr/0010-foo.md',
    '+Some ADR content',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /tests_expected: false/);
  assert.match(ctx, /change_type: documentation/);
  assert.match(ctx, /do not generate findings about missing tests/);
});

test('buildChangeClassificationContext: code change produces tests_expected: true', () => {
  const diff = [
    'diff --git a/scripts/lib/foo.mjs b/scripts/lib/foo.mjs',
    '+++ b/scripts/lib/foo.mjs',
    '+export function foo() {}',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /tests_expected: true/);
  assert.match(ctx, /has_executable_code_changes: true/);
});

test('buildChangeClassificationContext: workflow-only diff produces tests_expected: true (automation scope)', () => {
  const diff = [
    'diff --git a/.github/workflows/pr-review.yml b/.github/workflows/pr-review.yml',
    '+++ b/.github/workflows/pr-review.yml',
    '+    - uses: actions/checkout@v4',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /tests_expected: true/);
  assert.match(ctx, /detected_categories: ci_cd/);
  assert.match(ctx, /change_type: ci_cd/);
});

test('buildChangeClassificationContext: mixed PR (code + docs) produces tests_expected: true', () => {
  const diff = [
    'diff --git a/scripts/lib/foo.mjs b/scripts/lib/foo.mjs',
    '+++ b/scripts/lib/foo.mjs',
    '+export function foo() {}',
    'diff --git a/docs/runbook.md b/docs/runbook.md',
    '+++ b/docs/runbook.md',
    '+Some runbook update',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /tests_expected: true/);
  assert.match(ctx, /change_type: mixed/);
});

test('buildChangeClassificationContext: lock-file-only diff produces tests_expected: false', () => {
  const diff = [
    'diff --git a/package-lock.json b/package-lock.json',
    '+++ b/package-lock.json',
    '+  "some-dep": "^2.0.0"',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /tests_expected: false/);
  assert.match(ctx, /dependency_update/);
});

test('buildChangeClassificationContext: package.json alone produces tests_expected: true', () => {
  const diff = [
    'diff --git a/package.json b/package.json',
    '+++ b/package.json',
    '+  "type": "commonjs"',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /tests_expected: true/);
  assert.match(ctx, /has_executable_code_changes: true/);
});

test('buildChangeClassificationContext: prompts md file is treated as code', () => {
  const diff = [
    'diff --git a/prompts/pr-review-system.md b/prompts/pr-review-system.md',
    '+++ b/prompts/pr-review-system.md',
    '+New rule added',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /tests_expected: true/);
  assert.match(ctx, /has_executable_code_changes: true/);
});

test('buildChangeClassificationContext: includes detected_categories in output', () => {
  const diff = [
    'diff --git a/config/labels.yaml b/config/labels.yaml',
    '+++ b/config/labels.yaml',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /detected_categories: configuration/);
});

test('isTestFile: recognizes common test path/extension patterns', () => {
  assert.ok(isTestFile('scripts/tests/foo.test.mjs'));
  assert.ok(isTestFile('src/__tests__/bar.js'));
  assert.ok(isTestFile('src/foo.spec.ts'));
  assert.ok(!isTestFile('scripts/lib/foo.mjs'));
});

test('isTestFile: recognizes root-level test/ and tests/ directories (no leading slash)', () => {
  assert.ok(isTestFile('test/foo.js'));
  assert.ok(isTestFile('tests/foo.js'));
  assert.ok(isTestFile('__tests__/foo.js'));
});

test('buildChangeClassificationContext: has_test_file_changes is true when any changed file is a test file', () => {
  const diff = [
    'diff --git a/src/foo.mjs b/src/foo.mjs',
    '+++ b/src/foo.mjs',
    'diff --git a/scripts/tests/foo.test.mjs b/scripts/tests/foo.test.mjs',
    '+++ b/scripts/tests/foo.test.mjs',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /has_test_file_changes: true/);
});

test('buildChangeClassificationContext: has_test_file_changes is false when no changed file is a test file', () => {
  const diff = ['diff --git a/src/foo.mjs b/src/foo.mjs', '+++ b/src/foo.mjs'].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /has_test_file_changes: false/);
});

test('buildChangeClassificationContext: has_test_file_changes is false when a test file is only DELETED, not added/modified', () => {
  const diff = [
    'diff --git a/src/foo.mjs b/src/foo.mjs',
    '+++ b/src/foo.mjs',
    'diff --git a/scripts/tests/foo.test.mjs b/scripts/tests/foo.test.mjs',
    'deleted file mode 100644',
    '--- a/scripts/tests/foo.test.mjs',
    '+++ /dev/null',
  ].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /has_test_file_changes: false/);
});

test('buildChangeClassificationContext: has_test_file_changes reflects the full diff even for files beyond a hypothetical truncation point', () => {
  // Simulates the real bug this fixes: extractChangedFiles/isTestFile run on the FULL rawDiff,
  // not the separately-truncated text shown to the model, so a test file far into a huge diff
  // still correctly flips this flag to true.
  const filler = 'diff --git a/src/filler.mjs b/src/filler.mjs\n+++ b/src/filler.mjs\n' + '+x\n'.repeat(5000);
  const diff = filler + 'diff --git a/scripts/tests/late.test.mjs b/scripts/tests/late.test.mjs\n+++ b/scripts/tests/late.test.mjs';
  assert.ok(diff.length > 12000);
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /has_test_file_changes: true/);
});

test('buildChangeClassificationContext: diff_truncated defaults to false when not passed', () => {
  const diff = ['diff --git a/src/foo.mjs b/src/foo.mjs', '+++ b/src/foo.mjs'].join('\n');
  const ctx = buildChangeClassificationContext(diff);
  assert.match(ctx, /diff_truncated: false/);
});

test('buildChangeClassificationContext: diff_truncated reflects the passed flag', () => {
  const diff = ['diff --git a/src/foo.mjs b/src/foo.mjs', '+++ b/src/foo.mjs'].join('\n');
  const ctx = buildChangeClassificationContext(diff, true);
  assert.match(ctx, /diff_truncated: true/);
});
