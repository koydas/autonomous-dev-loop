import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractChangedFiles,
  extractAddedOrModifiedFiles,
  isAutomationScopeFile,
  buildAutomationGateContext,
} from '../lib/coverage_checker.mjs';

// ---------------------------------------------------------------------------
// extractChangedFiles
// ---------------------------------------------------------------------------

test('extractChangedFiles returns unique changed file paths from diff', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '+++ b/scripts/pr_review.mjs',
    '+++ b/scripts/pr_review.mjs',
    '+++ b/docs/code-generation.md',
  ].join('\n');
  assert.deepEqual(extractChangedFiles(diff), ['scripts/pr_review.mjs', 'docs/code-generation.md']);
});

test('extractChangedFiles includes deleted files from --- a/... lines', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    'deleted file mode 100644',
    '--- a/scripts/foo.mjs',
    '+++ /dev/null',
  ].join('\n');
  assert.deepEqual(extractChangedFiles(diff), ['scripts/foo.mjs']);
});

// ---------------------------------------------------------------------------
// extractAddedOrModifiedFiles
// ---------------------------------------------------------------------------

test('extractAddedOrModifiedFiles excludes purely deleted files', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    'deleted file mode 100644',
    '--- a/scripts/foo.mjs',
    '+++ /dev/null',
  ].join('\n');
  assert.deepEqual(extractAddedOrModifiedFiles(diff), []);
});

test('extractAddedOrModifiedFiles includes added and modified files', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    '+++ b/scripts/foo.mjs',
    'diff --git a/scripts/bar.mjs b/scripts/bar.mjs',
    '+++ b/scripts/bar.mjs',
  ].join('\n');
  assert.deepEqual(extractAddedOrModifiedFiles(diff), ['scripts/foo.mjs', 'scripts/bar.mjs']);
});

test('extractAddedOrModifiedFiles returns empty array for empty input', () => {
  assert.deepEqual(extractAddedOrModifiedFiles(''), []);
});

test('extractChangedFiles returns empty array for a diff with no file markers', () => {
  const diff = 'just some text\nno diff markers here\n';
  assert.deepEqual(extractChangedFiles(diff), []);
});

test('extractChangedFiles returns empty array for an empty string', () => {
  assert.deepEqual(extractChangedFiles(''), []);
});

test('extractChangedFiles deduplicates paths that appear multiple times', () => {
  const diff = [
    '+++ b/scripts/lib/config.mjs',
    '+++ b/scripts/lib/config.mjs',
  ].join('\n');
  const files = extractChangedFiles(diff);
  assert.equal(files.filter((f) => f === 'scripts/lib/config.mjs').length, 1);
});

// ---------------------------------------------------------------------------
// isAutomationScopeFile
// ---------------------------------------------------------------------------

test('isAutomationScopeFile matches automation paths', () => {
  assert.equal(isAutomationScopeFile('scripts/pr_review.mjs'), true);
  assert.equal(isAutomationScopeFile('.github/workflows/pr-review.yml'), true);
  assert.equal(isAutomationScopeFile('prompts/pr-review-system.md'), true);
  assert.equal(isAutomationScopeFile('docs/code-generation.md'), true);
});

test('isAutomationScopeFile returns false for non-automation paths', () => {
  assert.equal(isAutomationScopeFile('src/app.mjs'), false);
  assert.equal(isAutomationScopeFile('README.md'), false);
  assert.equal(isAutomationScopeFile('docs/other.md'), false);
});

// ---------------------------------------------------------------------------
// buildAutomationGateContext
// ---------------------------------------------------------------------------

test('returns empty string for a diff with no automation-scope files', () => {
  const diff = ['diff --git a/src/app.mjs b/src/app.mjs', '+++ b/src/app.mjs'].join('\n');
  assert.equal(buildAutomationGateContext(diff), '');
});

test('detects automation scope via a deleted automation file', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    'deleted file mode 100644',
    '--- a/scripts/foo.mjs',
    '+++ /dev/null',
  ].join('\n');
  assert.match(buildAutomationGateContext(diff), /automation_scope: true/);
});

test('includes all expected gate booleans when unit tests and docs are present', () => {
  const diff = [
    'diff --git a/scripts/pr_review.mjs b/scripts/pr_review.mjs',
    '+++ b/scripts/pr_review.mjs',
    'diff --git a/scripts/tests/pr_review.test.mjs b/scripts/tests/pr_review.test.mjs',
    '+++ b/scripts/tests/pr_review.test.mjs',
    'diff --git a/docs/code-generation.md b/docs/code-generation.md',
    '+++ b/docs/code-generation.md',
    '+minimum unit test coverage 80%',
  ].join('\n');
  const ctx = buildAutomationGateContext(diff);
  assert.match(ctx, /automation_scope: true/);
  assert.match(ctx, /unit_test_updates_present: true/);
  assert.match(ctx, /docs_updates_present: true/);
  assert.match(ctx, /coverage_signal_present: true/);
});

test('reports unit_test_updates_present: false when no test file is in the diff', () => {
  const diff = [
    'diff --git a/scripts/config.mjs b/scripts/config.mjs',
    '+++ b/scripts/config.mjs',
  ].join('\n');
  const ctx = buildAutomationGateContext(diff);
  assert.match(ctx, /unit_test_updates_present: false/);
});

test('extracts explicit minimum coverage percentage from diff (percent-first format)', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    '+++ b/scripts/foo.mjs',
    '+// minimum_coverage: 90%',
  ].join('\n');
  assert.match(buildAutomationGateContext(diff), /minimum_coverage_pct_stated: 90/);
});

test('extracts explicit minimum coverage percentage from diff (coverage: N% format)', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    '+++ b/scripts/foo.mjs',
    '+coverage: 85%',
  ].join('\n');
  assert.match(buildAutomationGateContext(diff), /minimum_coverage_pct_stated: 85/);
});

test('reports minimum_coverage_pct_stated: not stated when no percentage is in the diff', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    '+++ b/scripts/foo.mjs',
    '+some change without coverage mention',
  ].join('\n');
  assert.match(buildAutomationGateContext(diff), /minimum_coverage_pct_stated: not stated/);
});

test('handles a mix of automation and non-automation files (automation_scope is true)', () => {
  const diff = [
    'diff --git a/src/app.mjs b/src/app.mjs',
    '+++ b/src/app.mjs',
    'diff --git a/scripts/config.mjs b/scripts/config.mjs',
    '+++ b/scripts/config.mjs',
  ].join('\n');
  assert.match(buildAutomationGateContext(diff), /automation_scope: true/);
});
