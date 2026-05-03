import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractChangedFiles,
  isAutomationScopeFile,
  buildAutomationGateContext,
} from './coverage_checker.mjs';

test('extractChangedFiles returns unique changed file paths from diff', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '+++ b/scripts/pr_review.mjs',
    '+++ b/scripts/pr_review.mjs',
    '+++ b/docs/code-generation.md',
  ].join('\n');
  assert.deepEqual(extractChangedFiles(diff), ['scripts/pr_review.mjs', 'docs/code-generation.md']);
});

test('isAutomationScopeFile matches automation paths only', () => {
  assert.equal(isAutomationScopeFile('scripts/pr_review.mjs'), true);
  assert.equal(isAutomationScopeFile('.github/workflows/pr-review.yml'), true);
  assert.equal(isAutomationScopeFile('prompts/pr-review-system.md'), true);
  assert.equal(isAutomationScopeFile('docs/code-generation.md'), true);
  assert.equal(isAutomationScopeFile('src/app.mjs'), false);
});

test('buildAutomationGateContext returns empty string for non-automation diffs', () => {
  const diff = ['diff --git a/src/app.mjs b/src/app.mjs', '+++ b/src/app.mjs'].join('\n');
  assert.equal(buildAutomationGateContext(diff), '');
});

test('extractChangedFiles includes deleted automation files (--- a/... lines)', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    'deleted file mode 100644',
    '--- a/scripts/foo.mjs',
    '+++ /dev/null',
  ].join('\n');
  assert.deepEqual(extractChangedFiles(diff), ['scripts/foo.mjs']);
});

test('buildAutomationGateContext detects automation scope via deleted file', () => {
  const diff = [
    'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
    'deleted file mode 100644',
    '--- a/scripts/foo.mjs',
    '+++ /dev/null',
  ].join('\n');
  const ctx = buildAutomationGateContext(diff);
  assert.match(ctx, /automation_scope: true/);
});

test('buildAutomationGateContext includes expected gate booleans', () => {
  const diff = [
    'diff --git a/scripts/pr_review.mjs b/scripts/pr_review.mjs',
    '+++ b/scripts/pr_review.mjs',
    'diff --git a/scripts/tests/pr_review.test.mjs b/scripts/tests/pr_review.test.mjs',
    '+++ b/scripts/tests/pr_review.test.mjs',
    'diff --git a/docs/code-generation.md b/docs/code-generation.md',
    '+++ b/docs/code-generation.md',
    '+minimum unit test coverage 80%',
  ].join('\n');
  const context = buildAutomationGateContext(diff);
  assert.match(context, /automation_scope: true/);
  assert.match(context, /unit_test_updates_present: true/);
  assert.match(context, /docs_updates_present: true/);
  assert.match(context, /coverage_signal_present: true/);
});
