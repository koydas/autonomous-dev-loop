import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIncludeFile, filterDiff } from '../lib/file_filters.mjs';

// shouldIncludeFile

test('shouldIncludeFile accepts normal source files', () => {
  assert.ok(shouldIncludeFile('src/index.js'));
  assert.ok(shouldIncludeFile('scripts/lib/config.mjs'));
  assert.ok(shouldIncludeFile('README.md'));
});

test('shouldIncludeFile rejects node_modules paths', () => {
  assert.equal(shouldIncludeFile('node_modules/lodash/index.js'), false);
  assert.equal(shouldIncludeFile('packages/foo/node_modules/bar/index.js'), false);
});

test('shouldIncludeFile rejects dist paths', () => {
  assert.equal(shouldIncludeFile('dist/bundle.js'), false);
  assert.equal(shouldIncludeFile('packages/app/dist/main.js'), false);
});

test('shouldIncludeFile rejects lock files', () => {
  assert.equal(shouldIncludeFile('package-lock.json'), false);
  assert.equal(shouldIncludeFile('yarn.lock'), false);
  assert.equal(shouldIncludeFile('pnpm-lock.yaml'), false);
  assert.equal(shouldIncludeFile('Cargo.lock'), false);
});

test('shouldIncludeFile rejects empty string', () => {
  assert.equal(shouldIncludeFile(''), false);
});

// filterDiff

const DIFF_SRC = `diff --git a/src/index.js b/src/index.js
--- a/src/index.js
+++ b/src/index.js
@@ -1 +1 @@
-old
+new`;

const DIFF_NODE_MODULES = `diff --git a/node_modules/foo/index.js b/node_modules/foo/index.js
--- a/node_modules/foo/index.js
+++ b/node_modules/foo/index.js
@@ -1 +1 @@
-a
+b`;

const DIFF_LOCK = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-{}
+{"x":1}`;

test('filterDiff keeps normal source files', () => {
  const result = filterDiff(DIFF_SRC);
  assert.ok(result.includes('src/index.js'));
});

test('filterDiff removes node_modules chunks', () => {
  const combined = DIFF_SRC + '\n' + DIFF_NODE_MODULES;
  const result = filterDiff(combined);
  assert.ok(result.includes('src/index.js'));
  assert.equal(result.includes('node_modules/foo'), false);
});

test('filterDiff removes lock file chunks', () => {
  const combined = DIFF_SRC + '\n' + DIFF_LOCK;
  const result = filterDiff(combined);
  assert.ok(result.includes('src/index.js'));
  assert.equal(result.includes('package-lock.json'), false);
});

test('filterDiff falls back to rawDiff when all chunks are filtered', () => {
  const result = filterDiff(DIFF_NODE_MODULES);
  assert.ok(result.includes('node_modules/foo'));
});

test('filterDiff truncates to maxChars', () => {
  const big = 'x'.repeat(5000);
  const result = filterDiff(big, 100);
  assert.equal(result.length, 100);
});
